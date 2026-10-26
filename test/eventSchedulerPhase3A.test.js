const test = require("node:test");
const assert = require("node:assert/strict");
const { GuildScheduledEventStatus } = require("discord.js");
const store = require("../src/stores/eventSchedulerStore");
const { getDb } = require("../src/db/sqlite");
const {
  handleEventSchedulerInteraction,
  handleGuildScheduledEventDelete,
  handleGuildScheduledEventUpdate,
  syncRecurringNativeEventWindow,
} = require("../src/services/eventSchedulerService");
const scheduleCommand = require("../src/commands/eventSchedule");

let nextDateOffset = 20;

function upcomingStart() {
  const date = new Date(Date.now() + nextDateOffset * 24 * 60 * 60 * 1000);
  nextDateOffset += 1;
  date.setUTCHours(20, 0, 0, 0);
  return date;
}

function makeOccurrence(guildId, seriesId, index, discordEventId = null, nativeMode = 1, start = upcomingStart()) {
  const eventAt = new Date(start.getTime() + index * 7 * 24 * 60 * 60 * 1000).toISOString();
  const eventDate = eventAt.slice(0, 10);
  const id = store.createCalendarEvent({
    guildId, calendarChannelId: "calendar", title: "Harmony weekly event", eventDate, eventAt,
    eventEndAt: new Date(new Date(eventAt).getTime() + 60 * 60 * 1000).toISOString(),
    eventTimezone: "UTC", timezone: "UTC", calendarType: "community", category: "community",
    discordEventId, recurrenceSeriesId: seriesId,
    recurrenceRule: JSON.stringify(nativeMode === 2
      ? { source: "discord", anchorAt: eventAt, startAt: eventAt, frequency: 2, interval: 1, byWeekday: [new Date(eventAt).getUTCDay()], count: 4 }
      : { type: "weekly", count: 4 }),
    recurrenceIndex: index, recurrenceNativeEnabled: nativeMode, createdBy: "test-admin",
  });
  return store.getEvent(guildId, id);
}

