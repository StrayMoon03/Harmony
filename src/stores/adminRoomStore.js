const { randomBytes } = require("node:crypto");
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

function getDelivery(guildId, kind) {
  return getDb().prepare(`
    SELECT * FROM admin_room_message_deliveries WHERE guild_id = ? AND kind = ?
  `).get(guildId, kind);
}

function beginDelivery(guildId, kind, channelId, afterMessageId) {
  getDb().prepare(`
    INSERT INTO admin_room_message_deliveries (guild_id, kind, channel_id, token, after_message_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, kind) DO NOTHING
  `).run(guildId, kind, channelId, randomBytes(12).toString("hex"), afterMessageId);
  return getDelivery(guildId, kind);
}

function finishDelivery(delivery, messageId) {
  getDb().prepare(`
    UPDATE admin_room_message_deliveries SET message_id = ?
    WHERE guild_id = ? AND kind = ? AND token = ?
  `).run(messageId, delivery.guild_id, delivery.kind, delivery.token);
}

function clearDelivery(delivery) {
  getDb().prepare(`
    DELETE FROM admin_room_message_deliveries WHERE guild_id = ? AND kind = ? AND token = ?
  `).run(delivery.guild_id, delivery.kind, delivery.token);
}

module.exports = {
  getPanel, getEnabledPanels, savePanel, setEnabled,
  getDelivery, beginDelivery, finishDelivery, clearDelivery,
};
