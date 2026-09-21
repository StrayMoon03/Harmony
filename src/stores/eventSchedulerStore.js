const { getDb } = require("../db/sqlite");

function createEvent({ guildId, sourceChannelId, destinationChannelId, title, link, timezone, createdBy, announcements }) {
  const db = getDb();
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`
      INSERT INTO scheduled_events (
        guild_id, source_channel_id, destination_channel_id, title,
        link, timezone, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(guildId, sourceChannelId, destinationChannelId, title, link, timezone, createdBy, now);
    const eventId = Number(result.lastInsertRowid);
    const insert = db.prepare(`
      INSERT INTO scheduled_announcements (
        event_id, scheduled_for, message, status, created_at
      ) VALUES (?, ?, ?, 'pending', ?)
    `);
    for (const item of announcements) {
      insert.run(eventId, item.scheduledFor, item.message, now);
    }
    db.exec("COMMIT");
    return eventId;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getEvent(guildId, eventId) {
  return getDb().prepare(`
    SELECT e.*, COUNT(a.id) AS announcement_count,
      SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END) AS pending_count
    FROM scheduled_events e
    LEFT JOIN scheduled_announcements a ON a.event_id = e.id
    WHERE e.guild_id = ? AND e.id = ? AND e.cancelled_at IS NULL
    GROUP BY e.id
  `).get(guildId, eventId);
}

function listAnnouncements(eventId) {
  return getDb().prepare(`
    SELECT * FROM scheduled_announcements
    WHERE event_id = ? AND status = 'pending'
    ORDER BY scheduled_for, id
  `).all(eventId);
}

function addAnnouncement(guildId, eventId, scheduledFor, message) {
  const db = getDb();
  const event = getEvent(guildId, eventId);
  if (!event) return { ok: false, reason: "missing" };
  if (Number(event.pending_count || 0) >= 12) return { ok: false, reason: "limit" };
  const duplicate = db.prepare(`
    SELECT id FROM scheduled_announcements
    WHERE event_id = ? AND scheduled_for = ? AND message = ? AND status = 'pending'
  `).get(eventId, scheduledFor, message);
  if (duplicate) return { ok: false, reason: "duplicate" };
  const result = db.prepare(`
    INSERT INTO scheduled_announcements (
      event_id, scheduled_for, message, status, created_at
    ) VALUES (?, ?, ?, 'pending', ?)
  `).run(eventId, scheduledFor, message, new Date().toISOString());
  return { ok: true, id: Number(result.lastInsertRowid) };
}

function listEvents(guildId, limit = 20) {
  return getDb().prepare(`
    SELECT e.*, COUNT(a.id) AS announcement_count,
      SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END) AS pending_count
    FROM scheduled_events e
    JOIN scheduled_announcements a ON a.event_id = e.id
    WHERE e.guild_id = ? AND e.cancelled_at IS NULL
    GROUP BY e.id
    HAVING pending_count > 0
    ORDER BY MIN(CASE WHEN a.status = 'pending' THEN a.scheduled_for END)
    LIMIT ?
  `).all(guildId, limit);
}

function cancelEvent(guildId, eventId, cancelledBy) {
  const db = getDb();
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const changed = db.prepare(`
      UPDATE scheduled_events
      SET cancelled_at = ?, cancelled_by = ?
      WHERE id = ? AND guild_id = ? AND cancelled_at IS NULL
    `).run(now, cancelledBy, eventId, guildId).changes;
    if (changed) {
      db.prepare(`
        UPDATE scheduled_announcements
        SET status = 'cancelled'
        WHERE event_id = ? AND status = 'pending'
      `).run(eventId);
    }
    db.exec("COMMIT");
    return changed > 0;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function dueAnnouncements(nowIso, limit = 25) {
  return getDb().prepare(`
    SELECT a.*, e.guild_id, e.destination_channel_id, e.title, e.link
    FROM scheduled_announcements a
    JOIN scheduled_events e ON e.id = a.event_id
    WHERE a.status = 'pending'
      AND a.scheduled_for <= ?
      AND e.cancelled_at IS NULL
    ORDER BY a.scheduled_for, a.id
    LIMIT ?
  `).all(nowIso, limit);
}

function markSending(id) {
  return getDb().prepare(`
    UPDATE scheduled_announcements
    SET status = 'sending', attempted_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(new Date().toISOString(), id).changes > 0;
}

function markSent(id, discordMessageId) {
  getDb().prepare(`
    UPDATE scheduled_announcements
    SET status = 'sent', sent_at = ?, discord_message_id = ?, last_error = NULL
    WHERE id = ? AND status = 'sending'
  `).run(new Date().toISOString(), discordMessageId, id);
}

function markFailed(id, error) {
  getDb().prepare(`
    UPDATE scheduled_announcements
    SET status = 'pending', last_error = ?
    WHERE id = ? AND status = 'sending'
  `).run(String(error || "Unknown send error").slice(0, 500), id);
}

module.exports = {
  createEvent,
  getEvent,
  listAnnouncements,
  addAnnouncement,
  listEvents,
  cancelEvent,
  dueAnnouncements,
  markSending,
  markSent,
  markFailed,
};
