"use strict";
const { getDb } = require("../db/sqlite");
const { createHash, randomUUID } = require("node:crypto");
const get = (g, c) =>
  getDb()
    .prepare(
      "SELECT * FROM concert_countdowns WHERE guild_id=? AND channel_id=?",
    )
    .get(g, c);
const list = (g) =>
  getDb()
    .prepare(
      "SELECT guild_id,channel_id,config,message_id,enabled,last_success,last_error,revision FROM concert_countdowns WHERE guild_id=? ORDER BY channel_id",
    )
    .all(g);
const enabled = () =>
  getDb()
    .prepare(
      "SELECT guild_id,channel_id FROM concert_countdowns WHERE enabled=1",
    )
    .all();
function save(g, c, config, expected) {
  const old = get(g, c);
  if (expected !== undefined && (old?.revision ?? -1) !== expected)
    throw Error("This countdown changed. Reopen it before saving.");
  if (old?.lease_until > Date.now())
    throw Error("An update is running. Try again shortly.");
  getDb()
    .prepare(
      `INSERT INTO concert_countdowns(guild_id,channel_id,config) VALUES(?,?,?)
    ON CONFLICT(guild_id,channel_id) DO UPDATE SET config=excluded.config,fingerprint=NULL,revision=revision+1,retry_at=NULL`,
    )
    .run(g, c, JSON.stringify({ ...config, guildId: g }));
  return get(g, c);
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
      "UPDATE concert_countdowns SET photo=?,photo_type=?,fingerprint=NULL,revision=revision+1,retry_at=NULL WHERE guild_id=? AND channel_id=?",
    )
    .run(bytes, type, g, c);
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
}
// Reads only the approved calendar; candidates and Radar discoveries are separate tables.
function concerts(g, query = "") {
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_events WHERE guild_id=? AND calendar_type='stray_kids' AND category='concert' AND cancelled_at IS NULL ORDER BY COALESCE(event_date,substr(event_at,1,10)),id`,
    )
    .all(g)
    .filter(
      (e) =>
        !query ||
        [e.title, e.event_location, e.event_date]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
}
module.exports = {
  get,
  list,
  enabled,
  save,
  photo,
  photos,
  reusePhoto,
  update,
  acquire,
  renew,
  release,
  concerts,
};
