const { getDb } = require("../db/sqlite");

const PERIOD_DAYS = { week: 7, month: 30 };

function periodStart(period) {
  const days = PERIOD_DAYS[period];
  if (!days) return null;
  return new Date(Date.now() - days * 86400000).toISOString();
}

function wherePeriod(period, alias = "") {
  const prefix = alias ? alias + "." : "";
  const start = periodStart(period);
  return start
    ? { sql: " AND " + prefix + "shared_at >= ?", params: [start] }
    : { sql: "", params: [] };
}

function getCollectionSettings(guildId) {
  return getDb().prepare(
    "SELECT * FROM collection_settings WHERE guild_id = ?"
  ).get(guildId) || null;
}

function listScheduledCollectionSettings() {
  return getDb().prepare(
    "SELECT * FROM collection_settings WHERE schedule_enabled = 1"
  ).all();
}

function saveCollectionSettings({
  guildId,
  channelId,
  milestonesEnabled,
  scheduleEnabled,
  weekday,
  hour,
  timezone,
}) {
  getDb().prepare(`
    INSERT INTO collection_settings (
      guild_id, channel_id, milestones_enabled, schedule_enabled,
      weekday, hour, timezone, last_weekly_key, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      milestones_enabled = excluded.milestones_enabled,
      schedule_enabled = excluded.schedule_enabled,
      weekday = excluded.weekday,
      hour = excluded.hour,
      timezone = excluded.timezone,
      updated_at = excluded.updated_at
  `).run(
    guildId,
    channelId,
    milestonesEnabled ? 1 : 0,
    scheduleEnabled ? 1 : 0,
    weekday,
    hour,
    timezone,
    new Date().toISOString()
  );
}

function markWeeklyRecapPosted(guildId, key) {
  getDb().prepare(
    "UPDATE collection_settings SET last_weekly_key = ? WHERE guild_id = ?"
  ).run(key, guildId);
}

function getLeaderboard(guildId, period, platform, limit = 10) {
  const range = wherePeriod(period);
  const params = [guildId, ...range.params];
  let platformSql = "";
  if (platform && platform !== "all") {
    platformSql = " AND platform = ?";
    params.push(platform);
  }
  params.push(limit);

  return getDb().prepare(`
    SELECT
      shared_by_id,
      MAX(shared_by) AS shared_by,
      COUNT(*) AS total
    FROM shares
    WHERE guild_id = ?
      AND shared_by_id IS NOT NULL
      ${range.sql}
      ${platformSql}
    GROUP BY shared_by_id
    ORDER BY total DESC, LOWER(MAX(shared_by)) ASC
    LIMIT ?
  `).all(...params);
}

function getMemberStats(guildId, userId, period) {
  const range = wherePeriod(period);
  const rows = getDb().prepare(`
    SELECT platform, COUNT(*) AS total
    FROM shares
    WHERE guild_id = ? AND shared_by_id = ?
      ${range.sql}
    GROUP BY platform
    ORDER BY total DESC, platform ASC
  `).all(guildId, userId, ...range.params);

  const total = rows.reduce((sum, row) => sum + Number(row.total), 0);
  const allTime = getDb().prepare(`
    SELECT COUNT(*) AS total, MIN(shared_at) AS first_shared_at
    FROM shares
    WHERE guild_id = ? AND shared_by_id = ?
  `).get(guildId, userId);

  const rankRows = getLeaderboard(guildId, period, "all", 1000);
  const rank = rankRows.findIndex((row) => row.shared_by_id === userId) + 1;

  return {
    total,
    platforms: rows,
    rank: rank || null,
    allTimeTotal: Number(allTime?.total || 0),
    firstSharedAt: allTime?.first_shared_at || null,
  };
}

function getRecap(guildId, period) {
  const range = wherePeriod(period);
  const totalRow = getDb().prepare(`
    SELECT COUNT(*) AS total, COUNT(DISTINCT shared_by_id) AS contributors
    FROM shares
    WHERE guild_id = ? ${range.sql}
  `).get(guildId, ...range.params);

  const platforms = getDb().prepare(`
    SELECT platform, COUNT(*) AS total
    FROM shares
    WHERE guild_id = ? ${range.sql}
    GROUP BY platform
    ORDER BY total DESC, platform ASC
  `).all(guildId, ...range.params);

  const creators = getDb().prepare(`
    SELECT creator, COUNT(*) AS total
    FROM shares
    WHERE guild_id = ?
      AND creator IS NOT NULL
      AND LOWER(creator) NOT LIKE 'unknown%'
      ${range.sql}
    GROUP BY LOWER(creator)
    ORDER BY total DESC, LOWER(creator) ASC
    LIMIT 5
  `).all(guildId, ...range.params);

  const firstTimers = getDb().prepare(`
    SELECT COUNT(*) AS total
    FROM (
      SELECT shared_by_id
      FROM shares
      WHERE guild_id = ? AND shared_by_id IS NOT NULL
      GROUP BY shared_by_id
      HAVING MIN(shared_at) >= ?
    )
  `).get(guildId, periodStart(period) || "1970-01-01T00:00:00.000Z");

  return {
    total: Number(totalRow?.total || 0),
    contributors: Number(totalRow?.contributors || 0),
    platforms,
    creators,
    leaders: getLeaderboard(guildId, period, "all", 5),
    firstTimers: period === "all" ? 0 : Number(firstTimers?.total || 0),
  };
}

function getMemberAllTimeCount(guildId, userId) {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS total
    FROM shares
    WHERE guild_id = ? AND shared_by_id = ?
  `).get(guildId, userId);
  return Number(row?.total || 0);
}

function claimMilestone(guildId, userId, milestone) {
  try {
    getDb().prepare(`
      INSERT INTO collection_milestones (
        guild_id, user_id, milestone, announced_at
      ) VALUES (?, ?, ?, ?)
    `).run(guildId, userId, milestone, new Date().toISOString());
    return true;
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) return false;
    throw error;
  }
}

module.exports = {
  periodStart,
  getCollectionSettings,
  listScheduledCollectionSettings,
  saveCollectionSettings,
  markWeeklyRecapPosted,
  getLeaderboard,
  getMemberStats,
  getRecap,
  getMemberAllTimeCount,
  claimMilestone,
};
