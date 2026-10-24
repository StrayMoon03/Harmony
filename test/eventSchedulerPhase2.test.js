const test = require("node:test");
const assert = require("node:assert/strict");
const { GuildScheduledEventStatus } = require("discord.js");
const store = require("../src/stores/eventSchedulerStore");
const { getDb } = require("../src/db/sqlite");
const {
  handleGuildScheduledEventUpdate,
  updateLinkedOneOffCalendarSchedule,
  cancelHarmonyOneOffEvent,
  handleEventSchedulerMessage,
  handleEventSchedulerInteraction,
  calendarAnnouncementItems,
} = require("../src/services/eventSchedulerService");

function linkedEvent(guildId, discordEventId, overrides = {}) {
  const eventId = store.createCalendarEvent({
    guildId, calendarChannelId: "calendar", title: "One-off show", eventDate: "2099-06-10",
    eventAt: "2099-06-10T23:00:00.000Z", eventEndAt: "2099-06-11T01:00:00.000Z",
    eventTimezone: "America/New_York", timezone: "America/New_York", calendarType: "community",
    category: "other", discordEventId, createdBy: "test", ...overrides,
  });
  return store.getEvent(guildId, eventId);
}

function scheduleAnnouncements(event, offset = 3600) {
  store.updateEvent(event.guild_id, event.id, { announcement_offsets: JSON.stringify([offset]) });
  const current = store.getEvent(event.guild_id, event.id);
  const items = calendarAnnouncementItems(current, [offset]);
  store.saveEventAnnouncements(event.guild_id, event.id, "announcements", [offset], items);
  return items[0].scheduledFor;
}

function managerInteraction({ customId, kind, guildId, values = [], fields = {}, client = {}, guild = null }) {
  const responses = [];
  return {
    customId, guildId, user: { id: "admin" }, memberPermissions: { has: () => true }, values, client, guild, responses,
    fields: { getTextInputValue: (name) => fields[name] || "" },
    isButton: () => kind === "button", isStringSelectMenu: () => kind === "select", isModalSubmit: () => kind === "modal",
    reply: async (payload) => responses.push({ type: "reply", payload }),
    update: async (payload) => responses.push({ type: "update", payload }),
    showModal: async (modal) => responses.push({ type: "modal", modal }),
  };
}

