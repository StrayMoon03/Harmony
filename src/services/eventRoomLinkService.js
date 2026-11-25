"use strict";
const { ActionRowBuilder: Row, ButtonBuilder: Button, ButtonStyle, ChannelType, PermissionFlagsBits: P } = require("discord.js");
const store = require("../stores/eventRoomLinkStore");
const events = require("../stores/eventSchedulerStore");
const running = new Set();
const roomTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice];
function calendar() { return require("./eventSchedulerService"); }
function timing(event, clock = "09:00") {
  const timezone = calendar().calendarPresentationTimezone(event);
  const day = !event.all_day && event.event_at ? calendar().calendarDateInTimezone(event.event_at, timezone) : event.event_date;
  const due = calendar().localToUtc(day || "", clock, timezone);
  if (!due) throw Error("Choose a valid time on the event day in its time zone.");
  return { timezone, day, due };
}
function validDay(event, now) {
  const t = timing(event);
  return calendar().calendarDateInTimezone(now, t.timezone) <= t.day && (!event.event_end_at || Date.parse(event.event_end_at) > now.getTime());
}
async function resolveRoom(client, event, override = null) {
  const guild = await client.guilds.fetch(event.guild_id);
  let id = override || event.event_channel_id;
  if (!id && event.discord_event_id) {
    const native = await guild.scheduledEvents.fetch(event.discord_event_id);
    id = native?.channelId;
    if (!id) {
      const link = String(native?.entityMetadata?.location || "").match(/^https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/?$/);
      if (link?.[1] === event.guild_id) id = link[2];
    }
  }
  if (!id) throw Error("Choose the event room first. The announcement channel is not used as a substitute.");
  const room = await guild.channels.fetch(id, { force: true });
  if (room?.guildId !== event.guild_id || !roomTypes.includes(room.type)) throw Error("Choose a text, announcement, voice or stage room in this server.");
  return { guild, room };
}
function link(g, c) { return `https://discord.com/channels/${g}/${c}`; }
function payload(event, room, delivery) {
  if (!Number.isSafeInteger(delivery.id) || delivery.id < 1 || delivery.id > 0xffffffff) throw Error("Delivery identifier exceeds Discord component limits.");
  const when = event.all_day || !event.event_at ? `Date: ${timing(event).day}` : `Starts: <t:${Math.floor(Date.parse(event.event_at) / 1000)}:F>`;
  return {
    content: `🧡🖤 **${event.title.slice(0, 180)}**\n${when}\nTap the button below to open the right Discord room.`,
    components: [new Row().addComponents(new Button().setLabel("Open the Event Room").setStyle(ButtonStyle.Link).setURL(link(event.guild_id, room.id)).setId(delivery.id))],
    allowedMentions: { parse: [] }, nonce: delivery.nonce, enforceNonce: true,
  };
}
function matches(message, client, job) {
  return message.author?.id === client.user.id && message.components?.some(row => row.components?.some(c => Number(c.id ?? c.data?.id) === job.id && (c.url ?? c.data?.url) === link(job.guild_id, job.room_id)));
}
async function recover(dm, client, job) {
  let before;
  for (let page = 0; page < 100; page++) {
    const batch = await dm.messages.fetch({ limit: 100, ...(before ? { before } : {}), cache: false });
    const messages = [...batch.values()];
    const found = messages.find(m => matches(m, client, job));
    if (found) return found;
    if (messages.length < 100 || messages.some(m => BigInt(m.id) <= BigInt(job.after_id))) return null;
    const next = messages.at(-1)?.id;
    if (!next || next === before) break;
    before = next;
  }
  throw Object.assign(Error("Could not safely finish delivery recovery. No duplicate was sent; retry after checking DM history access."), { unsafeRecovery: true });
}
function reconcile(now = new Date()) {
  for (const member of store.scheduledMembers()) {
    const event = events.getEvent(member.guild_id, member.event_id);
    if (!event) {
      for (const d of store.deliveries(member.guild_id, member.event_id).filter(d => d.user_id === member.user_id && d.kind === "scheduled")) store.reconcile(d.id, d.due_at, false);
      continue;
    }
    try {
      const { due } = timing(event, store.settings(member.guild_id, member.event_id)?.local_time || "09:00");
      const ids = store.enqueue(member.guild_id, member.event_id, [member.user_id], `scheduled:${member.guild_id}:${member.event_id}`, "scheduled", due.toISOString(), now);
      for (const id of ids) store.reconcile(id, due.toISOString(), validDay(event, now));
    } catch {
      for (const d of store.deliveries(member.guild_id, member.event_id).filter(d => d.user_id === member.user_id && d.kind === "scheduled")) store.reconcile(d.id, d.due_at, false);
    }
  }
}
async function deliver(client, id, { now = new Date() } = {}) {
  if (running.has(id)) return { skipped: true };
  running.add(id);
  let token, heartbeat, lost = false;
  const started = Date.now(), leaseNow = () => new Date(now.getTime() + Date.now() - started);
  try {
    token = store.claim(id, now);
    if (!token) return { skipped: true };
    heartbeat = setInterval(() => { try { if (!store.renew(id, token, leaseNow())) lost = true; } catch { lost = true; } }, 30000);
    heartbeat.unref?.();
    let job = store.get(id);
    // Recover an unknown send before considering reschedules, removals or another send.
    const user = await client.users.fetch(job.user_id);
    const dm = await user.createDM();
    if (job.dm_channel_id) {
      if (dm.id !== job.dm_channel_id) throw Object.assign(Error("Saved DM channel could not be recovered safely."), { unsafeRecovery: true });
      const found = await recover(dm, client, job);
      if (found) { store.update(id, token, { status: "sent", message_id: found.id, sent_at: now.toISOString(), last_error: null, retry_at: null }); return { sent: true, recovered: true }; }
    }
    const event = events.getEvent(job.guild_id, job.event_id);
    const recipient = store.members(job.guild_id, job.event_id).find(m => m.user_id === job.user_id);
    if (!event || !recipient || (job.kind === "scheduled" && !recipient.scheduled) || !validDay(event, now)) {
      store.update(id, token, { status: "cancelled", last_error: "Event is cancelled/finished or this member's message was removed." });
      return { cancelled: true };
    }
    if (job.kind === "scheduled") {
      const { due } = timing(event, store.settings(job.guild_id, job.event_id)?.local_time || "09:00");
      if (due > now) { store.update(id, token, { status: "pending", due_at: due.toISOString(), retry_at: null }); return { deferred: true }; }
    }
    const settingsSnapshot = JSON.stringify(store.settings(job.guild_id, job.event_id) || null);
    const { guild, room } = await resolveRoom(client, event, store.settings(job.guild_id, job.event_id)?.room_id);
    const member = await guild.members.fetch({ user: job.user_id, force: true }).catch(error => {
      if (Number(error.code) === 10007) throw Object.assign(Error("Member has left the server; no DM was sent."), { blocked: true });
      throw error;
    });
    if (member.user?.bot) throw Object.assign(Error("Bots cannot receive event room messages."), { blocked: true });
    await guild.roles.fetch();
    const access = room.permissionsFor(member);
    if (!access?.has(P.ViewChannel) || ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(room.type) && !access.has(P.Connect))) throw Object.assign(Error("This member cannot access the event room; no permissions were changed."), { blocked: true });
    let after;
    try {
      const latest = await dm.messages.fetch({ limit: 1, cache: false });
      after = latest.first()?.id || "0";
    } catch (error) {
      // A first DM must not depend on permission to read an empty conversation.
      // Save a conservative time boundary before sending. Unknown outcomes STILL
      // require full history recovery above; unavailable recovery never resends.
      if (![10003, 50001, 50013].includes(Number(error.code))) throw error;
      after = ((BigInt(now.getTime() - 60000) - 1420070400000n) << 22n).toString();
    }
    store.update(id, token, { dm_channel_id: dm.id, after_id: after, room_id: room.id });
    job = store.get(id);
    if (lost || !store.renew(id, token, leaseNow())) throw Error("Delivery lock was lost; retry recovery before sending.");
    const current = events.getEvent(job.guild_id, job.event_id);
    const active = store.members(job.guild_id, job.event_id).find(m => m.user_id === job.user_id);
    if (!current || !active || (job.kind === "scheduled" && !active.scheduled)) {
      store.update(id, token, { status: "cancelled" }); return { cancelled: true };
    }
    if (JSON.stringify(current) !== JSON.stringify(event) || JSON.stringify(store.settings(job.guild_id, job.event_id) || null) !== settingsSnapshot) throw Error("Event changed while preparing the message. Retry will use its current details.");
    const sent = await dm.send(payload(event, room, job));
    store.update(id, token, { status: "sent", message_id: sent.id, sent_at: now.toISOString(), last_error: null, retry_at: null });
    return { sent: true };
  } catch (error) {
    console.error("[event-room-links] delivery_failed", JSON.stringify({ deliveryId: id, code: error.code || error.status || null, reason: String(error.message).replace(/https?:\/\/\S+/g, "[url]").slice(0, 200) }));
    if (token) {
      const blocked = error.blocked || [50007, 10013].includes(Number(error.code));
      const unsafe = error.unsafeRecovery;
      const seconds = Math.max(60, Number(error.retry_after) || Number(error.retryAfter) / 1000 || 300);
      const retry = new Date(now.getTime() + seconds * 1000);
      store.update(id, token, { status: blocked ? "blocked" : unsafe ? "failed" : "pending", last_error: Number(error.code) === 50007 ? "DMs are unavailable for this member. Nothing was confirmed delivered." : String(error.message).slice(0, 300), retry_at: blocked || unsafe ? null : Number.isFinite(retry.getTime()) ? retry.toISOString() : "9999-12-31T23:59:59.999Z" });
    }
    return { failed: true, error: error.message };
  } finally {
    clearInterval(heartbeat);
    if (token) store.release(id, token);
    running.delete(id);
  }
}
async function process(client, { now = new Date() } = {}) {
  reconcile(now);
  const results = [];
  for (const row of store.due(now)) results.push(await deliver(client, row.id, { now }));
  return results;
}
function start(client) {
  // Read-only startup evidence for failures saved before diagnostics existed.
  console.info("[event-room-links] saved_status", JSON.stringify(store.diagnostics()));
  for (const row of store.recentFailures()) console.warn("[event-room-links] saved_failure", JSON.stringify({ deliveryId: row.id, status: row.status, reason: row.last_error.replace(/https?:\/\/\S+/g, "[url]").slice(0, 200) }));
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await process(client); } catch (error) { console.error("Event room link messages failed:", error.message); }
    finally { busy = false; }
  };
  run();
  const timer = setInterval(run, 30000);
  timer.unref?.();
  return () => clearInterval(timer);
}
module.exports = { start, timing, validDay, resolveRoom, link, payload, matches, recover, reconcile, deliver, process, roomTypes };
