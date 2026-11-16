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

function setMemberCountEnabled(guildId, enabled) {
  const result = getDb().prepare(
    "UPDATE member_count_settings SET enabled = ?, updated_at = ? WHERE guild_id = ?"
  ).run(enabled ? 1 : 0, new Date().toISOString(), guildId);
  return Number(result.changes) > 0;
}

const easternDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

function easternWeekKey(now) {
  const parts = Object.fromEntries(easternDate.formatToParts(now).map(({ type, value }) => [type, value]));
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}

function recordMemberCountActivity(guildId, kind, now = new Date()) {
  getDb().prepare(`
    INSERT INTO member_count_activity (guild_id, week_key, observed_at, kind)
    VALUES (?, ?, ?, ?)
  `).run(guildId, easternWeekKey(now), now.toISOString(), kind);
}

function seedYoutifulStaysMemberCountWeek(guildId) {
  // The owner reported this activity for the week of November 9, 2026 (Eastern).
  getDb().prepare(`
    INSERT INTO member_count_week_seeds (guild_id, week_key, joined, left)
    VALUES (?, '2026-11-09', 2, 1)
    ON CONFLICT(guild_id, week_key) DO NOTHING
  `).run(guildId);
}

function getWeeklyMemberCountActivity(guildId, now = new Date()) {
  const week = easternWeekKey(now);
  const { joined, left } = getDb().prepare(`
    SELECT
      COUNT(CASE WHEN kind = 'join' THEN 1 END) + COALESCE((
        SELECT joined FROM member_count_week_seeds WHERE guild_id = $guild AND week_key = $week
      ), 0) AS joined,
      COUNT(CASE WHEN kind = 'leave' THEN 1 END) + COALESCE((
        SELECT left FROM member_count_week_seeds WHERE guild_id = $guild AND week_key = $week
      ), 0) AS left
    FROM member_count_activity WHERE guild_id = $guild AND week_key = $week
  `).get({ $guild: guildId, $week: week });
  return { joined, left, net: joined - left };
}

module.exports = {
  recordMemberCountActivity,
  seedYoutifulStaysMemberCountWeek,
  getWeeklyMemberCountActivity,
  getMemberCountSettings,
  listEnabledMemberCountSettings,
  saveMemberCountSettings,
  disableMemberCountSettings,
  setMemberCountEnabled,
};