test("Discord one-off date/time edit updates Harmony local date and rebuilds generated schedules only", async () => {
  const guildId = `phase2-discord-edit-${Date.now()}`;
  const discordEventId = `${guildId}-native`;
  let before = linkedEvent(guildId, discordEventId);
  const oldScheduledFor = scheduleAnnouncements(before);
  before = store.getEvent(guildId, before.id);
  const generated = getDb().prepare("SELECT id, scheduled_for, message, origin FROM scheduled_announcements WHERE event_id = ? AND status = 'pending'").get(before.id);
  const manualAt = "2099-06-09T12:00:00.000Z";
  store.addAnnouncement(guildId, before.id, manualAt, "custom/manual notice");
  store.saveDiscordEventReminder(guildId, discordEventId, "user-a", [3600, 86400], "2099-06-10T22:00:00.000Z");
  store.saveDiscordEventReminder(guildId, discordEventId, "user-b", [259200], "2099-06-07T23:00:00.000Z");
  const db = getDb();
  db.prepare("UPDATE discord_event_reminder_schedules SET status = 'sent' WHERE guild_id = ? AND discord_event_id = ? AND user_id = 'user-a' AND reminder_offset_seconds = 86400").run(guildId, discordEventId);
  db.prepare("UPDATE discord_event_reminder_schedules SET status = 'cancelled' WHERE guild_id = ? AND discord_event_id = ? AND user_id = 'user-b'").run(guildId, discordEventId);
  const unrelated = linkedEvent(guildId, `${guildId}-unrelated`, { title: "Other", eventDate: "2099-06-12", eventAt: "2099-06-12T20:00:00.000Z" });
  store.saveDiscordEventReminder(guildId, unrelated.discord_event_id, "unrelated-user", 3600, "2099-06-12T19:00:00.000Z");

  const oldNative = { guildId, id: discordEventId, name: "One-off show", scheduledStartAt: new Date(before.event_at), scheduledEndAt: new Date(before.event_end_at), status: GuildScheduledEventStatus.Scheduled };
  const nextNative = { ...oldNative, scheduledStartAt: new Date("2099-06-11T02:30:00.000Z"), scheduledEndAt: new Date("2099-06-11T04:30:00.000Z") };
  await handleGuildScheduledEventUpdate({ guilds: { cache: new Map(), fetch: async () => null } }, oldNative, nextNative);
  const rowsAfterFirstDelivery = db.prepare("SELECT id, status, scheduled_for FROM scheduled_announcements WHERE event_id = ? ORDER BY id").all(before.id);
  await handleGuildScheduledEventUpdate({ guilds: { cache: new Map(), fetch: async () => null } }, oldNative, nextNative);
  assert.deepEqual(db.prepare("SELECT id, status, scheduled_for FROM scheduled_announcements WHERE event_id = ? ORDER BY id").all(before.id), rowsAfterFirstDelivery);

  const updated = store.getEvent(guildId, before.id);
  assert.equal(updated.event_at, nextNative.scheduledStartAt.toISOString());
  assert.equal(updated.event_end_at, nextNative.scheduledEndAt.toISOString());
  assert.equal(updated.event_date, "2099-06-10"); // 10:30 PM in the event's existing America/New_York timezone.
  const rows = db.prepare("SELECT scheduled_for, message, origin, status FROM scheduled_announcements WHERE event_id = ? ORDER BY id").all(before.id);
  assert.equal(rows.find((row) => row.origin === "generated" && row.status === "cancelled").scheduled_for, oldScheduledFor);
  assert.ok(rows.some((row) => row.origin === "manual" && row.status === "pending" && row.scheduled_for === manualAt && row.message === "custom/manual notice"));
  assert.ok(rows.some((row) => row.origin === "generated" && row.status === "pending" && row.scheduled_for === "2099-06-11T01:30:00.000Z"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM scheduled_announcements WHERE event_id = ? AND status = 'pending' AND scheduled_for = ?").get(before.id, oldScheduledFor).n, 0);

  const reminders = db.prepare("SELECT user_id, reminder_offset_seconds, remind_at, status FROM discord_event_reminder_schedules WHERE guild_id = ? AND discord_event_id = ? ORDER BY user_id, reminder_offset_seconds").all(guildId, discordEventId);
  assert.equal(reminders.find((row) => row.user_id === "user-a" && row.reminder_offset_seconds === 3600).remind_at, "2099-06-11T01:30:00.000Z");
  assert.equal(reminders.find((row) => row.user_id === "user-a" && row.reminder_offset_seconds === 86400).status, "sent");
  assert.equal(reminders.find((row) => row.user_id === "user-b").status, "cancelled");
  assert.equal(db.prepare("SELECT remind_at FROM discord_event_reminder_schedules WHERE guild_id = ? AND discord_event_id = ?").get(guildId, unrelated.discord_event_id).remind_at, "2099-06-12T19:00:00.000Z");
});

test("Schedule Manager one-off timed edit safely rebuilds generated announcements", async () => {
  const guildId = `phase2-manager-edit-${Date.now()}`;
  const discordEventId = `${guildId}-native`;
  const eventId = store.createCalendarEvent({
    guildId, calendarChannelId: "calendar", title: "Manager timed edit", eventDate: "2099-08-10",
    eventAt: "2099-08-10T20:00:00.000Z", eventEndAt: "2099-08-10T22:00:00.000Z",
    eventTimezone: "America/New_York", timezone: "America/New_York", calendarType: "stray_kids",
    category: "concert", discordEventId, announcementOffsets: [3600], createdBy: "admin",
  });
  const event = store.getEvent(guildId, eventId);
  const oldTime = new Date(new Date(event.event_at).getTime() - 3600 * 1000).toISOString();
  store.saveEventAnnouncements(guildId, eventId, "announcements", [3600], [{ scheduledFor: oldTime, message: "generated before manager edit" }]);
  store.addAnnouncement(guildId, eventId, "2099-08-09T12:00:00.000Z", "manual manager notice");
  const edits = [];
  const native = { id: discordEventId, entityType: 3, edit: async (payload) => edits.push(payload) };
  const guild = { scheduledEvents: { cache: new Map([[discordEventId, native]]), fetch: async () => native } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };

  await handleEventSchedulerInteraction(managerInteraction({ customId: "harmony-manager:stray_kids:edit", kind: "button", guildId, client, guild }));
  await handleEventSchedulerInteraction(managerInteraction({ customId: "harmony-manager:stray_kids:editselect", kind: "select", guildId, values: [String(eventId)], client, guild }));
  await handleEventSchedulerInteraction(managerInteraction({
    customId: `harmony-manager:stray_kids:editmodal:${eventId}`, kind: "modal", guildId, client, guild,
    fields: { title: event.title, "event-date": "2099-08-11", "event-time": "19:00", location: "", description: "" },
  }));
  await handleEventSchedulerInteraction(managerInteraction({ customId: `harmony-manager:stray_kids:skzedittimezone:${eventId}`, kind: "select", guildId, values: ["America/New_York"], client, guild }));

  const updated = store.getEvent(guildId, eventId);
  assert.equal(updated.event_at, "2099-08-11T23:00:00.000Z");
  assert.equal(edits.length, 1);
  assert.ok(getDb().prepare("SELECT 1 FROM scheduled_announcements WHERE event_id = ? AND origin = 'generated' AND status = 'cancelled' AND scheduled_for = ?").get(eventId, oldTime));
  assert.ok(getDb().prepare("SELECT 1 FROM scheduled_announcements WHERE event_id = ? AND origin = 'generated' AND status = 'pending' AND scheduled_for = '2099-08-11T22:00:00.000Z'").get(eventId));
  assert.ok(getDb().prepare("SELECT 1 FROM scheduled_announcements WHERE event_id = ? AND origin = 'manual' AND status = 'pending' AND message = 'manual manager notice'").get(eventId));
});

test("Discord edit cancels recalculated reminders already in the past and preserves unknown custom rows", async () => {
  const guildId = `phase2-past-reminder-${Date.now()}`;
  const discordEventId = `${guildId}-native`;
  let before = linkedEvent(guildId, discordEventId);
  const oldScheduledFor = scheduleAnnouncements(before);
  before = store.getEvent(guildId, before.id);
  const db = getDb();
  db.prepare("UPDATE scheduled_announcements SET origin = 'unknown' WHERE event_id = ? AND origin = 'generated'").run(before.id);
  db.prepare("INSERT INTO scheduled_announcements (event_id, scheduled_for, message, origin, status, created_at) VALUES (?, ?, ?, 'unknown', 'pending', ?)")
    .run(before.id, "2099-06-09T12:00:00.000Z", "unclassified historical custom row", new Date().toISOString());
  store.addAnnouncement(guildId, before.id, "2099-06-09T12:00:00.000Z", "manual custom");
  store.saveDiscordEventReminder(guildId, discordEventId, "user", 86400, "2099-06-09T22:00:00.000Z");
  const pastNow = new Date("2099-06-11T00:00:00.000Z");
  const after = { ...before, event_at: "2099-06-11T20:00:00.000Z", event_end_at: "2099-06-11T22:00:00.000Z", event_date: "2099-06-11" };
  await updateLinkedOneOffCalendarSchedule(null, before, after, { now: pastNow });
  assert.equal(db.prepare("SELECT status FROM scheduled_announcements WHERE event_id = ? AND origin = 'unknown' AND scheduled_for = ?").get(before.id, oldScheduledFor).status, "cancelled");
  assert.equal(db.prepare("SELECT status FROM scheduled_announcements WHERE event_id = ? AND origin = 'unknown' AND message = 'unclassified historical custom row'").get(before.id).status, "pending");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM scheduled_announcements WHERE event_id = ? AND origin = 'generated' AND status = 'pending' AND scheduled_for = ?").get(before.id, oldScheduledFor).n, 0);
  assert.ok(db.prepare("SELECT 1 FROM scheduled_announcements WHERE event_id = ? AND origin = 'manual' AND status = 'pending' AND message = 'manual custom'").get(before.id));
  assert.equal(db.prepare("SELECT status FROM discord_event_reminder_schedules WHERE guild_id = ? AND discord_event_id = ? AND user_id = 'user'").get(guildId, discordEventId).status, "cancelled");
});

test("Harmony one-off cancellation performs local cleanup before attempting Discord and is idempotent", async () => {
  const guildId = `phase2-cancel-${Date.now()}`;
  const discordEventId = `${guildId}-native`;
  const event = linkedEvent(guildId, discordEventId);
  store.addAnnouncement(guildId, event.id, "2099-06-09T12:00:00.000Z", "custom");
  store.saveDiscordEventReminder(guildId, discordEventId, "user", 3600, "2099-06-10T22:00:00.000Z");
  let nativeFetches = 0;
  const guild = { scheduledEvents: { cache: new Map(), fetch: async () => { nativeFetches++; throw new Error("Discord unavailable"); } } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  const first = await cancelHarmonyOneOffEvent({ guildId, eventId: event.id, cancelledBy: "admin", client, guild });
  const second = await cancelHarmonyOneOffEvent({ guildId, eventId: event.id, cancelledBy: "admin", client, guild });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.ok(store.getEventByDiscordIdIncludingCancelled(guildId, discordEventId).cancelled_at);
  assert.equal(getDb().prepare("SELECT status FROM scheduled_announcements WHERE event_id = ? AND message = 'custom'").get(event.id).status, "cancelled");
  assert.equal(getDb().prepare("SELECT status FROM discord_event_reminder_schedules WHERE guild_id = ? AND discord_event_id = ?").get(guildId, discordEventId).status, "cancelled");
  assert.equal(nativeFetches, 1);
});

test("HARMONY EVENT CANCEL uses the shared one-off cancellation path", async () => {
  const guildId = `phase2-text-cancel-${Date.now()}`;
  const discordEventId = `${guildId}-native`;
  const event = linkedEvent(guildId, discordEventId);
  store.addAnnouncement(guildId, event.id, "2099-06-09T12:00:00.000Z", "text command custom");
  store.saveDiscordEventReminder(guildId, discordEventId, "user", 3600, "2099-06-10T22:00:00.000Z");
  const guild = { id: guildId, scheduledEvents: { cache: new Map(), fetch: async () => { throw new Error("offline"); } } };
  const replies = [];
  const message = {
    guild, guildId, client: { guilds: { cache: new Map([[guildId, guild]]) } },
    author: { id: "admin", bot: false }, member: { permissions: { has: () => true } },
    content: `HARMONY EVENT CANCEL ${event.id}`,
    reply: async (payload) => replies.push(payload),
  };
  assert.equal(await handleEventSchedulerMessage(message), true);
  assert.match(replies[0].content, /Cancelled event/);
  assert.ok(store.getEventByDiscordIdIncludingCancelled(guildId, discordEventId).cancelled_at);
  assert.equal(getDb().prepare("SELECT status FROM scheduled_announcements WHERE event_id = ?").get(event.id).status, "cancelled");
  assert.equal(getDb().prepare("SELECT status FROM discord_event_reminder_schedules WHERE guild_id = ? AND discord_event_id = ?").get(guildId, discordEventId).status, "cancelled");
});
