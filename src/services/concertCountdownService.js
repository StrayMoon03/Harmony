"use strict";
const store = require("../stores/concertCountdownStore");
const events = require("../stores/eventSchedulerStore");
const { buildCountdown, localDate, nextMidnight } = require("./concertCountdownModel");
const images = require("./concertCountdownRender");
const { createHash, randomBytes } = require("node:crypto");
const access = require("./concertCountdownPermissions");
const locks = new Set();
const HEALTH_MS = 6 * 60 * 60 * 1000;
const REQUIRED = access.REQUIRED.map((p) => p.flag);
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
function fingerprint(m, row, renderVersion = images.RENDER_VERSION) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        renderVersion,
        city: m.city,
        venue: m.venue,
        panels: m.panels,
      }),
    )
    .update(row.photo || Buffer.alloc(0))
    .digest("hex");
}
async function payload(row, m) {
  return {
    content: "",
    embeds: [],
    components: [],
    files: [
      {
        attachment: await images.render(
          m,
          row.photo ? { type: row.photo_type, bytes: row.photo } : null,
        ),
        name: attachmentName(row.guild_id, row.channel_id),
        description: text(m).slice(0, 1024),
      },
    ],
    allowedMentions: { parse: [] },
  };
}
async function preview(row) {
  return payload(row, model(row));
}
// Stable room-scoped metadata survives edits, lost send responses and restarts.
// It is an attachment filename, never a visible message footer or hidden text.
function attachmentName(guildId, channelId) {
  const identity = createHash("sha256")
    .update(JSON.stringify([guildId, channelId]))
    .digest("hex");
  return "harmony-countdown-" + identity + ".png";
}
function managed(message, client, marker, filename) {
  return (
    message.author?.id === client.user.id &&
    ((filename && message.attachments?.some((a) => a.name === filename)) ||
      message.content?.endsWith(marker) ||
      message.content?.endsWith(marker + " [" + message.channelId + "]"))
  );
}
async function findPinned(channel, client, marker, filename) {
  let before;
  for (let page = 0; page < 100; page++) {
    const pins = await channel.messages.fetchPins({
      limit: 50,
      ...(before ? { before } : {}),
    });
    const match = pins.items.find((p) =>
      managed(p.message, client, marker, filename),
    );
    if (match) return match.message;
    if (!pins.hasMore) return null;
    const next = pins.items.at(-1)?.pinnedAt;
    if (!next || String(next) === String(before))
      throw Error("Could not safely inspect pinned messages");
    before = next;
  }
  throw Error("Too many pinned messages to recover safely");
}
async function recoverDelivery(channel, client, marker, delivery, filename) {
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
      if (managed(message, client, marker, filename)) return message;
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
  {
    publish = false,
    force = false,
    scheduled = false,
    renderUpgrade = false,
    expectedRevision,
    now = new Date(),
  } = {},
) {
  const key = g + ":" + c;
  if (locks.has(key)) throw Error("Countdown update already running");
  locks.add(key);
  let lease,
    heartbeat,
    lostLease = false;
  let stage = "prepare the countdown";
  try {
    let row = store.get(g, c);
    if (!row) throw Error("Configure this room first");
    if (
      renderUpgrade &&
      ((!row.message_id && !row.published_at) ||
        row.render_version === images.RENDER_VERSION)
    )
      return { skipped: true };
    if (scheduled && !row.enabled && !renderUpgrade) return { skipped: true };
    if (!row.published_at && !row.message_id && !row.delivery && !publish)
      throw Error("Initial publication requires approval");
    if (
      row.retry_at &&
      Date.parse(row.retry_at) > now.getTime() &&
      !(force && !scheduled && !renderUpgrade && access.canRetryManually(row))
    )
      return { deferred: true, retryAt: row.retry_at };
    const m = model(row, now),
      hash = fingerprint(m, row);
    if (
      !force &&
      row.fingerprint === hash &&
      row.render_version === images.RENDER_VERSION &&
      row.message_id &&
      !row.delivery &&
      !row.last_error &&
      (!scheduled || (row.last_success && localDate(new Date(row.last_success), JSON.parse(row.config).timezone) === m.today)) &&
      now.getTime() - Date.parse(row.checked_at || 0) < HEALTH_MS
    )
      return { skipped: true };
    lease = store.acquire(g, c);
    if (!lease)
      throw Error(
        "Countdown update already running or recovering after restart; retry shortly",
      );
    const current = store.get(g, c);
    if (expectedRevision !== undefined && current.revision !== expectedRevision)
      throw Object.assign(
        Error(
          "Configuration changed. Preview it and approve publication again.",
        ),
        { code: "COUNTDOWN_CONFIGURATION_CHANGED" },
      );
    if (current.revision !== row.revision)
      throw Error(
        "Configuration changed during this update. Retry using the saved settings.",
      );
    heartbeat = setInterval(() => {
      try {
        if (!store.renew(g, c, lease)) lostLease = true;
      } catch {
        lostLease = true;
      }
    }, 30000);
    heartbeat.unref?.();
    const { channel } = access.assertAllowed(
      await access.inspect(client, g, c),
    );
    const marker = "Youtiful STAY • World Tour Countdown";
    const filename = attachmentName(g, c);
    let message;
    if (row.message_id) {
      try {
        stage = "read the saved countdown";
        message = await channel.messages.fetch({
          message: row.message_id,
          force: true,
        });
      } catch (e) {
        if (Number(e.code) !== 10008) throw e;
      }
    }
    stage = "read pinned countdown messages";
    if (!message) message = await findPinned(channel, client, marker, filename);
    if (!message && row.delivery) {
      stage = "recover a previous countdown delivery";
      message = await recoverDelivery(
        channel,
        client,
        marker,
        JSON.parse(row.delivery),
        filename,
      );
    }
    if (!message && row.legacy_recovery) {
      stage = "recover a previous countdown delivery";
      message = await recoverDelivery(
        channel,
        client,
        marker,
        { after: "0" },
        filename,
      );
    }
    if (message && !managed(message, client, marker, filename))
      throw Error("Managed message ownership mismatch");
    const needsImage =
      force ||
      row.fingerprint !== hash ||
      !message ||
      row.render_version !== images.RENDER_VERSION;
    stage = "render the countdown image";
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
      if (outgoing) {
        stage = "edit the countdown image";
        await message.edit({
          ...outgoing,
          attachments: [],
        });
      }
    } else {
      if (!row.delivery) {
        stage = "read the concert-room history";
        const latest = await channel.messages.fetch({ limit: 1, cache: false });
        const delivery = {
          after: latest.first()?.id || "0",
          nonce: randomBytes(12).toString("hex"),
        };
        store.update(g, c, { delivery: JSON.stringify(delivery) });
        row = store.get(g, c);
      }
      const delivery = JSON.parse(row.delivery);
      stage = "send the countdown image";
      message = await channel.send({
        ...outgoing,
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
    stage = "pin the countdown";
    if (!message.pinned) await message.pin("Youtiful STAY concert countdown");
    stage = "save the rendering checkpoint";
    store.update(g, c, {
      fingerprint: hash,
      render_version: images.RENDER_VERSION,
      last_success: now.toISOString(),
      last_error: null,
      retry_at: null,
      retry_kind: null,
      checked_at: now.toISOString(),
    });
    return { updated: needsImage, messageId: message.id };
  } catch (original) {
    const saved = store.get(g, c);
    const e = lease
      ? await access.operationError(original, {
          client,
          guildId: g,
          channelId: c,
          stage,
          messageSaved: Boolean(saved?.message_id),
        })
      : original;
    if (saved && lease) {
      const wait = Math.max(
        60,
        Number(e.retry_after) || Number(e.retryAfter) / 1000 || 300,
      );
      store.update(g, c, {
        last_error: String(e.message).slice(0, 300),
        retry_kind: access.retryKind(e),
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
// Only metadata is scanned; photographs and Discord are loaded for due work.
function nextUpdate(row, now = new Date()) {
  const published = Boolean(row.message_id || row.published_at);
  const upgrade = published && row.render_version !== images.RENDER_VERSION;
  if ((!published && !row.delivery) || (!row.enabled && !upgrade)) return null;
  let due;
  if (row.retry_at && Date.parse(row.retry_at) > now.getTime()) due = new Date(row.retry_at);
  else if (upgrade || row.delivery || row.last_error || !row.fingerprint || !row.last_success) due = now;
  else {
    const { timezone } = JSON.parse(row.config);
    due = localDate(new Date(row.last_success), timezone) !== localDate(now, timezone)
      ? now : nextMidnight(now, timezone);
  }
  // A crashed worker's durable lease must expire before recovery can run.
  return row.lease_until >= due.getTime() ? new Date(row.lease_until + 1) : due;
}
async function runUpdates(client, { now = new Date() } = {}) {
  const result = { updated: 0, skipped: 0, deferred: 0, failed: 0 };
  for (const row of store.renderingWork(images.RENDER_VERSION)) {
    const upgrade =
      Boolean(row.message_id || row.published_at) &&
      row.render_version !== images.RENDER_VERSION;
    try {
      const due = nextUpdate(row, now);
      if (!due || due > now) {
        result.deferred++;
        continue;
      }
      const status = await refresh(client, row.guild_id, row.channel_id, {
        scheduled: true,
        renderUpgrade: upgrade,
        now,
      });
      if (status.deferred) result.deferred++;
      else if (status.skipped) result.skipped++;
      else result.updated++;
    } catch (error) {
      result.failed++;
      // Model/metadata errors can happen before refresh acquires its lease.
      // Persist their retry too, avoiding an immediate timer loop on bad data.
      const saved = store.get(row.guild_id, row.channel_id);
      if (saved && !(saved.lease_until > Date.now()) && !(Date.parse(saved.retry_at) > now.getTime())) {
        store.update(row.guild_id, row.channel_id, {
          last_error: String(error.message).slice(0, 300),
          retry_at: new Date(now.getTime() + 300000).toISOString(),
          retry_kind: "scheduler",
        });
      }
      console.error(
        "Concert countdown update failed",
        row.channel_id,
        error.message,
      );
    }
  }
  return result;
}
function start(client, { clock = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let busy = false, stopped = false, timer;
  const arm = () => {
    if (busy || stopped) return;
    clearTimer(timer);
    timer = undefined;
    const now = clock();
    let earliest;
    try {
      for (const row of store.renderingWork(images.RENDER_VERSION)) {
        let due;
        try { due = nextUpdate(row, now); }
        catch { due = row.retry_at && Date.parse(row.retry_at) > now.getTime() ? new Date(row.retry_at) : now; }
        if (due && (!earliest || due < earliest)) earliest = due;
      }
    } catch (error) {
      console.error("Concert countdown scheduler failed", error.message);
      earliest = new Date(now.getTime() + 300000);
    }
    if (earliest) {
      timer = setTimer(run, Math.max(1, earliest.getTime() - now.getTime()));
      timer.unref?.();
    }
  };
  const run = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await runUpdates(client, { now: clock() });
    } catch (error) {
      console.error("Concert countdown scheduler failed", error.message);
    } finally {
      busy = false;
      arm();
    }
  };
  const unsubscribe = store.subscribe(arm);
  void run(); // Catch up missed local dates and pending renderer upgrades at startup.
  return () => { stopped = true; unsubscribe(); clearTimer(timer); };
}
module.exports = {
  model,
  text,
  preview,
  refresh,
  start,
  runUpdates,
  nextUpdate,
  fingerprint,
  REQUIRED,
  findPinned,
  recoverDelivery,
};
