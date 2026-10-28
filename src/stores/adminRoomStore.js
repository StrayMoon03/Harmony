const { getDb } = require("../db/sqlite");

function getPanel(guildId) {
  return getDb().prepare("SELECT * FROM admin_room_panels WHERE guild_id = ?").get(guildId) || null;
}

function getEnabledPanels() {
  return getDb().prepare("SELECT * FROM admin_room_panels WHERE enabled = 1").all();
}

function savePanel({ guildId, channelId, messageId, enabled = true }) {
  getDb().prepare(`
    INSERT INTO admin_room_panels (guild_id, channel_id, message_id, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      message_id = excluded.message_id,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(guildId, channelId, messageId, enabled ? 1 : 0, new Date().toISOString());
  return getPanel(guildId);
}

function setEnabled(guildId, enabled) {
  const changed = getDb().prepare(`
    UPDATE admin_room_panels SET enabled = ?, updated_at = ? WHERE guild_id = ?
  `).run(enabled ? 1 : 0, new Date().toISOString(), guildId).changes;
  return Number(changed) > 0;
}

module.exports = { getPanel, getEnabledPanels, savePanel, setEnabled };
