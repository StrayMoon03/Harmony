const { getDb } = require("../db/sqlite");

const DEFAULT_ENTRANCE_MESSAGE =
  "✨ Everyone welcome {member} to {server}! We’re so happy you found your way here. 💜";
const DEFAULT_EXIT_MESSAGE =
  "👋 **{name}** has left {server}. We wish them well on their journey. 💜";

function getGreetingSettings(guildId) {
  return (
    getDb()
      .prepare(
        "SELECT * FROM greeting_settings WHERE guild_id = ? LIMIT 1"
      )
      .get(guildId) ?? null
  );
}

function saveGreetingSettings({
  guildId,
  channelId,
  entranceMessage,
  exitMessage,
}) {
  getDb()
    .prepare(
      `INSERT INTO greeting_settings (
        guild_id, channel_id, enabled, entrance_message,
        exit_message, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        enabled = 1,
        entrance_message = excluded.entrance_message,
        exit_message = excluded.exit_message,
        updated_at = excluded.updated_at`
    )
    .run(
      guildId,
      channelId,
      entranceMessage || DEFAULT_ENTRANCE_MESSAGE,
      exitMessage || DEFAULT_EXIT_MESSAGE,
      new Date().toISOString()
    );
}

function disableGreetingSettings(guildId) {
  const result = getDb()
    .prepare(
      "UPDATE greeting_settings SET enabled = 0, updated_at = ? WHERE guild_id = ?"
    )
    .run(new Date().toISOString(), guildId);

  return Number(result.changes) > 0;
}

function updateGreetingSetting(guildId, field, value) {
  const columns = {
    channelId: "channel_id",
    entranceMessage: "entrance_message",
    exitMessage: "exit_message",
  };
  const column = columns[field];
  if (!column) throw new Error("Invalid greeting setting.");
  const nextValue = String(value || "").trim();
  if (!nextValue) throw new Error("Choose a valid greeting setting.");
  return Number(getDb().prepare(`
    UPDATE greeting_settings SET ${column} = ?, updated_at = ?
    WHERE guild_id = ?
  `).run(nextValue, new Date().toISOString(), guildId).changes) > 0;
}

function setGreetingEnabled(guildId, enabled) {
  const result = getDb().prepare(`
    UPDATE greeting_settings SET enabled = ?, updated_at = ?
    WHERE guild_id = ?
  `).run(enabled ? 1 : 0, new Date().toISOString(), guildId);
  return Number(result.changes) > 0;
}

function renderGreetingMessage(
  template,
  { memberMention = "", memberName = "A member", serverName }
) {
  return String(template)
    .replaceAll("{member}", memberMention || memberName)
    .replaceAll("{name}", memberName)
    .replaceAll("{server}", serverName);
}

module.exports = {
  DEFAULT_ENTRANCE_MESSAGE,
  DEFAULT_EXIT_MESSAGE,
  getGreetingSettings,
  saveGreetingSettings,
  disableGreetingSettings,
  updateGreetingSetting,
  setGreetingEnabled,
  renderGreetingMessage,
};
