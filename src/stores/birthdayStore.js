const { getDb } = require("../db/sqlite");

function saveBirthdaySettings({
  guildId,
  channelId,
  roleId,
  timezone,
  announcementHour,
  weeklyEnabled,
  weeklyDay,
  monthlyRecapEnabled,
}) {
  getDb().prepare(`
    INSERT INTO birthday_settings (
      guild_id, channel_id, role_id, timezone, announcement_hour,
      weekly_enabled, weekly_day, monthly_recap_enabled, enabled, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      role_id = excluded.role_id,
      timezone = excluded.timezone,
      announcement_hour = excluded.announcement_hour,
      weekly_enabled = excluded.weekly_enabled,
      weekly_day = excluded.weekly_day,
      monthly_recap_enabled = excluded.monthly_recap_enabled,
      enabled = 1,
      updated_at = excluded.updated_at
  `).run(
    guildId,
    channelId,
    roleId,
    timezone,
    announcementHour,
    weeklyEnabled ? 1 : 0,
    weeklyDay,
    monthlyRecapEnabled ? 1 : 0,
    new Date().toISOString()
  );
}

function getBirthdaySettings(guildId) {
  return getDb().prepare(
    "SELECT * FROM birthday_settings WHERE guild_id = ?"
  ).get(guildId) || null;
}

function listBirthdaySettings() {
  return getDb().prepare(
    "SELECT * FROM birthday_settings WHERE enabled = 1 ORDER BY guild_id"
  ).all();
}

function disableBirthdaySettings(guildId) {
  return getDb().prepare(
    "UPDATE birthday_settings SET enabled = 0, updated_at = ? WHERE guild_id = ?"
  ).run(new Date().toISOString(), guildId).changes > 0;
}

function updateBirthdayRunKey(guildId, column, value) {
  const allowed = new Set([
    "last_daily_key",
    "last_weekly_key",
    "last_monthly_key",
  ]);
  if (!allowed.has(column)) throw new Error("Invalid birthday run key.");
  getDb().prepare(
    `UPDATE birthday_settings SET ${column} = ?, updated_at = ? WHERE guild_id = ?`
  ).run(value, new Date().toISOString(), guildId);
}

function saveWelcomePassBirthdayProfile({
  code,
  celebrationEnabled,
  birthdayMmdd,
  birthdayName,
  timezone,
  bias,
}) {
  getDb().prepare(`
    INSERT INTO birthday_profiles (
      welcome_pass_code, celebration_enabled, birthday_mmdd,
      birthday_name, timezone, bias, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(welcome_pass_code) DO UPDATE SET
      celebration_enabled = excluded.celebration_enabled,
      birthday_mmdd = excluded.birthday_mmdd,
      birthday_name = excluded.birthday_name,
      timezone = excluded.timezone,
      bias = excluded.bias,
      updated_at = excluded.updated_at
  `).run(
    code,
    celebrationEnabled ? 1 : 0,
    celebrationEnabled ? birthdayMmdd : null,
    celebrationEnabled ? birthdayName : null,
    celebrationEnabled ? timezone : null,
    celebrationEnabled ? bias : null,
    new Date().toISOString(),
    new Date().toISOString()
  );
}

function attachWelcomePassBirthdayProfile(code) {
  const db = getDb();
  const pending = db.prepare(
    "SELECT * FROM birthday_profiles WHERE welcome_pass_code = ?"
  ).get(code);
  const link = db.prepare(
    "SELECT guild_id, user_id FROM welcome_pass_links WHERE code = ?"
  ).get(code);
  if (!pending || !link) return false;

  const existing = db.prepare(
    "SELECT * FROM birthday_profiles WHERE guild_id = ? AND user_id = ?"
  ).get(link.guild_id, link.user_id);

  if (existing && existing.id !== pending.id) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Remove the temporary code-only row first so the UNIQUE code can
      // safely move onto an existing manually managed member profile.
      db.prepare("DELETE FROM birthday_profiles WHERE id = ?").run(pending.id);
      db.prepare(`
        UPDATE birthday_profiles SET
          welcome_pass_code = ?,
          celebration_enabled = ?,
          birthday_mmdd = ?,
          birthday_name = ?,
          timezone = ?,
          bias = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        code,
        pending.celebration_enabled,
        pending.birthday_mmdd,
        pending.birthday_name,
        pending.timezone,
        pending.bias,
        new Date().toISOString(),
        existing.id
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  db.prepare(`
    UPDATE birthday_profiles
    SET guild_id = ?, user_id = ?, updated_at = ?
    WHERE id = ?
  `).run(link.guild_id, link.user_id, new Date().toISOString(), pending.id);
  return true;
}

function upsertBirthdayProfile({
  guildId,
  userId,
  birthdayMmdd,
  birthdayName,
  bias,
  timezone = null,
}) {
  const db = getDb();
  const existing = db.prepare(
    "SELECT id FROM birthday_profiles WHERE guild_id = ? AND user_id = ?"
  ).get(guildId, userId);

  if (existing) {
    db.prepare(`
      UPDATE birthday_profiles SET
        celebration_enabled = 1,
        birthday_mmdd = ?,
        birthday_name = ?,
        bias = ?,
        timezone = COALESCE(?, timezone),
        updated_at = ?
      WHERE id = ?
    `).run(
      birthdayMmdd,
      birthdayName,
      bias,
      timezone,
      new Date().toISOString(),
      existing.id
    );
  } else {
    db.prepare(`
      INSERT INTO birthday_profiles (
        guild_id, user_id, celebration_enabled, birthday_mmdd,
        birthday_name, timezone, bias, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      guildId,
      userId,
      birthdayMmdd,
      birthdayName,
      timezone,
      bias,
      new Date().toISOString(),
      new Date().toISOString()
    );
  }
}

