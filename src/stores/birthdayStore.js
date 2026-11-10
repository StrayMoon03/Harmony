const { getDb } = require("../db/sqlite");
const { normalizeBiases, legacyBiasValue } = require("../services/memberBiases");

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
  discordUsername,
  timezone,
  bias,
  biases,
}) {
  const selections = normalizeBiases(biases === undefined ? bias : biases);
  const selectionsJson = selections.length ? JSON.stringify(selections) : null;
  const legacyBias = legacyBiasValue(selections);
  getDb().prepare(`
    INSERT INTO birthday_profiles (
      welcome_pass_code, celebration_enabled, birthday_mmdd,
      birthday_name, discord_username, timezone, bias, biases_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(welcome_pass_code) DO UPDATE SET
      celebration_enabled = excluded.celebration_enabled,
      birthday_mmdd = excluded.birthday_mmdd,
      birthday_name = excluded.birthday_name,
      discord_username = excluded.discord_username,
      timezone = excluded.timezone,
      bias = excluded.bias,
      biases_json = excluded.biases_json,
      updated_at = excluded.updated_at
  `).run(
    code,
    celebrationEnabled ? 1 : 0,
    celebrationEnabled ? birthdayMmdd : null,
    celebrationEnabled ? birthdayName : null,
    String(discordUsername || "").trim().slice(0, 100) || null,
    celebrationEnabled ? timezone : null,
    legacyBias,
    selectionsJson,
    new Date().toISOString(),
    new Date().toISOString()
  );
}

