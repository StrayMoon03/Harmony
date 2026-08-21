const { getDb } = require("../db/sqlite");

function getErrorInboxSettings() {
  return getDb()
    .prepare(
      "SELECT destination_guild_id, destination_channel_id, enabled, updated_at " +
      "FROM error_inbox_settings WHERE id = 1"
    )
    .get() || null;
}

function saveErrorInboxSettings(guildId, channelId) {
  getDb()
    .prepare(`
      INSERT INTO error_inbox_settings (
        id, destination_guild_id, destination_channel_id, enabled, updated_at
      ) VALUES (1, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET
        destination_guild_id = excluded.destination_guild_id,
        destination_channel_id = excluded.destination_channel_id,
        enabled = 1,
        updated_at = excluded.updated_at
    `)
    .run(guildId, channelId, new Date().toISOString());
}

function disableErrorInbox() {
  return getDb()
    .prepare(
      "UPDATE error_inbox_settings SET enabled = 0, updated_at = ? WHERE id = 1"
    )
    .run(new Date().toISOString()).changes > 0;
}

module.exports = {
  getErrorInboxSettings,
  saveErrorInboxSettings,
  disableErrorInbox,
};
