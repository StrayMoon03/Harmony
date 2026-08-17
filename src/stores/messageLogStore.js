const { getDb } = require("../db/sqlite");

function getLogSettings(guildId) {
  return getDb().prepare(
    "SELECT * FROM message_log_settings WHERE guild_id = ?"
  ).get(guildId) || null;
}

function saveLogSettings(guildId, channelId) {
  getDb().prepare(`
    INSERT INTO message_log_settings (guild_id, channel_id, enabled, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      enabled = 1,
      updated_at = excluded.updated_at
  `).run(guildId, channelId, new Date().toISOString());
}

function disableLogSettings(guildId) {
  return getDb().prepare(
    "UPDATE message_log_settings SET enabled = 0, updated_at = ? WHERE guild_id = ?"
  ).run(new Date().toISOString(), guildId).changes > 0;
}

function addExcludedChannel(guildId, channelId) {
  getDb().prepare(
    "INSERT OR IGNORE INTO message_log_exclusions (guild_id, channel_id) VALUES (?, ?)"
  ).run(guildId, channelId);
}

function removeExcludedChannel(guildId, channelId) {
  getDb().prepare(
    "DELETE FROM message_log_exclusions WHERE guild_id = ? AND channel_id = ?"
  ).run(guildId, channelId);
}

function listExcludedChannels(guildId) {
  return getDb().prepare(
    "SELECT channel_id FROM message_log_exclusions WHERE guild_id = ? ORDER BY channel_id"
  ).all(guildId).map((row) => row.channel_id);
}

function isChannelExcluded(guildId, channelId) {
  return Boolean(getDb().prepare(
    "SELECT 1 FROM message_log_exclusions WHERE guild_id = ? AND channel_id = ?"
  ).get(guildId, channelId));
}

function saveSnapshot(snapshot) {
  getDb().prepare(`
    INSERT INTO message_snapshots
      (message_id, guild_id, channel_id, user_id, username, content, attachments, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      content = excluded.content,
      attachments = excluded.attachments,
      username = excluded.username,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at
  `).run(
    snapshot.messageId, snapshot.guildId, snapshot.channelId,
    snapshot.userId, snapshot.username, snapshot.content,
    snapshot.attachments, snapshot.createdAt, snapshot.updatedAt,
    snapshot.expiresAt
  );
}

function getSnapshot(messageId) {
  return getDb().prepare(
    "SELECT * FROM message_snapshots WHERE message_id = ?"
  ).get(messageId) || null;
}

function addLogPost(messageId, guildId, channelId, deleteAt) {
  getDb().prepare(`
    INSERT OR REPLACE INTO message_log_posts (message_id, guild_id, channel_id, delete_at)
    VALUES (?, ?, ?, ?)
  `).run(messageId, guildId, channelId, deleteAt);
}

function listExpiredLogPosts(now) {
  return getDb().prepare(
    "SELECT * FROM message_log_posts WHERE delete_at <= ? ORDER BY delete_at LIMIT 250"
  ).all(now);
}

function removeLogPost(messageId) {
  getDb().prepare("DELETE FROM message_log_posts WHERE message_id = ?").run(messageId);
}

function purgeExpiredSnapshots(now) {
  getDb().prepare("DELETE FROM message_snapshots WHERE expires_at <= ?").run(now);
}

module.exports = {
  getLogSettings, saveLogSettings, disableLogSettings,
  addExcludedChannel, removeExcludedChannel, listExcludedChannels,
  isChannelExcluded, saveSnapshot, getSnapshot, addLogPost,
  listExpiredLogPosts, removeLogPost, purgeExpiredSnapshots,
};
