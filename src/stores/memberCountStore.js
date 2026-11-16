const { getDb } = require("../db/sqlite");

function getMemberCountAccounting(guildId) {
  return getDb().prepare("SELECT * FROM member_count_accounting WHERE guild_id = ?").get(guildId) ||
    { admin_role_id: null, moderator_role_id: null };
}

function saveMemberCountStaffRole(guildId, kind, roleId) {
  const column = { admin: "admin_role_id", moderator: "moderator_role_id" }[kind];
  if (!column) throw new Error("Unknown staff role type");
  getDb().prepare(`
    INSERT INTO member_count_accounting (guild_id, ${column}) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET ${column} = excluded.${column}
  `).run(guildId, roleId);
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
  getMemberCountAccounting,
  saveMemberCountStaffRole,
};
