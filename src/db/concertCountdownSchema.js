"use strict";
function migrateCountdowns(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS concert_countdowns (
    guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, config TEXT NOT NULL,
    photo BLOB, photo_type TEXT, message_id TEXT, enabled INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT, last_success TEXT, last_error TEXT, PRIMARY KEY(guild_id,channel_id));
    CREATE TABLE IF NOT EXISTS concert_countdown_photos (
    guild_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, bytes BLOB NOT NULL,
    type TEXT NOT NULL, PRIMARY KEY(guild_id,id));
    CREATE TABLE IF NOT EXISTS concert_tour_events (
      guild_id TEXT NOT NULL, stop_key TEXT NOT NULL, event_id INTEGER NOT NULL,
      location_key TEXT NOT NULL, city TEXT NOT NULL, country TEXT NOT NULL,
      venue TEXT NOT NULL, timezone TEXT NOT NULL, search_aliases TEXT NOT NULL DEFAULT '[]',
      source_url TEXT NOT NULL, verified_at TEXT NOT NULL, approved_by TEXT NOT NULL, linked_at TEXT NOT NULL,
      PRIMARY KEY(guild_id,stop_key), UNIQUE(guild_id,event_id));`);
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(concert_countdowns)")
      .all()
      .map((c) => c.name),
  );
  for (const [name, type] of Object.entries({
    revision: "INTEGER NOT NULL DEFAULT 0",
    delivery: "TEXT",
    published_at: "TEXT",
    retry_at: "TEXT",
    lease_token: "TEXT",
    lease_until: "INTEGER",
    checked_at: "TEXT",
    legacy_recovery: "INTEGER NOT NULL DEFAULT 0",
  })) {
    if (!columns.has(name))
      db.exec(`ALTER TABLE concert_countdowns ADD COLUMN ${name} ${type}`);
  }
  if (!columns.has("delivery"))
    db.exec(
      "UPDATE concert_countdowns SET legacy_recovery=1 WHERE message_id IS NULL",
    );
  db.exec(
    "UPDATE concert_countdowns SET published_at=COALESCE(last_success, 'legacy') WHERE message_id IS NOT NULL AND published_at IS NULL",
  );
}
module.exports = { migrateCountdowns };