function getBirthdayProfile(guildId, userId) {
  return getDb().prepare(
    "SELECT * FROM birthday_profiles WHERE guild_id = ? AND user_id = ?"
  ).get(guildId, userId) || null;
}

function listBirthdayProfiles(guildId) {
  return getDb().prepare(`
    SELECT * FROM birthday_profiles
    WHERE guild_id = ? AND celebration_enabled = 1
      AND birthday_mmdd IS NOT NULL
    ORDER BY birthday_mmdd, birthday_name
  `).all(guildId);
}

function setBirthdayCustomization(guildId, userId, {
  bias,
  customMessage,
  customImageUrl,
}) {
  return getDb().prepare(`
    UPDATE birthday_profiles SET
      bias = COALESCE(?, bias),
      custom_message = ?,
      custom_image_url = ?,
      updated_at = ?
    WHERE guild_id = ? AND user_id = ?
  `).run(
    bias || null,
    customMessage || null,
    customImageUrl || null,
    new Date().toISOString(),
    guildId,
    userId
  ).changes > 0;
}

function clearBirthdayCustomization(guildId, userId) {
  return getDb().prepare(`
    UPDATE birthday_profiles SET
      custom_message = NULL,
      custom_image_url = NULL,
      updated_at = ?
    WHERE guild_id = ? AND user_id = ?
  `).run(new Date().toISOString(), guildId, userId).changes > 0;
}

function markBirthdayAnnounced(profileId, year, removeAt) {
  const db = getDb();
  const profile = db.prepare(
    "SELECT guild_id, user_id, birthday_mmdd FROM birthday_profiles WHERE id = ?"
  ).get(profileId);
  if (!profile) return;

  db.prepare(`
    UPDATE birthday_profiles SET
      last_announced_year = ?,
      role_remove_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(year, removeAt, new Date().toISOString(), profileId);

  db.prepare(`
    INSERT OR IGNORE INTO birthday_announcement_history (
      guild_id, user_id, birthday_mmdd, announced_at
    ) VALUES (?, ?, ?, ?)
  `).run(
    profile.guild_id,
    profile.user_id,
    profile.birthday_mmdd,
    new Date().toISOString()
  );
}

function listExpiredBirthdayRoles(nowIso) {
  return getDb().prepare(`
    SELECT p.*, s.role_id
    FROM birthday_profiles p
    JOIN birthday_settings s ON s.guild_id = p.guild_id
    WHERE p.role_remove_at IS NOT NULL AND p.role_remove_at <= ?
  `).all(nowIso);
}

function clearBirthdayRoleTimer(profileId) {
  getDb().prepare(
    "UPDATE birthday_profiles SET role_remove_at = NULL, updated_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), profileId);
}

function listBirthdayHistory(guildId, startIso, endIso) {
  return getDb().prepare(`
    SELECT * FROM birthday_announcement_history
    WHERE guild_id = ? AND announced_at >= ? AND announced_at < ?
    ORDER BY announced_at
  `).all(guildId, startIso, endIso);
}

module.exports = {
  saveBirthdaySettings,
  getBirthdaySettings,
  listBirthdaySettings,
  disableBirthdaySettings,
  updateBirthdayRunKey,
  saveWelcomePassBirthdayProfile,
  attachWelcomePassBirthdayProfile,
  upsertBirthdayProfile,
  getBirthdayProfile,
  listBirthdayProfiles,
  setBirthdayCustomization,
  clearBirthdayCustomization,
  markBirthdayAnnounced,
  listExpiredBirthdayRoles,
  clearBirthdayRoleTimer,
  listBirthdayHistory,
};
