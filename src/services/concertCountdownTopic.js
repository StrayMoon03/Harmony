"use strict";
const { PermissionFlagsBits: P } = require("discord.js");
const store = require("../stores/concertCountdownStore");
const access = require("./concertCountdownPermissions");
const { localDate, nextMidnight } = require("./concertCountdownModel");
const VERSION = store.TOPIC_VERSION, LIMIT = 1024, WINDOW_MS = 10 * 60000;
function format(m) {
  let content;
  const city = String(m.city).replace(/\s+/g, " ").trim();
  if (!m.panels.length) content = "No active concert dates — check the calendar.";
  else if (m.panels.length === 1) {
    const p = m.panels[0];
    content = p.state === "completed" ? `${city} concert completed — thank you for the memories!`
      : p.state === "today" ? `It's concert day in ${city}!`
        : `${p.days} ${p.days === 1 ? "day" : "days"} until ${city}!`;
  } else content = m.panels.map(p => `Day ${p.day}: ${p.state === "completed" ? "Completed" : p.state === "today" ? "Concert day!" : `${p.days} ${p.days === 1 ? "day" : "days"}`}`).join(" | ");
  return `🧡 ${content} 🖤`;
}
function compose(current, owned, desired) {
  const existing = String(current || "");
  const managed = new Set([...owned, desired].filter(Boolean));
  // Remove only complete, exact owned lines. All other text/spacing stays intact.
  const parts = existing.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || [];
  const unknown = parts.map(p => p.replace(/[\r\n]+$/, "")).filter(line => !managed.has(line));
  if (unknown.some(line => [...managed].some(text => line.includes(text)) || /^🧡 (?:Day \d+:|\d+ days? until |It's concert day in |No active concert dates|.+ concert completed —)/u.test(line))) {
    throw Object.assign(Error("Existing countdown-like topic text was edited or shares a line with other information. The topic was kept for review to avoid duplicates or removing room information."), { code: "COUNTDOWN_TOPIC_CONFLICT" });
  }
  const rest = parts.filter(part => !managed.has(part.replace(/[\r\n]+$/, ""))).join("");
  const topic = desired + (rest ? "\n" + rest : "");
  // Conservative UTF-16 count also stays within Discord's Unicode limit.
  if (topic.length > LIMIT) throw Object.assign(Error("Not enough channel topic space for all concert dates. Existing topic information was kept. Shorten the other topic text, then use Refresh Now."), { code: "COUNTDOWN_TOPIC_LENGTH" });
  return topic;
}
function nextUpdate(row, now = new Date()) {
  if ((!row.message_id && !row.published_at) || (!row.enabled && row.topic_version === VERSION)) return null;
  let due;
  if (Date.parse(row.topic_retry_at) > now.getTime()) due = new Date(row.topic_retry_at);
  else if (row.topic_version !== VERSION || row.topic_revision !== row.revision || row.topic_retry_at || row.topic_error || !row.topic_last_success) due = now;
  else {
    try {
      const { timezone } = JSON.parse(row.config);
      due = localDate(new Date(row.topic_last_success), timezone) !== localDate(now, timezone) ? now : nextMidnight(now, timezone);
    } catch { due = now; } // sync persists a separate metadata-error retry.
  }
  return row.topic_lease_until >= due.getTime() ? new Date(row.topic_lease_until + 1) : due;
}
function status(row) {
  if (row.topic_error) return row.topic_error + (row.topic_retry_at ? ` Retry after ${row.topic_retry_at}.` : "");
  if (row.topic_retry_at) return `Waiting to update safely; retry after ${row.topic_retry_at}.`;
  return row.topic_last_success ? `Updated ${row.topic_last_success}` : "Not updated yet";
}
async function sync(client, g, c, makeModel, { now = new Date(), force = false, scheduled = false } = {}) {
  let lease, heartbeat, lostLease = false;
  try {
    let row = store.get(g, c);
    if (!row || (!row.message_id && !row.published_at)) return { skipped: true };
    if (Date.parse(row.topic_retry_at) > now.getTime() && !(force && ["permission", "content"].includes(row.topic_retry_kind))) return { deferred: true };
    lease = store.acquireTopic(g, c);
    if (!lease) return { deferred: true };
    heartbeat = setInterval(() => {
      try { if (!store.renewTopic(g, c, lease)) lostLease = true; } catch { lostLease = true; }
    }, 30000);
    heartbeat.unref?.();
    row = store.get(g, c);
    const desired = format(makeModel(row));
    // Fresh bot member, inherited roles and channel overrides; never change permissions.
    const { channel, member } = await access.inspect(client, g, c);
    if (!channel.permissionsFor(member)?.has(P.ManageChannels)) throw Object.assign(Error("Harmony needs Manage Channels in this room to update its topic. The pinned graphic can still update."), { code: "COUNTDOWN_TOPIC_PERMISSION" });
    const topic = compose(channel.topic, [row.topic_text, row.topic_pending_text], desired);
    if (topic !== (channel.topic || "")) {
      const attemptAt = Math.max(now.getTime(), Date.now());
      const attempts = JSON.parse(row.topic_attempts || "[]").filter(t => Number.isFinite(t) && t + WINDOW_MS > attemptAt);
      // Conservative persisted per-room burst budget; Discord.js also honors REST buckets.
      if (attempts.length >= 2) {
        const retryAt = new Date(Math.min(...attempts) + WINDOW_MS).toISOString();
        store.update(g, c, { topic_retry_at: retryAt, topic_retry_kind: "rate_limit" });
        return { deferred: true };
      }
      if (lostLease || !store.renewTopic(g, c, lease)) throw Error("Topic update lock was lost. Recovery will retry safely.");
      const current = store.get(g, c);
      if (current.revision !== row.revision) return { deferred: true };
      if (scheduled && !current.enabled && current.topic_version === VERSION) return { skipped: true };
      // Checkpoint ownership before PATCH so a lost response cannot duplicate tomorrow's line.
      store.update(g, c, { topic_pending_text: desired, topic_attempts: JSON.stringify([...attempts, attemptAt]) });
      await channel.setTopic(topic, "Youtiful STAY concert countdown");
    }
    if (lostLease || !store.renewTopic(g, c, lease)) throw Error("Topic update lock was lost. Recovery will retry safely.");
    store.update(g, c, { topic_text: desired, topic_pending_text: null, topic_version: VERSION, topic_revision: row.revision, topic_last_success: now.toISOString(), topic_error: null, topic_retry_at: null, topic_retry_kind: null });
    return { updated: true };
  } catch (error) {
    const permission = error.code === "COUNTDOWN_TOPIC_PERMISSION" || [50001, 50013].includes(Number(error.code));
    const content = ["COUNTDOWN_TOPIC_LENGTH", "COUNTDOWN_TOPIC_CONFLICT"].includes(error.code);
    const limited = Number(error.status) === 429 || Number(error.code) === 429 || Boolean(error.retry_after || error.retryAfter);
    const wait = Math.max(60, Number(error.retry_after) || Number(error.retryAfter) / 1000 || (permission ? 21600 : 300));
    const message = permission ? "Harmony needs Manage Channels or Discord refused the topic edit. Check room access. The pinned graphic can still update." : `Channel topic was not updated: ${String(error.message).replace(/https?:\/\/\S+/g, "[url]").slice(0, 260)}`;
    if (lease) {
      try { if (store.get(g, c)?.topic_lease_token === lease) store.update(g, c, { topic_error: message, topic_retry_at: new Date(Math.max(now.getTime(), Date.now()) + wait * 1000).toISOString(), topic_retry_kind: limited ? "rate_limit" : permission ? "permission" : content ? "content" : "temporary" }); }
      catch { console.warn("Countdown topic checkpoint could not be saved", c); }
    }
    return { failed: true, error: message };
  } finally {
    clearInterval(heartbeat);
    if (lease) { try { store.releaseTopic(g, c, lease); } catch { console.warn("Countdown topic lease release failed", c); } }
  }
}
module.exports = { VERSION, LIMIT, format, compose, nextUpdate, sync, status };