function insertAnnouncement(eventId, scheduledFor, status, origin = "manual") {
  getDb().prepare(`
    INSERT INTO scheduled_announcements (event_id, scheduled_for, message, origin, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(eventId, scheduledFor, `${origin}-${status}`, origin, status, new Date().toISOString());
}

function addReminderRows(guildId, discordEventId, prefix) {
  store.saveDiscordEventReminder(guildId, discordEventId, `${prefix}-pending`, 3600, "2099-01-01T00:00:00.000Z");
  store.saveDiscordEventReminder(guildId, discordEventId, `${prefix}-sent`, 86400, "2099-01-01T00:00:00.000Z");
  store.saveDiscordEventReminder(guildId, discordEventId, `${prefix}-cancelled`, 259200, "2099-01-01T00:00:00.000Z");
  const db = getDb();
  for (const table of ["discord_event_reminder_schedules", "discord_event_reminders"]) {
    db.prepare(`UPDATE ${table} SET status = 'sent' WHERE guild_id = ? AND discord_event_id = ? AND user_id = ?`).run(guildId, discordEventId, `${prefix}-sent`);
    db.prepare(`UPDATE ${table} SET status = 'cancelled' WHERE guild_id = ? AND discord_event_id = ? AND user_id = ?`).run(guildId, discordEventId, `${prefix}-cancelled`);
  }
}

function eventInteraction(customId, guildId, guild = null) {
  return {
    customId, guildId, user: { id: "admin" },
    memberPermissions: { has: () => true },
    guild,
    client: { guilds: { cache: new Map(guild ? [[guildId, guild]] : []) } },
    isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false,
    update: async () => {}, reply: async () => {},
  };
}

function rawEvent(guildId, eventId) {
  return getDb().prepare("SELECT * FROM scheduled_events WHERE guild_id = ? AND id = ?").get(guildId, eventId);
}

test("slash recurring cancellation confirms scope and cancels only the selected occurrence", async () => {
  const guildId = `phase3a-slash-cancel-${Date.now()}`;
  const seriesId = `${guildId}-series`;
  const rows = [makeOccurrence(guildId, seriesId, 0), makeOccurrence(guildId, seriesId, 1), makeOccurrence(guildId, seriesId, 2)];
  const responses = [];
  await scheduleCommand.execute({
    guildId, user: { id: "admin" }, memberPermissions: { has: () => true },
    options: { getSubcommand: () => "cancel", getInteger: () => rows[1].id },
    deferReply: async () => {}, editReply: async (payload) => responses.push(payload),
  });
  const scopeLabels = responses[0].components[0].components.map((component) => component.data.label);
  assert.deepEqual(scopeLabels, ["This occurrence", "This and future", "Entire series"]);
  await handleEventSchedulerInteraction(eventInteraction(`harmony-schedule:cancelscope:${rows[1].id}:this`, guildId));
  assert.ok(rawEvent(guildId, rows[1].id).cancelled_at);
  assert.equal(rawEvent(guildId, rows[0].id).cancelled_at, null);
  assert.equal(rawEvent(guildId, rows[2].id).cancelled_at, null);
});

function scheduledEvent(guildId, discordEventId, eventAt, status = GuildScheduledEventStatus.Scheduled) {
  return {
    guildId, id: discordEventId, name: "Harmony weekly event",
    scheduledStartAt: new Date(eventAt), scheduledEndAt: new Date(new Date(eventAt).getTime() + 60 * 60 * 1000),
    status,
  };
}

test("Discord cancellation of one Harmony-owned occurrence cancels only its pending work and preserves history", async () => {
  const guildId = `phase3a-status-${Date.now()}`;
  const seriesId = `${guildId}-series`;
  const start = upcomingStart();
  const target = makeOccurrence(guildId, seriesId, 1, `${guildId}-discord-1`, 1, start);
  const sibling = makeOccurrence(guildId, seriesId, 0, `${guildId}-discord-0`, 1, start);
  const unrelated = makeOccurrence(guildId, `${seriesId}-other`, 0, `${guildId}-discord-other`, 1, start);
  addReminderRows(guildId, target.discord_event_id, "target");
  addReminderRows(guildId, sibling.discord_event_id, "sibling");
  addReminderRows(guildId, unrelated.discord_event_id, "unrelated");
  insertAnnouncement(target.id, "2099-01-01T00:00:00.000Z", "pending", "generated");
  insertAnnouncement(target.id, "2099-01-02T00:00:00.000Z", "pending", "manual");
  insertAnnouncement(target.id, "2099-01-03T00:00:00.000Z", "sent", "generated");
  insertAnnouncement(target.id, "2099-01-04T00:00:00.000Z", "cancelled", "manual");

  const notices = [];
  store.setReconciliationChannel(guildId, "reconciliation");
  const channel = { isTextBased: () => true, send: async (payload) => notices.push(payload) };
  const client = { guilds: { cache: new Map([[guildId, { channels: { cache: new Map([["reconciliation", channel]]) } }]]) } };
  const before = scheduledEvent(guildId, target.discord_event_id, target.event_at);
  const canceled = { ...before, status: GuildScheduledEventStatus.Canceled };
  await handleGuildScheduledEventUpdate(client, before, canceled);
  await handleGuildScheduledEventUpdate(client, before, canceled);

  const persisted = rawEvent(guildId, target.id);
  assert.ok(persisted.cancelled_at);
  assert.equal(persisted.discord_event_id, target.discord_event_id);
  assert.equal(rawEvent(guildId, sibling.id).cancelled_at, null);
  assert.equal(rawEvent(guildId, unrelated.id).cancelled_at, null);
  const announcementRows = getDb().prepare("SELECT status FROM scheduled_announcements WHERE event_id = ? ORDER BY scheduled_for").all(target.id);
  assert.deepEqual(announcementRows.map((row) => row.status), ["cancelled", "cancelled", "sent", "cancelled"]);
  for (const table of ["discord_event_reminder_schedules", "discord_event_reminders"]) {
    const targetRows = getDb().prepare(`SELECT user_id, status FROM ${table} WHERE guild_id = ? AND discord_event_id = ? ORDER BY user_id`).all(guildId, target.discord_event_id);
    assert.deepEqual(targetRows.map((row) => row.status), ["cancelled", "cancelled", "sent"]);
    assert.equal(getDb().prepare(`SELECT status FROM ${table} WHERE guild_id = ? AND discord_event_id = ? AND user_id = 'sibling-pending'`).get(guildId, sibling.discord_event_id).status, "pending");
    assert.equal(getDb().prepare(`SELECT status FROM ${table} WHERE guild_id = ? AND discord_event_id = ? AND user_id = 'unrelated-pending'`).get(guildId, unrelated.discord_event_id).status, "pending");
  }
  assert.deepEqual(notices, []);
});

test("Discord deletion cancels one Harmony-owned occurrence, keeps its ID, and cannot create a replacement", async () => {
  const guildId = `phase3a-delete-${Date.now()}`;
  const seriesId = `${guildId}-series`;
  const start = upcomingStart();
  const target = makeOccurrence(guildId, seriesId, 0, `${guildId}-discord-0`, 1, start);
  const sibling = makeOccurrence(guildId, seriesId, 1, `${guildId}-discord-1`, 1, start);
  addReminderRows(guildId, target.discord_event_id, "deleted");
  insertAnnouncement(target.id, "2099-01-01T00:00:00.000Z", "pending", "generated");
  const notices = [];
  store.setReconciliationChannel(guildId, "reconciliation");
  const channel = { isTextBased: () => true, send: async (payload) => notices.push(payload) };
  const client = { guilds: { cache: new Map([[guildId, { channels: { cache: new Map([["reconciliation", channel]]) } }]]) } };

  await handleGuildScheduledEventDelete(client, scheduledEvent(guildId, target.discord_event_id, target.event_at));
  await handleGuildScheduledEventDelete(client, scheduledEvent(guildId, target.discord_event_id, target.event_at));
  assert.ok(rawEvent(guildId, target.id).cancelled_at);
  assert.equal(rawEvent(guildId, target.id).discord_event_id, target.discord_event_id);
  assert.equal(rawEvent(guildId, sibling.id).cancelled_at, null);
  assert.equal(getDb().prepare("SELECT status FROM scheduled_announcements WHERE event_id = ?").get(target.id).status, "cancelled");
  for (const table of ["discord_event_reminder_schedules", "discord_event_reminders"]) {
    assert.equal(getDb().prepare(`SELECT status FROM ${table} WHERE guild_id = ? AND discord_event_id = ? AND user_id = 'deleted-pending'`).get(guildId, target.discord_event_id).status, "cancelled");
  }

  let replacementCreates = 0;
  const guild = { scheduledEvents: { create: async () => { replacementCreates++; return { id: "replacement" }; } } };
  await syncRecurringNativeEventWindow({ guilds: { cache: new Map([[guildId, guild]]), fetch: async () => guild } });
  assert.equal(replacementCreates, 0);
  assert.deepEqual(notices, []);
});

for (const scope of ["this", "future", "series"]) {
  test(`Harmony ${scope} cancellation cleans the correct mode 1 rows and linked Discord events`, async () => {
    const guildId = `phase3a-${scope}-${Date.now()}`;
    const seriesId = `${guildId}-series`;
    const start = upcomingStart();
    const rows = [0, 1, 2, 3].map((index) => makeOccurrence(
      guildId, seriesId, index, index === 0 || index === 2 ? `${guildId}-discord-${index}` : null, 1, start,
    ));
    const otherSeries = makeOccurrence(guildId, `${seriesId}-other`, 0, `${guildId}-other-discord`, 1, start);
    rows.forEach((row, index) => {
      insertAnnouncement(row.id, `2099-02-0${index + 1}T00:00:00.000Z`, "pending", "manual");
      if (row.discord_event_id) addReminderRows(guildId, row.discord_event_id, `scope-${index}`);
    });
    insertAnnouncement(otherSeries.id, "2099-02-09T00:00:00.000Z", "pending", "manual");

    const editedIds = [];
    const notices = [];
    store.setReconciliationChannel(guildId, "reconciliation");
    const reconciliationChannel = { isTextBased: () => true, send: async (payload) => notices.push(payload) };
    const client = { guilds: { cache: new Map() } };
    const nativeEvents = new Map();
    for (const row of rows.filter((item) => item.discord_event_id)) {
      const native = scheduledEvent(guildId, row.discord_event_id, row.event_at);
      native.edit = async (payload) => {
        editedIds.push(row.discord_event_id);
        await handleGuildScheduledEventUpdate(client, native, { ...native, ...payload, status: payload.status });
      };
      nativeEvents.set(row.discord_event_id, native);
    }
    const guild = {
      scheduledEvents: { cache: nativeEvents, fetch: async (id) => nativeEvents.get(id) || null },
      channels: { cache: new Map([["reconciliation", reconciliationChannel]]) },
    };
    client.guilds.cache.set(guildId, guild);
    const interaction = eventInteraction(`harmony-manager:community:cancelscope:${scope}:${rows[1].id}`, guildId, guild);
    await handleEventSchedulerInteraction(interaction);

    const affected = rows.filter((row) => scope === "series" || (scope === "future" ? row.recurrence_index >= 1 : row.id === rows[1].id));
    const unaffected = rows.filter((row) => !affected.some((item) => item.id === row.id));
    for (const row of affected) {
      assert.ok(rawEvent(guildId, row.id).cancelled_at, `occurrence ${row.recurrence_index} should be canceled`);
      assert.equal(getDb().prepare("SELECT status FROM scheduled_announcements WHERE event_id = ?").get(row.id).status, "cancelled");
      if (row.discord_event_id) {
        for (const table of ["discord_event_reminder_schedules", "discord_event_reminders"]) {
          assert.equal(getDb().prepare(`SELECT status FROM ${table} WHERE guild_id = ? AND discord_event_id = ? AND user_id = ?`).get(guildId, row.discord_event_id, `scope-${row.recurrence_index}-pending`).status, "cancelled");
        }
      }
    }
    for (const row of unaffected) {
      assert.equal(rawEvent(guildId, row.id).cancelled_at, null, `occurrence ${row.recurrence_index} should remain active`);
      assert.equal(getDb().prepare("SELECT status FROM scheduled_announcements WHERE event_id = ?").get(row.id).status, "pending");
    }
    assert.equal(rawEvent(guildId, otherSeries.id).cancelled_at, null);
    assert.equal(getDb().prepare("SELECT status FROM scheduled_announcements WHERE event_id = ?").get(otherSeries.id).status, "pending");
    assert.deepEqual(editedIds.sort(), affected.map((row) => row.discord_event_id).filter(Boolean).sort());
    assert.deepEqual(notices, []);

    const createdStarts = [];
    const syncGuild = {
      members: { me: null },
      scheduledEvents: { create: async (payload) => { createdStarts.push(payload.scheduledStartTime.toISOString()); return { id: `replacement-${createdStarts.length}` }; } },
    };
    await syncRecurringNativeEventWindow({ guilds: { cache: new Map([[guildId, syncGuild]]), fetch: async () => syncGuild } });
    for (const row of affected.filter((item) => !item.discord_event_id)) {
      assert.ok(!createdStarts.includes(row.event_at), `canceled occurrence ${row.recurrence_index} must not be recreated`);
    }
  });
}

test("Harmony recurring cancellation remains locally complete when Discord fetch/edit fails", async () => {
  const guildId = `phase3a-failure-${Date.now()}`;
  const seriesId = `${guildId}-series`;
  const start = upcomingStart();
  const fetchFailure = makeOccurrence(guildId, seriesId, 0, `${guildId}-discord-fetch`, 1, start);
  const editFailure = makeOccurrence(guildId, seriesId, 1, `${guildId}-discord-edit`, 1, start);
  for (const [index, row] of [fetchFailure, editFailure].entries()) {
    insertAnnouncement(row.id, `2099-03-0${index + 1}T00:00:00.000Z`, "pending");
    addReminderRows(guildId, row.discord_event_id, `failure-${index}`);
  }
  let failedEdits = 0;
  const native = { edit: async () => { failedEdits++; throw new Error("Discord edit unavailable"); } };
  const guild = {
    scheduledEvents: { cache: new Map([[editFailure.discord_event_id, native]]), fetch: async () => { throw new Error("Discord fetch unavailable"); } },
  };
  const interaction = eventInteraction(`harmony-manager:community:cancelscope:series:${fetchFailure.id}`, guildId, guild);
  await handleEventSchedulerInteraction(interaction);
  assert.equal(failedEdits, 1);
  for (const [index, row] of [fetchFailure, editFailure].entries()) {
    assert.ok(rawEvent(guildId, row.id).cancelled_at);
    assert.equal(rawEvent(guildId, row.id).discord_event_id, row.discord_event_id);
    assert.equal(getDb().prepare("SELECT status FROM scheduled_announcements WHERE event_id = ?").get(row.id).status, "cancelled");
    for (const table of ["discord_event_reminder_schedules", "discord_event_reminders"]) {
      assert.equal(getDb().prepare(`SELECT status FROM ${table} WHERE guild_id = ? AND discord_event_id = ? AND user_id = ?`).get(guildId, row.discord_event_id, `failure-${index}-pending`).status, "cancelled");
    }
  }
});

test("Discord-native mode 2 cancellation behavior remains unchanged", async () => {
  const guildId = `phase3a-mode2-${Date.now()}`;
  const row = makeOccurrence(guildId, `${guildId}-series`, 0, `${guildId}-native-series`, 2, upcomingStart());
  const before = scheduledEvent(guildId, row.discord_event_id, row.event_at);
  await handleGuildScheduledEventUpdate({ guilds: { cache: new Map() } }, before, { ...before, status: GuildScheduledEventStatus.Canceled });
  assert.equal(rawEvent(guildId, row.id).cancelled_at, null);
  assert.equal(rawEvent(guildId, row.id).discord_event_id, row.discord_event_id);

  await handleGuildScheduledEventDelete({ guilds: { cache: new Map(), fetch: async () => null } }, before);
  assert.equal(rawEvent(guildId, row.id).cancelled_at, null);
  assert.equal(rawEvent(guildId, row.id).discord_event_id, null);
});
