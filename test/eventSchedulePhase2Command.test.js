const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/stores/eventSchedulerStore");
const { getDb } = require("../src/db/sqlite");
const { execute } = require("../src/commands/eventSchedule");
const { handleEventSchedulerInteraction } = require("../src/services/eventSchedulerService");

function makeEvent(guildId, discordEventId) {
  const id = store.createCalendarEvent({
    guildId, calendarChannelId: "calendar", title: "Command edit event", eventDate: "2099-07-01",
    eventAt: "2099-07-01T20:00:00.000Z", eventEndAt: "2099-07-01T22:00:00.000Z",
    eventTimezone: "America/New_York", timezone: "America/New_York", calendarType: "community",
    category: "other", discordEventId, createdBy: "test",
  });
  store.updateEvent(guildId, id, { announcement_offsets: JSON.stringify([3600]) });
  const event = store.getEvent(guildId, id);
  const at = new Date(new Date(event.event_at).getTime() - 3600 * 1000).toISOString();
  store.saveEventAnnouncements(guildId, id, "announcements", [3600], [{ scheduledFor: at, message: "generated old schedule" }]);
  store.addAnnouncement(guildId, id, "2099-06-30T12:00:00.000Z", "manual custom");
  return event;
}

function commandInteraction({ guildId, client, guild, action, eventId, values = {} }) {
  const responses = [];
  return {
    guildId, guild, client, user: { id: "admin" }, memberPermissions: { has: () => true }, responses,
    options: {
      getSubcommand: () => action,
      getInteger: (name) => name === "event" ? eventId : null,
      getString: (name) => values[name] ?? null,
      getBoolean: (name) => values[name] ?? null,
    },
    deferReply: async () => {},
    editReply: async (value) => responses.push(value),
  };
}

test("/harmony-schedule update edits linked Discord time and rebuilds generated schedules without removing manual rows", async () => {
  const guildId = `phase2-slash-update-${Date.now()}`;
  const discordEventId = `${guildId}-native`;
  const event = makeEvent(guildId, discordEventId);
  const oldAt = event.event_at;
  const nativeEdits = [];
  const native = { id: discordEventId, entityType: 3, edit: async (payload) => nativeEdits.push(payload) };
  const guild = { scheduledEvents: { cache: new Map([[discordEventId, native]]), fetch: async () => native } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  const interaction = commandInteraction({ guildId, client, guild, action: "update", eventId: event.id, values: { "event-date": "2099-07-02", "event-time": "19:00", "event-timezone": "America/New_York" } });
  await execute(interaction);
  const updated = store.getEvent(guildId, event.id);
  assert.equal(updated.event_at, "2099-07-02T23:00:00.000Z");
  assert.equal(updated.event_end_at, "2099-07-03T01:00:00.000Z");
  assert.equal(nativeEdits.length, 1);
  assert.equal(nativeEdits[0].scheduledStartTime.toISOString(), updated.event_at);
  assert.ok(getDb().prepare("SELECT 1 FROM scheduled_announcements WHERE event_id = ? AND status = 'cancelled' AND scheduled_for = ? AND origin = 'generated'").get(event.id, new Date(new Date(oldAt).getTime() - 3600 * 1000).toISOString()));
  assert.ok(getDb().prepare("SELECT 1 FROM scheduled_announcements WHERE event_id = ? AND status = 'pending' AND origin = 'generated' AND scheduled_for = '2099-07-02T22:00:00.000Z'").get(event.id));
  assert.ok(getDb().prepare("SELECT 1 FROM scheduled_announcements WHERE event_id = ? AND status = 'pending' AND origin = 'manual' AND message = 'manual custom'").get(event.id));
  assert.match(interaction.responses[0], /Updated event/);
});

test("/harmony-schedule cancel asks for confirmation before running shared cleanup", async () => {
  const guildId = `phase2-slash-cancel-${Date.now()}`;
  const discordEventId = `${guildId}-native`;
  const event = makeEvent(guildId, discordEventId);
  store.saveDiscordEventReminder(guildId, discordEventId, "user", 3600, "2099-07-01T19:00:00.000Z");
  const guild = { scheduledEvents: { cache: new Map(), fetch: async () => { throw new Error("unavailable"); } } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  const interaction = commandInteraction({ guildId, client, guild, action: "cancel", eventId: event.id });
  await execute(interaction);
  assert.equal(interaction.responses[0].components[0].components[0].data.custom_id, `harmony-schedule:cancelconfirm:${event.id}`);
  assert.equal(store.getEventByDiscordIdIncludingCancelled(guildId, discordEventId).cancelled_at, null);
  assert.equal(getDb().prepare("SELECT status FROM scheduled_announcements WHERE event_id = ? AND status = 'pending'").get(event.id).status, "pending");
  const confirm = {
    customId: `harmony-schedule:cancelconfirm:${event.id}`, guildId, guild, client,
    user: { id: "admin" }, memberPermissions: { has: () => true },
    isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false,
    update: async (payload) => interaction.responses.push(payload), reply: async (payload) => interaction.responses.push(payload),
  };
  await handleEventSchedulerInteraction(confirm);
  assert.ok(store.getEventByDiscordIdIncludingCancelled(guildId, discordEventId).cancelled_at);
  assert.equal(getDb().prepare("SELECT status FROM scheduled_announcements WHERE event_id = ? AND status = 'pending'").get(event.id), undefined);
  assert.equal(getDb().prepare("SELECT status FROM discord_event_reminder_schedules WHERE guild_id = ? AND discord_event_id = ?").get(guildId, discordEventId).status, "cancelled");
  assert.match(interaction.responses[1].content, /Cancelled event/);
});
