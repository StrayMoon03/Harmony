"use strict";
const { getDb } = require("../db/sqlite");
const { createHash, randomUUID } = require("node:crypto");
const changes = new (require("node:events").EventEmitter)();
const subscribe = listener => { changes.on("change", listener); return () => changes.off("change", listener); };
const get = (g, c) =>
  getDb()
    .prepare(
      "SELECT * FROM concert_countdowns WHERE guild_id=? AND channel_id=?",
    )
    .get(g, c);
const list = (g) =>
  getDb()
    .prepare(
      "SELECT guild_id,channel_id,config,message_id,published_at,enabled,last_success,last_error,revision FROM concert_countdowns WHERE guild_id=? ORDER BY channel_id",
    )
    .all(g);
const enabled = () =>
  getDb()
    .prepare(
      "SELECT guild_id,channel_id FROM concert_countdowns WHERE enabled=1",
    )
    .all();
// Metadata only: do not load every saved photograph during scheduler scans.
function renderingWork(version) {
  return getDb()
    .prepare(
      `SELECT guild_id,channel_id,enabled,message_id,published_at,render_version,config,fingerprint,last_success,last_error,retry_at,delivery,lease_until
    FROM concert_countdowns
    WHERE (message_id IS NOT NULL OR published_at IS NOT NULL OR delivery IS NOT NULL)
      AND (enabled=1 OR ((message_id IS NOT NULL OR published_at IS NOT NULL) AND COALESCE(render_version,'')<>?))
    ORDER BY guild_id,channel_id`,
    )
    .all(version);
}
function save(g, c, config, expected) {
  const old = get(g, c);
  if (expected !== undefined && (old?.revision ?? -1) !== expected)
    throw Error("This countdown changed. Reopen it before saving.");
  if (old?.lease_until > Date.now())
    throw Error("An update is running. Try again shortly.");
  getDb()
    .prepare(
      `INSERT INTO concert_countdowns(guild_id,channel_id,config) VALUES(?,?,?)
    ON CONFLICT(guild_id,channel_id) DO UPDATE SET config=excluded.config,fingerprint=NULL,revision=revision+1,retry_at=CASE WHEN retry_kind='rate_limit' THEN retry_at ELSE NULL END`,
    )
    .run(g, c, JSON.stringify({ ...config, guildId: g }));
  changes.emit("change");
  return get(g, c);
}
// Correct a newly created private draft's room without leaving a second draft.
// Published or in-flight countdowns are never moved by the creation UI.
function moveDraft(g, from, to, expected) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const old = get(g, from);
    if (!old || old.revision !== expected) throw Error("This draft changed. Reopen it before changing rooms.");
    if (old.message_id || old.published_at || old.delivery || old.lease_until > Date.now())
      throw Error("A published or in-flight countdown cannot be moved from setup.");
    if (get(g, to)) throw Error("This room already has a countdown.");
    db.prepare("UPDATE concert_countdowns SET channel_id=?,revision=revision+1,fingerprint=NULL WHERE guild_id=? AND channel_id=?").run(to, g, from);
    db.exec("COMMIT");
    changes.emit("change");
    return get(g, to);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function photo(g, c, bytes, type) {
  const row = get(g, c);
  if (!row) throw Error("Save the countdown first");
  if (row.lease_until > Date.now())
    throw Error("An update is running. Try again shortly.");
  const id = createHash("sha256").update(bytes).digest("hex");
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO concert_countdown_photos(guild_id,id,name,bytes,type) VALUES(?,?,?,?,?)",
    )
    .run(g, id, JSON.parse(row.config).venue, bytes, type);
  getDb()
    .prepare(
      "UPDATE concert_countdowns SET photo=?,photo_type=?,fingerprint=NULL,revision=revision+1,retry_at=CASE WHEN retry_kind='rate_limit' THEN retry_at ELSE NULL END WHERE guild_id=? AND channel_id=?",
    )
    .run(bytes, type, g, c);
  changes.emit("change");
}
function photos(g) {
  return getDb()
    .prepare(
      "SELECT id,name FROM concert_countdown_photos WHERE guild_id=? ORDER BY name",
    )
    .all(g);
}
function reusePhoto(g, c, id) {
  const p = getDb()
    .prepare("SELECT * FROM concert_countdown_photos WHERE guild_id=? AND id=?")
    .get(g, id);
  if (!p) throw Error("Photograph is no longer available");
  photo(g, c, p.bytes, p.type);
}
function update(g, c, fields) {
  const allowed = [
    "message_id",
    "enabled",
    "fingerprint",
    "last_success",
    "last_error",
    "delivery",
    "published_at",
    "retry_at",
    "retry_kind",
    "render_version",
    "checked_at",
    "legacy_recovery",
  ];
  const keys = Object.keys(fields);
  if (!keys.length || keys.some((k) => !allowed.includes(k)))
    throw Error("Invalid update");
  getDb()
    .prepare(
      "UPDATE concert_countdowns SET " +
        keys.map((k) => k + "=?").join(",") +
        " WHERE guild_id=? AND channel_id=?",
    )
    .run(...keys.map((k) => fields[k]), g, c);
  changes.emit("change");
}
function acquire(g, c) {
  const token = randomUUID();
  const now = Date.now();
  const changed = getDb()
    .prepare(
      "UPDATE concert_countdowns SET lease_token=?,lease_until=? WHERE guild_id=? AND channel_id=? AND (lease_until IS NULL OR lease_until<?)",
    )
    .run(token, now + 15 * 60 * 1000, g, c, now).changes;
  return changed ? token : null;
}
function renew(g, c, token) {
  return (
    getDb()
      .prepare(
        "UPDATE concert_countdowns SET lease_until=? WHERE guild_id=? AND channel_id=? AND lease_token=?",
      )
      .run(Date.now() + 15 * 60 * 1000, g, c, token).changes > 0
  );
}
function release(g, c, token) {
  getDb()
    .prepare(
      "UPDATE concert_countdowns SET lease_token=NULL,lease_until=NULL WHERE guild_id=? AND channel_id=? AND lease_token=?",
    )
    .run(g, c, token);
  // A manual update may have armed a retry while its lease was still held.
  changes.emit("change");
}
// Reads only the approved calendar; candidates and Radar discoveries are separate tables.
function concerts(g, query = "") {
  return require("../services/concertTourCalendar").listConcerts(g, query);
}

module.exports = {
  subscribe,
  get,
  list,
  enabled,
  renderingWork,
  save,
  moveDraft,
  photo,
  photos,
  reusePhoto,
  update,
  acquire,
  renew,
  release,
  concerts,
};
