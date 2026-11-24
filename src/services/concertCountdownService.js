"use strict";
const store = require("../stores/concertCountdownStore");
const events = require("../stores/eventSchedulerStore");
const { buildCountdown } = require("./concertCountdownModel");
const images = require("./concertCountdownRender");
const { createHash, randomBytes } = require("node:crypto");
const { ChannelType, PermissionFlagsBits: P } = require("discord.js");
const locks = new Set();
const HEALTH_MS = 6 * 60 * 60 * 1000;
const REQUIRED = [
  P.ViewChannel,
  P.ReadMessageHistory,
  P.SendMessages,
  P.AttachFiles,
  P.PinMessages,
];
function model(row, now) {
  const config = JSON.parse(row.config);
  return buildCountdown(
    config,
    config.eventIds
      .map((id) => events.getEvent(row.guild_id, id))
      .filter(Boolean),
    now,
  );
}
function text(m) {
  return [
    m.city + " — " + m.venue,
    ...m.panels.map(
      (p) =>
        p.date +
        ": " +
        (p.state === "upcoming" ? p.days + " days to go" : p.label),
    ),
    ...(m.panels.length
      ? []
      : ["No active concert dates — check the approved calendar."]),
  ].join("\n");
}
function fingerprint(m, row) {
  return createHash("sha256")
    .update(JSON.stringify({ city: m.city, venue: m.venue, panels: m.panels }))
    .update(row.photo || Buffer.alloc(0))
    .digest("hex");
}
async function payload(row, m) {
  return {
    content: text(m),
    files: [
      {
        attachment: await images.render(
          m,
          row.photo ? { type: row.photo_type, bytes: row.photo } : null,
        ),
        name: "countdown.png",
        description: text(m).slice(0, 1024),
      },
    ],
    allowedMentions: { parse: [] },
  };
}
async function preview(row) {
  return payload(row, model(row));
}
function managed(message, client, marker) {
  return (
    message.author?.id === client.user.id &&
    (message.content?.endsWith(marker) ||
      message.content?.endsWith(marker + " [" + message.channelId + "]"))
  );
}
async function findPinned(channel, client, marker) {
  let before;
  for (let page = 0; page < 100; page++) {
    const pins = await channel.messages.fetchPins({
      limit: 50,
      ...(before ? { before } : {}),
    });
    const match = pins.items.find((p) => managed(p.message, client, marker));
    if (match) return match.message;
    if (!pins.hasMore) return null;
    const next = pins.items.at(-1)?.pinnedAt;
    if (!next || String(next) === String(before))
      throw Error("Could not safely inspect pinned messages");
    before = next;
  }
  throw Error("Too many pinned messages to recover safely");
}
async function recoverDelivery(channel, client, marker, delivery) {
  // Walk the complete interval, not merely the last 100 messages. A bounded failure never sends.
  let before;
  for (let page = 0; page < 100; page++) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
      cache: false,
    });
    const messages = [...batch.values()];
    for (const message of messages)
      if (managed(message, client, marker)) return message;
    if (
      messages.length < 100 ||
      messages.some((m) => BigInt(m.id) <= BigInt(delivery.after))
    )
      return null;
    const next = messages.at(-1)?.id;
    if (!next || next === before)
      throw Error("Could not safely recover the countdown message");
    before = next;
  }
  throw Error(
    "Recovery history exceeds 10,000 messages. Retry with administrator assistance; no duplicate was sent.",
  );
}
async function refresh(
  client,
  g,
  c,
  { publish = false, force = false, scheduled = false, now = new Date() } = {},
) {
  const key = g + ":" + c;
  if (locks.has(key)) throw Error("Countdown update already running");
  locks.add(key);
  let lease,
    heartbeat,
    lostLease = false;
  try {
    let row = store.get(g, c);
    if (!row) throw Error("Configure this room first");
    if (scheduled && !row.enabled) return { skipped: true };
    if (!row.published_at && !row.message_id && !row.delivery && !publish)
      throw Error("Initial publication requires approval");
    if (row.retry_at && Date.parse(row.retry_at) > now.getTime())
      return { deferred: true };
    const m = model(row, now),
      hash = fingerprint(m, row);
    if (
      !force &&
      row.fingerprint === hash &&
      row.message_id &&
      !row.delivery &&
      now.getTime() - Date.parse(row.checked_at || 0) < HEALTH_MS
    )
      return { skipped: true };
    lease = store.acquire(g, c);
    if (!lease)
      throw Error(
        "Countdown update already running or recovering after restart; retry shortly",
      );
    heartbeat = setInterval(() => {
      try {
        if (!store.renew(g, c, lease)) lostLease = true;
      } catch {
        lostLease = true;
      }
    }, 30000);
    heartbeat.unref?.();
    const channel = await client.channels.fetch(c);
    if (channel?.guildId !== g || channel.type !== ChannelType.GuildText)
      throw Error("Choose an existing text room in this server");
    const permissions = channel.permissionsFor(client.user);
    if (!permissions?.has(REQUIRED))
      throw Error(
        "Harmony needs View Channel, Read Message History, Send Messages, Attach Files and Pin Messages in this room",
      );
    const marker = "Youtiful STAY • World Tour Countdown";
    let message;
    if (row.message_id) {
      try {
        message = await channel.messages.fetch({
          message: row.message_id,
          force: true,
        });
      } catch (e) {
        if (Number(e.code) !== 10008) throw e;
      }
    }
    if (!message) message = await findPinned(channel, client, marker);
    if (!message && row.delivery)
      message = await recoverDelivery(
        channel,
        client,
        marker,
        JSON.parse(row.delivery),
      );
    if (!message && row.legacy_recovery)
      message = await recoverDelivery(channel, client, marker, { after: "0" });
    if (message && !managed(message, client, marker))
      throw Error("Managed message ownership mismatch");
    const needsImage = force || row.fingerprint !== hash || !message;
    const outgoing = needsImage ? await payload(row, m) : null;
    if (lostLease)
      throw Error("Countdown update lock was lost; retry recovery shortly");
    if (message) {
      // Persist recovery before editing/pinning, including a recovered send from a crashed process.
      store.update(g, c, {
        message_id: message.id,
        published_at: row.published_at || now.toISOString(),
        delivery: null,
        legacy_recovery: 0,
      });
      if (outgoing)
        await message.edit({
          ...outgoing,
          content: outgoing.content + "\n" + marker,
          attachments: [],
        });
    } else {
      if (!row.delivery) {
        const latest = await channel.messages.fetch({ limit: 1, cache: false });
        const delivery = {
          after: latest.first()?.id || "0",
          nonce: randomBytes(12).toString("hex"),
        };
        store.update(g, c, { delivery: JSON.stringify(delivery) });
        row = store.get(g, c);
      }
      const delivery = JSON.parse(row.delivery);
      message = await channel.send({
        ...outgoing,
        content: outgoing.content + "\n" + marker,
        nonce: delivery.nonce,
        enforceNonce: true,
      });
      store.update(g, c, {
        message_id: message.id,
        published_at: row.published_at || now.toISOString(),
        delivery: null,
        legacy_recovery: 0,
      });
    }
    if (!message.pinned) await message.pin("Youtiful STAY concert countdown");
    store.update(g, c, {
      fingerprint: hash,
      last_success: now.toISOString(),
      last_error: null,
      retry_at: null,
      checked_at: now.toISOString(),
    });
    return { updated: needsImage, messageId: message.id };
  } catch (e) {
    if (store.get(g, c) && lease) {
      const wait = Math.max(
        60,
        Number(e.retry_after) || Number(e.retryAfter) / 1000 || 300,
      );
      store.update(g, c, {
        last_error: String(e.message).slice(0, 300),
        retry_at: new Date(
          now.getTime() + Math.min(wait, 86400) * 1000,
        ).toISOString(),
      });
    }
    throw e;
  } finally {
    clearInterval(heartbeat);
    if (lease) store.release(g, c, lease);
    locks.delete(key);
  }
}
function start(client) {
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      for (const row of store.enabled()) {
        try {
          await refresh(client, row.guild_id, row.channel_id, {
            scheduled: true,
          });
        } catch (e) {
          console.error(
            "Concert countdown update failed",
            row.channel_id,
            e.message,
          );
        }
      }
    } finally {
      busy = false;
    }
  }
  const run = () =>
    tick().catch((e) =>
      console.error("Concert countdown scheduler failed", e.message),
    );
  run();
  const timer = setInterval(run, 60000);
  timer.unref?.();
  return () => clearInterval(timer);
}
module.exports = {
  model,
  text,
  preview,
  refresh,
  start,
  fingerprint,
  REQUIRED,
  findPinned,
  recoverDelivery,
};