function listUnlinkedWelcomePassBirthdayProfiles() {
  return getDb().prepare(`
    SELECT * FROM birthday_profiles
    WHERE celebration_enabled = 1
      AND birthday_mmdd IS NOT NULL
      AND welcome_pass_code IS NOT NULL
      AND user_id IS NULL
    ORDER BY birthday_name, welcome_pass_code
  `).all();
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
          celebration_enabled = CASE WHEN ? = 1 THEN 1 ELSE celebration_enabled END,
          birthday_mmdd = CASE WHEN ? = 1 THEN ? ELSE birthday_mmdd END,
          birthday_name = CASE WHEN ? = 1 THEN ? ELSE birthday_name END,
          discord_username = COALESCE(?, discord_username),
          timezone = CASE WHEN ? = 1 THEN ? ELSE timezone END,
          bias = COALESCE(?, bias),
          biases_json = COALESCE(?, biases_json),
          updated_at = ?
        WHERE id = ?
      `).run(
        code,
        pending.celebration_enabled,
        pending.celebration_enabled,
        pending.birthday_mmdd,
        pending.celebration_enabled,
        pending.birthday_name,
        pending.discord_username,
        pending.celebration_enabled,
        pending.timezone,
        pending.bias,
        pending.biases_json,
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
  biases,
  timezone = null,
}) {
  const db = getDb();
  const selections = normalizeBiases(biases === undefined ? bias : biases, { allowEmpty: false });
  const legacyBias = legacyBiasValue(selections);
  const selectionsJson = JSON.stringify(selections);
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
        biases_json = ?,
        timezone = COALESCE(?, timezone),
        updated_at = ?
      WHERE id = ?
    `).run(
      birthdayMmdd,
      birthdayName,
      legacyBias,
      selectionsJson,
      timezone,
      new Date().toISOString(),
      existing.id
    );
  } else {
    db.prepare(`
      INSERT INTO birthday_profiles (
        guild_id, user_id, celebration_enabled, birthday_mmdd,
        birthday_name, timezone, bias, biases_json, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      guildId,
      userId,
      birthdayMmdd,
      birthdayName,
      timezone,
      legacyBias,
      selectionsJson,
      new Date().toISOString(),
      new Date().toISOString()
    );
  }
}

function setMemberBiases(guildId, userId, biases) {
  const selections = normalizeBiases(biases, { allowEmpty: false });
  const legacyBias = legacyBiasValue(selections);
  const selectionsJson = JSON.stringify(selections);
  return Number(getDb().prepare(`
    INSERT INTO birthday_profiles (
      guild_id, user_id, celebration_enabled, bias, biases_json, created_at, updated_at
    ) VALUES (?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      bias = excluded.bias,
      biases_json = excluded.biases_json,
      updated_at = excluded.updated_at
  `).run(guildId, userId, legacyBias, selectionsJson, new Date().toISOString(), new Date().toISOString()).changes) > 0;
}

function listMemberBiasProfiles(guildId) {
  return getDb().prepare(`
    SELECT * FROM birthday_profiles
    WHERE guild_id = ? AND user_id IS NOT NULL
      AND (biases_json IS NOT NULL OR bias IS NOT NULL)
    ORDER BY user_id
  `).all(guildId);
}

function upsertNonDiscordBirthdayProfile({ guildId, birthdayName, birthdayMmdd, timezone, customMessage = null }) {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare(`
    SELECT id FROM birthday_profiles
    WHERE guild_id = ? AND user_id IS NULL AND welcome_pass_code IS NULL
      AND lower(birthday_name) = lower(?)
  `).get(guildId, birthdayName);
  if (existing) {
    db.prepare(`
      UPDATE birthday_profiles SET celebration_enabled = 1,
        birthday_name = ?, birthday_mmdd = ?, timezone = ?, bias = 'Still deciding',
        custom_message = COALESCE(?, custom_message), role_remove_at = NULL,
        updated_at = ? WHERE id = ?
    `).run(birthdayName, birthdayMmdd, timezone, String(customMessage || "").trim() || null, now, existing.id);
    return existing.id;
  }
  const result = db.prepare(`
    INSERT INTO birthday_profiles (
      guild_id, user_id, celebration_enabled, birthday_mmdd, birthday_name,
      timezone, bias, custom_message, created_at, updated_at
    ) VALUES (?, NULL, 1, ?, ?, ?, 'Still deciding', ?, ?, ?)
  `).run(guildId, birthdayMmdd, birthdayName, timezone, String(customMessage || "").trim() || null, now, now);
  return Number(result.lastInsertRowid);
}

function listNonDiscordBirthdayProfiles(guildId) {
  return getDb().prepare(`
    SELECT * FROM birthday_profiles
    WHERE guild_id = ? AND user_id IS NULL AND welcome_pass_code IS NULL
      AND celebration_enabled = 1 AND birthday_mmdd IS NOT NULL
    ORDER BY birthday_mmdd, birthday_name
  `).all(guildId);
}

function getNonDiscordBirthdayProfile(guildId, profileId) {
  return getDb().prepare(`
    SELECT * FROM birthday_profiles
    WHERE guild_id = ? AND id = ? AND user_id IS NULL AND welcome_pass_code IS NULL
  `).get(guildId, profileId) || null;
}

function updateNonDiscordBirthdayProfile(guildId, profileId, { birthdayName, birthdayMmdd, timezone }) {
  return getDb().prepare(`
    UPDATE birthday_profiles SET birthday_name = ?, birthday_mmdd = ?, timezone = ?,
      updated_at = ?
    WHERE guild_id = ? AND id = ? AND user_id IS NULL AND welcome_pass_code IS NULL
  `).run(birthdayName, birthdayMmdd, timezone, new Date().toISOString(), guildId, profileId).changes > 0;
}

function updateNonDiscordBirthdayMessage(guildId, profileId, customMessage) {
  return getDb().prepare(`
    UPDATE birthday_profiles SET custom_message = ?, updated_at = ?
    WHERE guild_id = ? AND id = ? AND user_id IS NULL AND welcome_pass_code IS NULL
  `).run(String(customMessage || "").trim() || null, new Date().toISOString(), guildId, profileId).changes > 0;
}

function deleteNonDiscordBirthdayProfile(guildId, profileId) {
  return getDb().prepare(`
    DELETE FROM birthday_profiles
    WHERE guild_id = ? AND id = ? AND user_id IS NULL AND welcome_pass_code IS NULL
  `).run(guildId, profileId).changes > 0;
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
  biases,
  customMessage,
  customImageUrl,
}) {
  const selections = biases === undefined && bias == null ? null : normalizeBiases(biases === undefined ? bias : biases, { allowEmpty: false });
  return getDb().prepare(`
    UPDATE birthday_profiles SET
      bias = COALESCE(?, bias),
      biases_json = COALESCE(?, biases_json),
      custom_message = ?,
      custom_image_url = ?,
      updated_at = ?
    WHERE guild_id = ? AND user_id = ?
  `).run(
    selections ? legacyBiasValue(selections) : null,
    selections ? JSON.stringify(selections) : null,
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
    "SELECT guild_id, user_id, birthday_mmdd, birthday_name FROM birthday_profiles WHERE id = ?"
  ).get(profileId);
  if (!profile) return;

  db.prepare(`
    UPDATE birthday_profiles SET
      last_announced_year = ?,
      role_remove_at = CASE WHEN user_id IS NULL THEN NULL ELSE ? END,
      updated_at = ?
    WHERE id = ?
  `).run(year, removeAt, new Date().toISOString(), profileId);

  db.prepare(`
    INSERT OR IGNORE INTO birthday_announcement_history (
      guild_id, user_id, birthday_name, birthday_mmdd, announced_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    profile.guild_id,
    profile.user_id,
    profile.birthday_name,
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
  setMemberBiases,
  listMemberBiasProfiles,
  listUnlinkedWelcomePassBirthdayProfiles,
  attachWelcomePassBirthdayProfile,
  upsertBirthdayProfile,
  upsertNonDiscordBirthdayProfile,
  listNonDiscordBirthdayProfiles,
  getNonDiscordBirthdayProfile,
  updateNonDiscordBirthdayProfile,
  updateNonDiscordBirthdayMessage,
  deleteNonDiscordBirthdayProfile,
  getBirthdayProfile,
  listBirthdayProfiles,
  setBirthdayCustomization,
  clearBirthdayCustomization,
  markBirthdayAnnounced,
  listExpiredBirthdayRoles,
  clearBirthdayRoleTimer,
  listBirthdayHistory,
};
