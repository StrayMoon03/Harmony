const { getDb } = require("../db/sqlite");

const CODE_PATTERN = /^YS-[A-Z0-9]{8}$/;
const DEFAULT_RELEASE_MESSAGE =
  "✨ Your Welcome Pass is approved, {member}! The doors are open—you’re officially free to explore the rest of Youtiful Stay. Have fun finding your favorite room! 💜";

function normalizeWelcomePassCode(value) {
  return String(value || "").trim().toUpperCase();
}

function isValidWelcomePassCode(value) {
  return CODE_PATTERN.test(normalizeWelcomePassCode(value));
}

function renderWelcomePassReleaseMessage(template, values) {
  return String(template || DEFAULT_RELEASE_MESSAGE)
    .replaceAll("{member}", values.memberMention)
    .replaceAll("{name}", values.memberName)
    .replaceAll("{server}", values.serverName);
}

function saveWelcomePassSettings({
  guildId,
  roleId,
  channelId,
  releaseChannelId,
  releaseMessage,
}) {
  getDb().prepare(`
    INSERT INTO welcome_pass_settings (
      guild_id,
      role_id,
      channel_id,
      release_channel_id,
      release_message,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      role_id = excluded.role_id,
      channel_id = excluded.channel_id,
      release_channel_id = excluded.release_channel_id,
      release_message = excluded.release_message,
      updated_at = excluded.updated_at
  `).run(
    guildId,
    roleId,
    channelId,
    releaseChannelId,
    releaseMessage || DEFAULT_RELEASE_MESSAGE,
    new Date().toISOString()
  );
}

function getWelcomePassSettings(guildId) {
  return getDb().prepare(
    "SELECT * FROM welcome_pass_settings WHERE guild_id = ?"
  ).get(guildId) || null;
}

function listWelcomePassSettings() {
  return getDb().prepare(
    "SELECT * FROM welcome_pass_settings ORDER BY guild_id"
  ).all();
}

function setWelcomePassGrantMode(guildId, mode) {
  if (!["automatic", "manual"].includes(mode)) {
    throw new Error("Invalid Welcome Pass grant mode.");
  }
  const result = getDb().prepare(`
    UPDATE welcome_pass_settings
    SET grant_mode = ?, updated_at = ?
    WHERE guild_id = ?
  `).run(mode, new Date().toISOString(), guildId);
  return result.changes > 0;
}

function linkWelcomePassCode({ code, guildId, userId }) {
  const normalizedCode = normalizeWelcomePassCode(code);
  const db = getDb();
  const existingCode = db.prepare(
    "SELECT * FROM welcome_pass_links WHERE code = ?"
  ).get(normalizedCode);

  if (
    existingCode &&
    (existingCode.guild_id !== guildId || existingCode.user_id !== userId)
  ) {
    return { ok: false, reason: "claimed" };
  }

  const existingUser = db.prepare(
    "SELECT * FROM welcome_pass_links WHERE guild_id = ? AND user_id = ?"
  ).get(guildId, userId);

  if (existingUser && existingUser.code !== normalizedCode) {
    if (existingUser.assigned_at) {
      return { ok: false, reason: "already_assigned" };
    }
    db.prepare("DELETE FROM welcome_pass_links WHERE code = ?")
      .run(existingUser.code);
  }

  db.prepare(`
    INSERT INTO welcome_pass_links (
      code, guild_id, user_id, linked_at, assigned_at
    ) VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(code) DO UPDATE SET
      guild_id = excluded.guild_id,
      user_id = excluded.user_id
  `).run(normalizedCode, guildId, userId, new Date().toISOString());

  return { ok: true, code: normalizedCode };
}

function recordWelcomePassApproval({ code, approverName }) {
  const normalizedCode = normalizeWelcomePassCode(code);
  getDb().prepare(`
    INSERT INTO welcome_pass_approvals (
      code, approver_name, approved_at
    ) VALUES (?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      approver_name = excluded.approver_name
  `).run(
    normalizedCode,
    String(approverName || "Welcome Pass admin").slice(0, 100),
    new Date().toISOString()
  );
  return normalizedCode;
}

function getWelcomePassAssignment(code) {
  return getDb().prepare(`
    SELECT
      a.code,
      a.approver_name,
      a.approved_at,
      l.guild_id,
      l.user_id,
      l.linked_at,
      l.assigned_at
    FROM welcome_pass_approvals a
    LEFT JOIN welcome_pass_links l ON l.code = a.code
    WHERE a.code = ?
  `).get(normalizeWelcomePassCode(code)) || null;
}

function listPendingWelcomePassApprovals() {
  return getDb().prepare(`
    SELECT a.code
    FROM welcome_pass_approvals a
    LEFT JOIN welcome_pass_links l ON l.code = a.code
    WHERE l.assigned_at IS NULL
  `).all();
}

function markWelcomePassAssigned(code) {
  getDb().prepare(
    "UPDATE welcome_pass_links SET assigned_at = ? WHERE code = ?"
  ).run(new Date().toISOString(), normalizeWelcomePassCode(code));
}

module.exports = {
  DEFAULT_RELEASE_MESSAGE,
  normalizeWelcomePassCode,
  isValidWelcomePassCode,
  renderWelcomePassReleaseMessage,
  saveWelcomePassSettings,
  getWelcomePassSettings,
  listWelcomePassSettings,
  setWelcomePassGrantMode,
  linkWelcomePassCode,
  recordWelcomePassApproval,
  getWelcomePassAssignment,
  listPendingWelcomePassApprovals,
  markWelcomePassAssigned,
};
