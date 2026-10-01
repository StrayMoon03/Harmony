const { getDb } = require("../db/sqlite");

function createEvent({ guildId, sourceChannelId, destinationChannelId, title, link, timezone, eventAt, eventDate, eventTimezone, eventLocation, calendarType, category, allDay = false, description, createdBy, announcements }) {
  const db = getDb();
  const now = new Date().toISOString();
  // The legacy announcement column is NOT NULL, but calendar-only all-day
  // events do not need a timezone. Keep that legacy column valid without
  // inventing an event timezone; event_timezone remains nullable metadata.
  const storedTimezone = timezone || "America/New_York";
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`
      INSERT INTO scheduled_events (
        guild_id, source_channel_id, destination_channel_id, title,
        link, timezone, calendar_type, event_at, event_date, event_timezone, event_location, description, category, all_day, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(guildId, sourceChannelId, destinationChannelId, title, link, storedTimezone, calendarType || null, eventAt || null, eventDate || null, eventTimezone === undefined ? storedTimezone : eventTimezone, eventLocation || null, description || null, category || null, allDay ? 1 : 0, createdBy, now);
    const eventId = Number(result.lastInsertRowid);
    const insert = db.prepare(`
      INSERT INTO scheduled_announcements (
        event_id, scheduled_for, message, status, created_at
      ) VALUES (?, ?, ?, 'pending', ?)
    `);
    for (const item of announcements || []) {
      insert.run(eventId, item.scheduledFor, item.message, now);
    }
    db.exec("COMMIT");
    return eventId;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createCalendarEvent({ guildId, calendarChannelId, title, link = "", timezone = "America/New_York", eventAt = null, eventDate, eventTimezone = timezone, eventLocation = null, calendarType, category, allDay = false, description = null, createdBy }) {
  return createEvent({
    guildId,
    sourceChannelId: calendarChannelId || "",
    destinationChannelId: calendarChannelId || "",
    title,
    link: link || "",
    timezone,
    eventAt,
    eventDate,
    eventTimezone,
    eventLocation,
    calendarType,
    category,
    allDay,
    description,
    createdBy,
    announcements: [],
  });
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

function setCalendarChannels(guildId, strayKidsChannelId, communityChannelId) {
  getDb().prepare(`
    INSERT INTO calendar_settings (guild_id, stray_kids_channel_id, community_channel_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      stray_kids_channel_id = excluded.stray_kids_channel_id,
      community_channel_id = excluded.community_channel_id,
      updated_at = excluded.updated_at
  `).run(guildId, strayKidsChannelId || null, communityChannelId || null, new Date().toISOString());
}

function getCalendarChannels(guildId) {
  return getDb().prepare("SELECT * FROM calendar_settings WHERE guild_id = ?").get(guildId) || null;
}

function setManagerChannel(guildId, managerChannelId) {
  getDb().prepare(`
    INSERT INTO calendar_settings (guild_id, manager_channel_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      manager_channel_id = excluded.manager_channel_id,
      updated_at = excluded.updated_at
  `).run(guildId, managerChannelId || null, new Date().toISOString());
}

function getManagerChannel(guildId) {
  return getDb().prepare("SELECT manager_channel_id FROM calendar_settings WHERE guild_id = ?").get(guildId)?.manager_channel_id || null;
}

function listCalendarEvents(guildId, calendarType, monthStart, monthEnd) {
  return getDb().prepare(`
    SELECT * FROM scheduled_events
    WHERE guild_id = ? AND calendar_type = ? AND cancelled_at IS NULL
      AND (event_at >= ? AND event_at < ? OR event_date >= substr(?, 1, 10) AND event_date < substr(?, 1, 10))
    ORDER BY COALESCE(event_date, substr(event_at, 1, 10)), event_at, id
  `).all(guildId, calendarType, monthStart, monthEnd, monthStart, monthEnd);
}

function listPublishedCalendars(guildId, calendarType, monthKey) {
  return getDb().prepare(`SELECT * FROM calendar_publications WHERE guild_id = ? AND calendar_type = ? AND month_key = ? ORDER BY part_index`).all(guildId, calendarType, monthKey);
}

function savePublishedCalendar(guildId, calendarType, monthKey, partIndex, channelId, messageId) {
  getDb().prepare(`
    INSERT INTO calendar_publications (guild_id, calendar_type, month_key, part_index, channel_id, message_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, calendar_type, month_key, part_index) DO UPDATE SET
      channel_id = excluded.channel_id, message_id = excluded.message_id, updated_at = excluded.updated_at
  `).run(guildId, calendarType, monthKey, partIndex, channelId, messageId, new Date().toISOString());
}

function removePublishedCalendarPart(guildId, calendarType, monthKey, partIndex) {
  getDb().prepare(`DELETE FROM calendar_publications WHERE guild_id = ? AND calendar_type = ? AND month_key = ? AND part_index = ?`).run(guildId, calendarType, monthKey, partIndex);
}

function removePublishedCalendars(guildId, calendarType, monthKey) {
  getDb().prepare(`DELETE FROM calendar_publications WHERE guild_id = ? AND calendar_type = ? AND month_key = ?`).run(guildId, calendarType, monthKey);
}

function hasPublishedCalendar(guildId, calendarType, monthKey) {
  return Boolean(getDb().prepare(`SELECT 1 FROM calendar_publications WHERE guild_id = ? AND calendar_type = ? AND month_key = ? LIMIT 1`).get(guildId, calendarType, monthKey));
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

function updateEvent(guildId, eventId, changes) {
  const event = getEvent(guildId, eventId);
  if (!event) return null;
  const allowed = ["title", "calendar_type", "event_at", "event_date", "event_timezone", "event_location", "timezone", "description", "category", "all_day", "link"];
  const fields = allowed.filter((field) => Object.prototype.hasOwnProperty.call(changes, field));
  if (!fields.length) return event;
  const assignments = fields.map((field) => `${field} = ?`).join(", ");
  getDb().prepare(`UPDATE scheduled_events SET ${assignments} WHERE guild_id = ? AND id = ? AND cancelled_at IS NULL`)
    .run(...fields.map((field) => changes[field]), guildId, eventId);
  return getEvent(guildId, eventId);
}

function getManagerPanel(guildId, calendarType) {
  return getDb().prepare("SELECT * FROM calendar_manager_panels WHERE guild_id = ? AND calendar_type = ?").get(guildId, calendarType) || null;
}

function saveManagerPanel(guildId, calendarType, channelId, messageId) {
  getDb().prepare(`
    INSERT INTO calendar_manager_panels (guild_id, calendar_type, channel_id, message_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, calendar_type) DO UPDATE SET
      channel_id = excluded.channel_id, message_id = excluded.message_id, updated_at = excluded.updated_at
  `).run(guildId, calendarType, channelId, messageId, new Date().toISOString());
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
  createCalendarEvent,
  getEvent,
  listAnnouncements,
  addAnnouncement,
  listEvents,
  cancelEvent,
  updateEvent,
  getManagerPanel,
  saveManagerPanel,
  dueAnnouncements,
  markSending,
  markSent,
  markFailed,
  setCalendarChannels,
  getCalendarChannels,
  setManagerChannel,
  getManagerChannel,
  listCalendarEvents,
  listPublishedCalendars,
  savePublishedCalendar,
  removePublishedCalendarPart,
  removePublishedCalendars,
  hasPublishedCalendar,
};
