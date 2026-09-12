const { getDb } = require("../db/sqlite");

function getMemberCountSettings(guildId) {
  return getDb()
    .prepare("SELECT * FROM member_count_settings WHERE guild_id = ? LIMIT 1")
    .get(guildId) ?? null;
}

function listEnabledMemberCountSettings() {
  return getDb()
    .prepare("SELECT * FROM member_count_settings WHERE enabled = 1")
    .all();
}

function saveMemberCountSettings({
  guildId,
  roleId,
  categoryId,
  totalChannelId,
  stayChannelId,
  noRoleChannelId,
}) {
  getDb().prepare(`
    INSERT INTO member_count_settings (
      guild_id, role_id, category_id, total_channel_id,
      stay_channel_id, no_role_channel_id, enabled, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      role_id = excluded.role_id,
      category_id = excluded.category_id,
      total_channel_id = excluded.total_channel_id,
      stay_channel_id = excluded.stay_channel_id,
      no_role_channel_id = excluded.no_role_channel_id,
      enabled = 1,
      updated_at = excluded.updated_at
  `).run(
    guildId,
    roleId,
    categoryId,
    totalChannelId,
    stayChannelId,
    noRoleChannelId,
    new Date().toISOString()
  );
}

function disableMemberCountSettings(guildId) {
  const result = getDb().prepare(
    "UPDATE member_count_settings SET enabled = 0, updated_at = ? WHERE guild_id = ?"
  ).run(new Date().toISOString(), guildId);
  return Number(result.changes) > 0;
}

module.exports = {
  getMemberCountSettings,
  listEnabledMemberCountSettings,
  saveMemberCountSettings,
  disableMemberCountSettings,
};
