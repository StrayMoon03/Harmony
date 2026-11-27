"use strict";
const { randomUUID, randomBytes } = require("node:crypto");
const { getDb } = require("../db/sqlite");
const settings = (g, e) => getDb().prepare("SELECT * FROM event_room_link_settings WHERE guild_id=? AND event_id=?").get(g, e);
const members = (g, e) => getDb().prepare("SELECT * FROM event_room_link_members WHERE guild_id=? AND event_id=? AND active=1 ORDER BY added_at,user_id").all(g, e);
const deliveries = (g, e) => getDb().prepare("SELECT * FROM event_room_link_deliveries WHERE guild_id=? AND event_id=? ORDER BY id DESC LIMIT 100").all(g, e);
const get = id => getDb().prepare("SELECT * FROM event_room_link_deliveries WHERE id=?").get(id);
function configure(g, e, values, actor, now = new Date()) {
  const old = settings(g, e);
  getDb().prepare(`INSERT INTO event_room_link_settings(guild_id,event_id,room_id,local_time,updated_by,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(guild_id,event_id) DO UPDATE SET room_id=excluded.room_id,local_time=excluded.local_time,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).run(g, e, (Object.prototype.hasOwnProperty.call(values, "roomId") ? values.roomId : old?.room_id) || null, values.localTime ?? old?.local_time ?? "09:00", actor, now.toISOString());
}
function add(g, e, users, actor, now = new Date()) {
  const stmt = getDb().prepare(`INSERT INTO event_room_link_members(guild_id,event_id,user_id,added_by,added_at) VALUES(?,?,?,?,?)
    ON CONFLICT(guild_id,event_id,user_id) DO UPDATE SET active=1,added_by=excluded.added_by`);
  for (const u of new Set(users)) stmt.run(g, e, u, actor, now.toISOString());
}
function remove(g, e, users) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const u of users) {
      db.prepare("UPDATE event_room_link_members SET active=0,scheduled=0 WHERE guild_id=? AND event_id=? AND user_id=?").run(g, e, u);
      db.prepare("UPDATE event_room_link_deliveries SET status='cancelled' WHERE guild_id=? AND event_id=? AND user_id=? AND status='pending'").run(g, e, u);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function replaceRecipients(g, e, selected, expected, actor, now = new Date()) {
  const db = getDb(), wanted = new Set(selected), baseline = [...new Set(expected)].sort();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = members(g, e).map(m => m.user_id).sort();
    if (JSON.stringify(current) !== JSON.stringify(baseline)) throw Error("Recipients changed in another setup. Reopen Manage DM Recipients to load the saved list.");
    const added = [...wanted].filter(u => !current.includes(u)), removed = current.filter(u => !wanted.has(u));
    // Unchanged members keep their schedule and audit fields. Saving never queues deliveries.
    add(g, e, added, actor, now);
    for (const u of removed) {
      db.prepare("UPDATE event_room_link_members SET active=0,scheduled=0 WHERE guild_id=? AND event_id=? AND user_id=?").run(g, e, u);
      db.prepare("UPDATE event_room_link_deliveries SET status='cancelled' WHERE guild_id=? AND event_id=? AND user_id=? AND status='pending'").run(g, e, u);
    }
    db.exec("COMMIT");
    return { added: added.length, removed: removed.length, count: wanted.size };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function schedule(g, e, enabled, users = null) {
  if (users) {
    const statement = getDb().prepare("UPDATE event_room_link_members SET scheduled=? WHERE guild_id=? AND event_id=? AND user_id=? AND active=1");
    for (const user of users) statement.run(enabled ? 1 : 0, g, e, user);
  } else getDb().prepare("UPDATE event_room_link_members SET scheduled=? WHERE guild_id=? AND event_id=? AND active=1").run(enabled ? 1 : 0, g, e);
  if (!enabled) getDb().prepare("UPDATE event_room_link_deliveries SET status='cancelled' WHERE guild_id=? AND event_id=? AND kind='scheduled' AND status='pending'").run(g, e);
}
function enqueue(g, e, users, key, kind, due, now = new Date()) {
  const db = getDb(), ids = [];
  const stmt = db.prepare(`INSERT OR IGNORE INTO event_room_link_deliveries(guild_id,event_id,user_id,operation_key,kind,due_at,nonce,created_at) VALUES(?,?,?,?,?,?,?,?)`);
  for (const u of users) {
    if (!members(g, e).some(m => m.user_id === u)) continue;
    stmt.run(g, e, u, key, kind, due, randomBytes(12).toString("hex"), now.toISOString());
    ids.push(db.prepare("SELECT id FROM event_room_link_deliveries WHERE operation_key=? AND user_id=?").get(key, u).id);
  }
  return ids;
}
function scheduledMembers() { return getDb().prepare("SELECT * FROM event_room_link_members WHERE active=1 AND scheduled=1").all(); }
function reconcile(id, due, valid) {
  getDb().prepare("UPDATE event_room_link_deliveries SET due_at=?,status=CASE WHEN ?=1 THEN 'pending' ELSE 'cancelled' END WHERE id=? AND status IN ('pending','cancelled') AND dm_channel_id IS NULL").run(due, valid ? 1 : 0, id);
}
function due(now) {
  return getDb().prepare("SELECT id FROM event_room_link_deliveries WHERE status IN ('pending','sending') AND due_at<=? AND (retry_at IS NULL OR retry_at<=?) AND (lease_until IS NULL OR lease_until<?) ORDER BY due_at,id LIMIT 100").all(now.toISOString(), now.toISOString(), now.getTime());
}
function claim(id, now) {
  const token = randomUUID();
  return getDb().prepare("UPDATE event_room_link_deliveries SET status='sending',lease_token=?,lease_until=? WHERE id=? AND status IN ('pending','sending') AND due_at<=? AND (retry_at IS NULL OR retry_at<=?) AND (lease_until IS NULL OR lease_until<?)").run(token, now.getTime() + 900000, id, now.toISOString(), now.toISOString(), now.getTime()).changes ? token : null;
}
function renew(id, token, now = new Date()) {
  return getDb().prepare("UPDATE event_room_link_deliveries SET lease_until=? WHERE id=? AND lease_token=?").run(now.getTime() + 900000, id, token).changes > 0;
}
function update(id, token, fields) {
  const allowed = new Set(["status", "due_at", "retry_at", "last_error", "dm_channel_id", "after_id", "room_id", "message_id", "sent_at"]);
  const keys = Object.keys(fields);
  if (!keys.length || keys.some(k => !allowed.has(k))) throw Error("Invalid delivery checkpoint");
  const result = getDb().prepare("UPDATE event_room_link_deliveries SET " + keys.map(k => k + "=?").join(",") + " WHERE id=? AND lease_token=?").run(...keys.map(k => fields[k]), id, token);
  if (!result.changes) throw Error("Delivery lock lost; recovery is required");
}
function release(id, token) { getDb().prepare("UPDATE event_room_link_deliveries SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").run(id, token); }
function retry(g, e) {
  // Known refusals may be retried. Unknown send outcomes still recover first.
  getDb().prepare("UPDATE event_room_link_deliveries SET status='pending' WHERE guild_id=? AND event_id=? AND status IN ('blocked','failed')").run(g, e);
}
function recentFailures() {
  return getDb().prepare("SELECT id,status,last_error FROM event_room_link_deliveries WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 20").all();
}
function diagnostics() {
  const counts = getDb().prepare("SELECT COUNT(*) enrolled,COALESCE(SUM(scheduled),0) scheduled FROM event_room_link_members WHERE active=1").get();
  return { ...counts, jobs: getDb().prepare("SELECT status,COUNT(*) count FROM event_room_link_deliveries GROUP BY status").all() };
}
module.exports = { diagnostics, recentFailures, settings, members, deliveries, get, configure, add, remove, replaceRecipients, schedule, enqueue, scheduledMembers, reconcile, due, claim, renew, update, release, retry };
