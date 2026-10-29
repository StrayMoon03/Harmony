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

function setReviewRoom(guildId, channelId) {
  getDb().prepare(`
    INSERT INTO community_guard_settings (guild_id, channel_id, enabled, updated_at)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      updated_at = excluded.updated_at
  `).run(guildId, channelId, new Date().toISOString());
}

function setMonitoringEnabled(guildId, enabled) {
  return Number(getDb().prepare(`
    UPDATE community_guard_settings SET enabled = ?, updated_at = ?
    WHERE guild_id = ? AND channel_id IS NOT NULL
  `).run(enabled ? 1 : 0, new Date().toISOString(), guildId).changes) > 0;
}

function disableSettings(guildId) {
  getDb().prepare(`
    UPDATE community_guard_settings
    SET enabled = 0, updated_at = ?
    WHERE guild_id = ?
  `).run(new Date().toISOString(), guildId);
}

function addRule({ guildId, type, pattern, action, category, name = null, conditions = null, matchMode = "all" }) {
  const result = getDb().prepare(`
    INSERT INTO community_guard_rules (
      guild_id, rule_type, pattern, action, category, enabled, created_at,
      name, conditions_json, match_mode
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(
    guildId, type, pattern, action, category, new Date().toISOString(),
    name, conditions ? JSON.stringify(conditions) : null, matchMode
  );
  return Number(result.lastInsertRowid);
}

function updateRule(guildId, ruleId, changes) {
  const existing = getRule(guildId, ruleId);
  if (!existing) return false;
  const assignments = [];
  const values = [];
  for (const [key, value] of Object.entries(changes)) {
    if (key === "conditions") {
      assignments.push("conditions_json = ?");
      values.push(JSON.stringify(value));
    } else if (["name", "rule_type", "pattern", "action", "category", "match_mode"].includes(key)) {
      assignments.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (!assignments.length) return true;
  assignments.push("updated_at = ?");
  values.push(new Date().toISOString(), guildId, ruleId);
  return Number(getDb().prepare(`
    UPDATE community_guard_rules SET ${assignments.join(", ")}
    WHERE guild_id = ? AND id = ? AND enabled = 1
  `).run(...values).changes) > 0;
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

function clearSafe(guildId, messageId) {
  getDb().prepare("DELETE FROM community_guard_safe_messages WHERE guild_id = ? AND message_id = ?")
    .run(guildId, messageId);
}

function getMessageState(guildId, messageId) {
  return getDb().prepare(`
    SELECT * FROM community_guard_message_state WHERE guild_id = ? AND message_id = ?
  `).get(guildId, messageId) ?? null;
}

function beginReview(guildId, messageId, ruleId) {
  return Number(getDb().prepare(`
    INSERT INTO community_guard_message_state (
      guild_id, message_id, status, rule_id, review_channel_id, review_message_id, updated_at
    ) VALUES (?, ?, 'pending', ?, NULL, NULL, ?)
    ON CONFLICT(guild_id, message_id) DO UPDATE SET
      status = 'pending', rule_id = excluded.rule_id,
      review_channel_id = NULL, review_message_id = NULL, updated_at = excluded.updated_at
    WHERE community_guard_message_state.status IN ('safe', 'resolved')
  `).run(guildId, messageId, ruleId, new Date().toISOString()).changes) > 0;
}

function setReviewMessage(guildId, messageId, ruleId, channelId, reviewMessageId) {
  getDb().prepare(`
    UPDATE community_guard_message_state SET rule_id = ?, review_channel_id = ?,
      review_message_id = ?, updated_at = ?
    WHERE guild_id = ? AND message_id = ? AND status = 'pending'
  `).run(ruleId, channelId, reviewMessageId, new Date().toISOString(), guildId, messageId);
}

function setMessageState(guildId, messageId, status, ruleId = null) {
  getDb().prepare(`
    INSERT INTO community_guard_message_state (
      guild_id, message_id, status, rule_id, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, message_id) DO UPDATE SET
      status = excluded.status, rule_id = excluded.rule_id, updated_at = excluded.updated_at
  `).run(guildId, messageId, status, ruleId, new Date().toISOString());
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

function countHistory(guildId) {
  return Number(getDb().prepare(`
    SELECT
      (SELECT COUNT(*) FROM community_guard_actions WHERE guild_id = ?) +
      (SELECT COUNT(*) FROM community_guard_safe_messages WHERE guild_id = ?) AS total
  `).get(guildId, guildId)?.total || 0);
}

function listHistory(guildId, { limit = 10, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
  const safeOffset = Math.max(0, Number(offset) || 0);
  return getDb().prepare(`
    SELECT * FROM (
      SELECT a.id AS history_id, a.message_id, a.channel_id, a.user_id,
        a.category, a.source, a.rule_id, r.name AS rule_name, a.admin_id AS actor_id,
        a.dm_delivered, a.created_at, 'removed' AS result
      FROM community_guard_actions a
      LEFT JOIN community_guard_rules r ON r.guild_id = a.guild_id AND r.id = a.rule_id
      WHERE a.guild_id = ?
      UNION ALL
      SELECT -s.rowid AS history_id, s.message_id, NULL AS channel_id, NULL AS user_id,
        r.category, 'Admin Review' AS source, st.rule_id, r.name AS rule_name,
        s.marked_by AS actor_id, NULL AS dm_delivered, s.marked_at AS created_at,
        'safe' AS result
      FROM community_guard_safe_messages s
      LEFT JOIN community_guard_message_state st
        ON st.guild_id = s.guild_id AND st.message_id = s.message_id
      LEFT JOIN community_guard_rules r ON r.guild_id = s.guild_id AND r.id = st.rule_id
      WHERE s.guild_id = ?
    )
    ORDER BY created_at DESC, history_id DESC
    LIMIT ? OFFSET ?
  `).all(guildId, guildId, safeLimit, safeOffset);
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
  setReviewRoom,
  setMonitoringEnabled,
  disableSettings,
  addRule,
  updateRule,
  removeRule,
  listRules,
  getRule,
  isSafeMessage,
  markSafe,
  clearSafe,
  getMessageState,
  beginReview,
  setReviewMessage,
  setMessageState,
  addAction,
  countHistory,
  listHistory,
  removeContributionForMessage,
};
