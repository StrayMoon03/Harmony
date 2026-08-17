const { getDb } = require("../db/sqlite");

function getSettings(guildId) {
  return getDb()
    .prepare("SELECT * FROM community_guard_settings WHERE guild_id = ?")
    .get(guildId) ?? null;
}

function saveSettings(guildId, channelId) {
  getDb().prepare(`
    INSERT INTO community_guard_settings (guild_id, channel_id, enabled, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      enabled = 1,
      updated_at = excluded.updated_at
  `).run(guildId, channelId, new Date().toISOString());
}

function disableSettings(guildId) {
  getDb().prepare(`
    UPDATE community_guard_settings
    SET enabled = 0, updated_at = ?
    WHERE guild_id = ?
  `).run(new Date().toISOString(), guildId);
}

function addRule({ guildId, type, pattern, action, category }) {
  const result = getDb().prepare(`
    INSERT INTO community_guard_rules (
      guild_id, rule_type, pattern, action, category, enabled, created_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(guildId, type, pattern, action, category, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

function removeRule(guildId, ruleId) {
  const result = getDb().prepare(
    "DELETE FROM community_guard_rules WHERE guild_id = ? AND id = ?"
  ).run(guildId, ruleId);
  return Number(result.changes) > 0;
}

function listRules(guildId) {
  return getDb().prepare(`
    SELECT * FROM community_guard_rules
    WHERE guild_id = ? AND enabled = 1
    ORDER BY id ASC
  `).all(guildId);
}

function getRule(guildId, ruleId) {
  return getDb().prepare(`
    SELECT * FROM community_guard_rules
    WHERE guild_id = ? AND id = ? AND enabled = 1
  `).get(guildId, ruleId) ?? null;
}

function isSafeMessage(guildId, messageId) {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM community_guard_safe_messages
    WHERE guild_id = ? AND message_id = ?
  `).get(guildId, messageId));
}

function markSafe(guildId, messageId, adminId) {
  getDb().prepare(`
    INSERT INTO community_guard_safe_messages (
      guild_id, message_id, marked_by, marked_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, message_id) DO UPDATE SET
      marked_by = excluded.marked_by,
      marked_at = excluded.marked_at
  `).run(guildId, messageId, adminId, new Date().toISOString());
}

function addAction({
  guildId, messageId, channelId, userId, category,
  source, ruleId = null, adminId = null, dmDelivered,
}) {
  getDb().prepare(`
    INSERT INTO community_guard_actions (
      guild_id, message_id, channel_id, user_id, category,
      source, rule_id, admin_id, dm_delivered, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId, messageId, channelId, userId, category,
    source, ruleId, adminId, dmDelivered ? 1 : 0,
    new Date().toISOString()
  );
}

function removeContributionForMessage(guildId, messageId) {
  const db = getDb();
  const share = db.prepare(`
    SELECT * FROM shares WHERE guild_id = ? AND message_id = ? LIMIT 1
  `).get(guildId, messageId);
  if (!share) return null;

  db.prepare("DELETE FROM shares WHERE id = ?").run(share.id);

  if (share.shared_by_id) {
    const row = db.prepare(`
      SELECT COUNT(*) AS total FROM shares
      WHERE guild_id = ? AND shared_by_id = ?
    `).get(guildId, share.shared_by_id);
    db.prepare(`
      DELETE FROM collection_milestones
      WHERE guild_id = ? AND user_id = ? AND milestone > ?
    `).run(guildId, share.shared_by_id, Number(row?.total || 0));
  }

  return share;
}

module.exports = {
  getSettings,
  saveSettings,
  disableSettings,
  addRule,
  removeRule,
  listRules,
  getRule,
  isSafeMessage,
  markSafe,
  addAction,
  removeContributionForMessage,
};
