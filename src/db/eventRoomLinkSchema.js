"use strict";
function migrateEventRoomLinks(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_room_link_settings (
      guild_id TEXT NOT NULL, event_id INTEGER NOT NULL,
      room_id TEXT, local_time TEXT NOT NULL DEFAULT '09:00',
      updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(guild_id,event_id)
    );
    CREATE TABLE IF NOT EXISTS event_room_link_members (
      guild_id TEXT NOT NULL, event_id INTEGER NOT NULL, user_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, scheduled INTEGER NOT NULL DEFAULT 0,
      added_by TEXT NOT NULL, added_at TEXT NOT NULL,
      PRIMARY KEY(guild_id,event_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS event_room_link_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL, event_id INTEGER NOT NULL, user_id TEXT NOT NULL,
      operation_key TEXT NOT NULL, kind TEXT NOT NULL,
      due_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      nonce TEXT NOT NULL, dm_channel_id TEXT, after_id TEXT, room_id TEXT,
      lease_token TEXT, lease_until INTEGER, retry_at TEXT,
      sent_at TEXT, message_id TEXT, last_error TEXT, created_at TEXT NOT NULL,
      UNIQUE(operation_key,user_id)
    );
    CREATE INDEX IF NOT EXISTS event_room_link_due ON event_room_link_deliveries(status,due_at);
  `);
}
module.exports = { migrateEventRoomLinks };
