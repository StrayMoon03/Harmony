Warning: truncated output (original token count: 36103)
Total output lines: 2263

const test = require("node:test");
const assert = require("node:assert/strict");
const { ChannelType, GuildScheduledEventEntityType } = require("discord.js");
const {
  parseEvent, localToUtc, buildCalendarMessages, parseManagerDraft,
  managerPanelContent, managerPanelComponents, managerCalendarType,
  managerModal, handleEventSchedulerInteraction,
  installScheduleManagers, publishMonthlyCalendar, refreshPublishedCalendar,
  buildYoutifulCalendarMessages, YOUTIFUL_EVENT_TYPES, YOUTIFUL_EVENT_TYPE_ICONS, YOUTIFUL_TIMEZONE_OPTIONS,
  SKZ_TIMEZONE_OPTIONS,
  applyRecurringChanges,
  interestedStateSupport,
  handleReminderInteraction,
  nativeEventEndTime,
  syncNativeScheduledEvent,
  reconciliationPayload,
  reconciliationReviewPayload,
  handleGuildScheduledEventCreate,
  handleGuildScheduledEventDelete,
  registerScheduledEventListeners,
  markPendingNativeCreate,
  clearPendingNativeCreate,
  markPendingNativeDelete,
  announcementChannelMenu,
  sendImmediateCalendarAnnouncement,
  addNativeEventToCalendar,
  syncDiscordRecurringSeries,
  normalizeCalendarAnnouncementBody,
  processScheduledAnnouncements,
  formatAnnouncementCountdown,
} = require("../src/services/eventSchedulerService");
const store = require("../src/stores/eventSchedulerStore");
const { getDb } = require("../src/db/sqlite");
const { normalizeRecurrenceRule, generateRecurringOccurrences, generateDiscordRecurringOccurrences, MAX_RECURRENCE_OCCURRENCES } = require("../src/services/recurrenceService");

test("Youtiful Stays event types use the approved custom emoji set", () => {
  assert.deepEqual(YOUTIFUL_EVENT_TYPES, ["kdrama", "chans_room", "skz_code", "chat_only", "concert_stream", "games", "birthday", "other"]);
  assert.equal(YOUTIFUL_EVENT_TYPE_ICONS.kdrama, "<:Harmony_Kdramas:1555094992475791400>");
  assert.equal(YOUTIFUL_EVENT_TYPE_ICONS.birthday, "<:Harmony_Birthdays:1555095112218972170>");
  assert.deepEqual(Object.keys(YOUTIFUL_EVENT_TYPE_ICONS), YOUTIFUL_EVENT_TYPES);
});

test("Youtiful Stays calendar renders compact channel rows and native links", () => {
  const [part] = buildYoutifulCalendarMessages("2026-10", [{
    guild_id: "guild", calendar_event_type: "kdrama", event_date: "2026-10-03", all_day: 1,
    title: "K-Drama With Us", description: "Watch together", event_channel_id: "123", discord_event_id: "456",
  }], Date.parse("2026-10-01T00:00:00Z"));
  const text = part.embeds[0].description;
  assert.match(text, /Harmony_Kdramas/);
  assert.match(text, /<#[0-9]+>/);
  assert.match(text, /View Discord Event/);
  assert.match(text, /Oct 3/);
  assert.doesNotMatch(text, /2026/);
  assert.equal(part.embeds[0].title, "📅 YOUTIFUL STAYS • OCTOBER 2026");
});

test("Youtiful birthday calendar entries are informational and never mention members", () => {
  const [part] = buildYoutifulCalendarMessages("2026-10", [{
    category: "birthday", calendar_event_type: "birthday", event_date: "2026-10-08", all_day: 1,
    title: "Happy Birthday, Mina!", description: null, event_at: null,
  }], Date.parse("2026-10-01T00:00:00Z"));
  const payload = part.embeds[0].description;
  assert.match(payload, /Happy Birthday, Mina/);
  assert.doesNotMatch(payload, /<@\d+>/);
  assert.deepEqual(part.allowedMentions, { parse: [] });
});

test("Interested state uses Discord Scheduled Event subscriber capabilities", () => {
  const support = interestedStateSupport();
  assert.equal(support.supported, true);
  assert.match(support.reason, /fetchSubscribers|UserAdd/i);
});

test("saved Youtiful Stays titles support add, rename, remove, defaults, and guild isolation", () => {
  const first = `guild-title-${Date.now()}`;
  const second = `${first}-other`;
  assert.equal(store.ensureDefaultCalendarEventTitles(first, "community").length, 7);
  assert.equal(store.ensureDefaultCalendarEventTitles(first, "community").length, 7);
  store.addCalendarEventTitle(first, "community", "Fan Meeting");
  assert.equal(store.renameCalendarEventTitle(first, "community", "Fan Meeting", "Stay Meeting"), true);
  assert.equal(store.removeCalendarEventTitle(first, "community", "Stay Meeting"), true);
  assert.equal(store.listCalendarEventTitles(second, "community").length, 0);
  assert.throws(() => store.addCalendarEventTitle(first, "community", "Other / Custom"));
});

test("reminder selection persists and removal cancels it", async () => {
  const id = `native-${Date.now()}`;
  const userId = `user-${Date.now()}`;
  const interaction = {
    customId: `harmony-reminder:${id}:3600`, user: { id: userId },
    client: { guilds: { cache: new Map([
      ["g", { scheduledEvents: { cache: new Map([[id, { scheduledStartAt: new Date(Date.now() + 7200000), guildId: "g" }]]) } }],
    ]) } },
    update: async (payload) => { interaction.payload = payload; },
  };
  await handleReminderInteraction(interaction);
  assert.equal(store.dueDiscordEventReminders(new Date(Date.now() + 7200000).toISOString(), 100).some((row) => row.discord_event_id === id), true);
  assert.equal(store.cancelDiscordEventReminder(id, userId), true);
  assert.equal(store.dueDiscordEventReminders(new Date(Date.now() + 7200000).toISOString(), 100).some((row) => row.discord_event_id === id), false);
});

test("Interested reminder selection supports multiple offsets without duplicates", async () => {
  const guildId = `multi-reminder-${Date.now()}`;
  const id = `native-${Date.now()}`;
  const userId = `user-${Date.now()}`;
  const start = new Date(Date.now() + 10 * 86400000);
  const guild = { scheduledEvents: { cache: new Map([[id, { scheduledStartAt: start, guildId }]]) } };
  const interaction = fakeInteraction({
    customId: `harmony-reminders:${id}`, kind: "select", guildId, userId,
    values: ["259200", "86400"],
    client: { guilds: { cache: new Map([[guildId, guild]]) } },
  });
  await handleReminderInteraction(interaction);
  const due = store.dueDiscordEventReminders(new Date(start.getTime()).toISOString(), 20).filter((row) => row.discord_event_id === id && row.user_id === userId);
  assert.equal(due.length, 2);
  assert.deepEqual(due.map((row) => row.reminder_offset_seconds).sort((a, b) => a - b), [86400, 259200]);
  await handleReminderInteraction(fakeInteraction({ customId: `harmony-reminders:${id}`, kind: "select", guildId, userId, values: ["259200", "86400"], client: { guilds: { cache: new Map([[guildId, guild]]) } } }));
  assert.equal(store.dueDiscordEventReminders(new Date(start.getTime()).toISOString(), 20).filter((row) => row.discord_event_id === id && row.user_id === userId).length, 2);
  await handleReminderInteraction(fakeInteraction({ customId: `harmony-reminders:${id}`, kind: "select", guildId, userId, values: ["none"], client: { guilds: { cache: new Map([[guildId, guild]]) } } }));
  assert.equal(store.dueDiscordEventReminders(new Date(start.getTime()).toISOString(), 20).some((row) => row.discord_event_id === id && row.user_id === userId), false);
});

test("parses several announcements for one event and one link", () => {
  const event = parseEvent([
    "Harmony event",
    "Title: Rock in Rio Replay",
    "Link: https://example.com/replay",
    "Post in: <#123456789012345678>",
    "Timezone: America/New_York",
    "Announcements:",
    "2099-01-07 20:00 | The replay is one week away!",
    "2099-01-14 20:00 | The replay is starting now!",
  ].join("\n"));

  assert.equal(event.title, "Rock in Rio Replay");
  assert.equal(event.destinationChannelId, "123456789012345678");
  assert.equal(event.announcements.length, 2);
  assert.equal(event.announcements[0].scheduledFor, "2099-01-08T01:00:00.000Z");
});

test("converts Eastern standard and daylight times correctly", () => {
  assert.equal(
    localToUtc("2099-01-14", "20:00", "America/New_York").toISOString(),
    "2099-01-15T01:00:00.000Z"
  );
  assert.equal(
    localToUtc("2099-07-14", "20:00", "America/New_York").toISOString(),
    "2099-07-15T00:00:00.000Z"
  );
});

test("rejects impossible local dates and malformed schedule lines", () => {
  assert.equal(localToUtc("2099-02-31", "20:00", "America/New_York"), null);
  assert.throws(
    () => parseEvent([
      "Harmony event",
      "Title: Replay",
      "Link: https://example.com/replay",
      "Post in: <#123456789012345678>",
      "Announcements:",
      "tomorrow | Starting soon",
    ].join("\n")),
    /YYYY-MM-DD HH:MM/
  );
});

test("renders categorized timed and all-day events without fake midnight times", () => {
  const parts = buildCalendarMessages("stray_kids", "2099-01", [
    { title: "SKZ CODE", category: "content", event_date: "2099-01-04", event_at: "2099-01-04T20:00:00.000Z", event_timezone: "America/New_York", link: "https://example.com/skz" },
    { title: "Birthday", category: "birthday", event_date: "2099-01-05", event_at: null, all_day: 1, event_timezone: "America/New_York", link: "https://example.com/bday" },
  ], 0);
  assert.equal(parts.length, 1);
  const embed = parts[0].embeds[0];
  assert.match(embed.description, /🎬 Jan 4 • <t:4071240000:t> • \*\*SKZ CODE\*\*/);
  assert.match(embed.description, /<t:4071240000:t>/);
  assert.match(embed.description, /🎂 Jan 5 • All Day • \*\*Birthday\*\*/);
  assert.doesNotMatch(embed.description, /🎂 \*\*Birthday\*\* • All Day\n<t:/);
  assert.equal(embed.color, 0xE53935);
  assert.match(embed.footer.text, /Times display in your local timezone/);
});

test("splits busy calendars below Discord's content limit", () => {
  const events = Array.from({ length: 80 }, (_, index) => ({
    title: `Event ${index} ${"x".repeat(80)}`,
    category: "other",
    event_date: "2099-01-01",
    all_day: 1,
    link: `https://example.com/${index}`,
  }));
  const parts = buildCalendarMessages("community", "2099-01", events, 0);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.embeds[0].description.length <= 3900));
  assert.match(parts.at(-1).embeds[0].footer.text, /Last updated/);
});

test("calendar cards keep title primary, optional metadata secondary, and add Shopping / Pop-Up", () => {
  const parts = buildCalendarMessages("stray_kids", "2026-10", [{
    title: "RUN IT JAPAN Pop-Up", category: "shopping", event_date: "2026-10-16", all_day: true,
    description: "Limited goods", event_location: "Fukuoka, Japan", link: "https://example.com/popup",
  }], 0);
  const embed = parts[0].embeds[0];
  assert.match(embed.description, /Oct 16 • All Day/);
  assert.match(embed.description, /🛍️ Oct 16 • All Day • \*\*RUN IT JAPAN Pop-Up\*\*/);
  assert.ok(embed.description.indexOf("**RUN IT JAPAN Pop-Up**") < embed.description.indexOf("Limited goods"));
  assert.match(embed.description, /📍 Fukuoka, Japan/);
  assert.match(embed.description, /\[Open event link\]\(https:\/\/example\.com\/popup\)/);
});

test("timed calendar cards use one localized date token and a time-only token", () => {
  const parts = buildCalendarMessages("stray_kids", "2026-10", [{
    title: "SKZ CODE", category: "content", event_date: "2026-10-01", event_at: "2026-10-01T11:00:00.000Z", all_day: 0,
  }], 0);
  const description = parts[0].embeds[0].description;
  assert.match(description, /🎬 Oct 1 • <t:1790852400:t> • \*\*SKZ CODE\*\*/);
  assert.doesNotMatch(description, /<t:1790852400:[DFf]> /);
  assert.equal((description.match(/Oct 1/g) || []).length, 1);
});

test("manager drafts support optional links and all-day events without midnight", () => {
  const draft = parseManagerDraft({
    title: "SKZ CODE",
    eventDate: "2099-01-04",
    eventTime: "",
    location: "Seoul, South Korea",
    description: "New episode",
  }, "stray_kids");
  assert.equal(draft.calendarType, "stray_kids");
  assert.equal(draft.link, "");
  assert.equal(draft.allDay, true);
  assert.equal(draft.eventAt, null);
  assert.equal(draft.eventTimezone, "Asia/Seoul");
});

test("Stray Kids uses explicit IANA timezone choices, optional location, and preserves all-day compatibility", () => {
  assert.equal(SKZ_TIMEZONE_OPTIONS.find((option) => option.label.includes("China"))?.value, "Asia/Shanghai");
  const timed = parseManagerDraft({
    title: "SKZ Video Call", eventDate: "2026-10-30", eventTime: "20:00",
    timezone: "Asia/Seoul", location: "", description: "",
  }, "stray_kids");
  assert.equal(timed.eventTimezone, "Asia/Seoul");
  assert.equal(timed.eventLocation, "");
  assert.equal(timed.eventAt, "2026-10-30T11:00:00.000Z");
  const allDay = parseManagerDraft({
    title: "SKZ Birthday", eventDate: "2026-10-25", eventTime: "",
    timezone: "", location: "", description: "",
  }, "stray_kids");
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.eventAt, null);
  assert.equal(allDay.eventTimezone, null);
});

test("calendar-only all-day events with blank location save without a timezone", () => {
  const guildId = `all-day-no-location-${Date.now()}`;
  const eventId = store.createCalendarEvent({
    guildId,
    calendarChannelId: "calendar-community",
    title: "Unlocated birthday",
    eventDate: "2099-01-04",
    timezone: null,
    eventTimezone: null,
    eventLocation: "",
    calendarType: "community",
    category: "birthday",
    allDay: true,
    createdBy: "admin",
  });
  const saved = store.getEvent(guildId, eventId);
  assert.equal(saved.all_day, 1);
  assert.equal(saved.event_at, null);
  assert.equal(saved.event_timezone, null);
  assert.equal(saved.event_location, null);
});

test("manager drafts use explicit Youtiful timezones and separate description plus link", () => {
  const draft = parseManagerDraft({ title: "Concert", eventDate: "2099-07-14", eventTime: "20:00", timezone: "Asia/Tokyo", description: "Live show\nhttps://example.com/concert" }, "community");
  assert.equal(draft.allDay, false);
  assert.equal(draft.eventTimezone, "Asia/Tokyo");
  assert.equal(draft.link, "https://example.com/concert");
  assert.equal(draft.description, "Live show");
  const allDayWithoutTimezone = parseManagerDraft({ title: "Birthday", eventDate: "2099-01-01", eventTime: "", timezone: "", description: "" }, "community");
  assert.equal(allDayWithoutTimezone.allDay, true);
  assert.equal(allDayWithoutTimezone.eventAt, null);
  assert.equal(allDayWithoutTimezone.eventTimezone, null);
  assert.equal(allDayWithoutTimezone.eventLocation, "");
  assert.throws(() => parseManagerDraft({ title: "Timed", eventDate: "2099-01-01", eventTime: "18:00", timezone: "", description: "" }, "community"), /time zone/);
});

test("Youtiful timed drafts persist an explicit end time", () => {
  const draft = parseManagerDraft({
    title: "Fukuoka concert", eventDate: "2026-10-24", eventTime: "18:30", endTime: "21:30",
    timezone: "Asia/Tokyo", description: "",
  }, "community");
  assert.equal(draft.eventAt, "2026-10-24T09:30:00.000Z");
  assert.equal(draft.eventEndAt, "2026-10-24T12:30:00.000Z");
  assert.equal(nativeEventEndTime(draft).toISOString(), draft.eventEndAt);
});

test("explicit end time survives scheduled event storage", () => {
  const guildId = `end-time-storage-${Date.now()}`;
  const id = store.createCalendarEvent({
    guildId, calendarChannelId: "calendar-community", title: "Stored event",
    eventDate: "2026-10-24", eventAt: "2026-10-24T09:30:00.000Z", eventEndAt: "2026-10-24T12:30:00.000Z",
    eventTimezone: "Asia/Tokyo", timezone: "Asia/Tokyo", calendarType: "community", category: "concert", createdBy: "admin",
  });
  assert.equal(store.getEvent(guildId, id).event_end_at, "2026-10-24T12:30:00.000Z");
});

test("blank end time retains the safe one-hour native default", () => {
  const draft = parseManagerDraft({
    title: "Seoul stream", eventDate: "2026-10-03", eventTime: "18:00", endTime: "",
    timezone: "Asia/Seoul", description: "",
  }, "community");
  assert.equal(draft.eventEndAt, null);
  assert.equal(nativeEventEndTime(draft).toISOString(), "2026-10-03T10:00:00.000Z");
});

test("end times crossing midnight use the following local calendar date", () => {
  const draft = parseManagerDraft({
    title: "Late event", eventDate: "2026-10-24", eventTime: "23:30", endTime: "01:00",
    timezone: "America/New_York", description: "",
  }, "community");
  assert.equal(draft.eventAt, "2026-10-25T03:30:00.000Z");
  assert.equal(draft.eventEndAt, "2026-10-25T05:00:00.000Z");
  assert.ok(new Date(draft.eventEndAt) > new Date(draft.eventAt));
});

test("an end time cannot be supplied for an all-day event", () => {
  assert.throws(() => parseManagerDraft({
    title: "Birthday", eventDate: "2026-10-03", eventTime: "", endTime: "01:00",
    timezone: "Asia/Seoul", description: "",
  }, "community"), /requires a Start Time/);
});

test("editing a linked event synchronizes its explicit native end time", async () => {
  const calls = [];
  const native = { entityType: GuildScheduledEventEntityType.External, edit: async (payload) => { calls.push(payload); } };
  const client = { guilds: { cache: new Map([["g", { scheduledEvents: { cache: new Map([["native-edit", native]]) } }]]) } };
  const event = {
    guild_id: "g", discord_event_id: "native-edit", event_at: "2026-10-24T09:30:00.000Z",
    event_end_at: "2026-10-24T12:30:00.000Z", title: "Updated concert", description: "Updated",
  };
  assert.equal(await syncNativeScheduledEvent(client, event), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scheduledEndTime.toISOString(), event.event_end_at);
});

test("native sync includes entity metadata for External scheduled events", async () => {
  const calls = [];
  const native = { entityType: GuildScheduledEventEntityType.External, edit: async (payload) => { calls.push(payload); } };
  const client = { guilds: { cache: new Map([["g", {
    scheduledEvents: { cache: new Map([["native-external", native]]) },
    channels: { cache: new Map([["text-channel", { name: "event-chat" }]]) },
  }]]) } };
  await syncNativeScheduledEvent(client, {
    guild_id: "g", discord_event_id: "native-external", event_at: "2026-10-24T09:30:00.000Z",
    event_channel_id: "text-channel", title: "External event", description: "Details",
  });
  assert.deepEqual(calls[0].entityMetadata, { location: "#event-chat" });
});

test("native sync omits unsupported entity metadata for Voice scheduled events", async () => {
  const calls = [];
  const native = { entityType: GuildScheduledEventEntityType.Voice, edit: async (payload) => { calls.push(payload); } };
  const client = { guilds: { cache: new Map([["g", {
    scheduledEvents: { cache: new Map([["native-voice", native]]) },
    channels: { cache: new Map([["voice-channel", { name: "watch-room" }]]) },
  }]]) } };
  await syncNativeScheduledEvent(client, {
    guild_id: "g", discord_event_id: "native-voice", event_at: "2026-10-24T09:30:00.000Z",
    event_channel_id: "voice-channel", title: "Voice event", description: "Details",
  });
  assert.equal(Object.hasOwn(calls[0], "entityMetadata"), false);
});

test("manager drafts resolve common worldwide city and country locations deterministically", () => {
  const examples = [
    ["Sydney, Australia", "Australia/Sydney"],
    ["Osaka, Japan", "Asia/Tokyo"],
    ["Mexico City, Mexico", "America/Mexico_City"],
    ["Berlin, Germany", "Europe/Berlin"],
    ["Toronto, Canada", "America/Toronto"],
    ["Singapore, Singapore", "Asia/Singapore"],
  ];
  for (const [location, timezone] of examples) {
    const draft = parseManagerDraft({ title: "Event", eventDate: "2099-01-01", eventTime: "12:00", location, description: "" }, "community");
    assert.equal(draft.eventTimezone, timezone, location);
  }
});

test("manager description input supports description-only, link-only, and legacy timezone events", () => {
  const descriptionOnly = parseManagerDraft({ title: "Talk", eventDate: "2099-01-01", eventTime: "", location: "Paris, France", description: "Doors open" }, "community");
  assert.equal(descriptionOnly.description, "Doors open");
  assert.equal(descriptionOnly.link, "");
  const linkOnly = parseManagerDraft({ title: "Live", eventDate: "2099-01-01", eventTime: "18:00", location: "New York, USA", description: "https://example.com/live" }, "community");
  assert.equal(linkOnly.description, null);
  assert.equal(linkOnly.link, "https://example.com/live");
  const legacy = parseManagerDraft({ title: "Legacy", eventDate: "2099-01-01", eventTime: "", location: "", fallbackTimezone: "Asia/Seoul", description: "Existing" }, "community");
  assert.equal(legacy.eventTimezone, "Asia/Seoul");
});

test("manager panels stay scoped to their calendar", () => {
  assert.equal(managerCalendarType("stray_kids"), "stray_kids");
  assert.equal(managerCalendarType("other"), null);
  assert.match(managerPanelContent("stray_kids"), /STRAY KIDS SCHEDULE MANAGER/);
  assert.match(managerPanelContent("community"), /YOUTIFUL STAYS SCHEDULE MANAGER/);
  const ids = managerPanelComponents("stray_kids")[0].toJSON().components.map((button) => button.custom_id);
  assert.deepEqual(ids, [
    "harmony-manager:stray_kids:add",
    "harmony-manager:stray_kids:view",
    "harmony-manager:stray_kids:edit",
    "harmony-manager:stray_kids:cancel",
  ]);
  const communityRows = managerPanelComponents("community").flatMap((row) => row.toJSON().components);
  assert.ok(communityRows.some((button) => button.custom_id === "harmony-manager:community:findnative"));
});

test("manager modals allow blank optional fields", () => {
  const json = managerModal("manager:test", "Add event", [
    { id: "title", label: "Title", required: true, value: "Event" },
    { id: "link", label: "Link", value: "" },
  ]).toJSON();
  assert.equal(json.components.length, 2);
  assert.equal(json.components[1].components[0].value, undefined);
});

function fakeInteraction({ customId, kind, guildId, userId = "admin", values = [], fields = {}, client = {}, guild = null, failUpdate = false }) {
  const interaction = {
    customId,
    guildId,
    user: { id: userId },
    client,
    guild,
    memberPermissions: { has: () => true },
    values,
    fields: { getTextInputValue: (name) => fields[name] || "" },
    responses: [],
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "select",
    isChannelSelectMenu: () => kind === "channel",
    isModalSubmit: () => kind === "modal",
    reply: async (payload) => { interaction.responses.push({ type: "reply", payload }); },
    deferReply: async (payload) => { interaction.responses.push({ type: "deferReply", payload }); },
    followUp: async (payload) => { interaction.responses.push({ type: "followUp", payload }); },
    editReply: async (payload) => { interaction.responses.push({ type: "editReply", payload }); },
    showModal: async (modal) => { interaction.responses.push({ type: "modal", modal }); },
    update: async (payload) => { if (failUpdate) throw new Error("simulated Discord update failure"); interaction.responses.push({ type: "update", payload }); },
  };
  return interaction;
}

test("timed calendar dates preserve the entered year through storage and rendering", () => {
  const guildId = `calendar-year-${Date.now()}`;
  const eventAt = localToUtc("2026-10-01", "07:00", "America/New_York");
  assert.equal(eventAt.toISOString(), "2026-10-01T11:00:00.000Z");
  const eventId = store.createCalendarEvent({
    guildId,
    calendarChannelId: "calendar-stray-kids",
    title: "SKZ CODE EP. 104",
    eventDate: "2026-10-01",
    eventAt: eventAt.toISOString(),
    eventTimezone: "America/New_York",
    calendarType: "stray_kids",
    category: "content",
    createdBy: "admin",
  });
  const saved = store.getEvent(guildId, eventId);
  assert.equal(saved.event_date, "2026-10-01");
  assert.equal(saved.event_at, "2026-10-01T11:00:00.000Z");
  const upcoming = store.listCalendarEvents(guildId, "stray_kids", "2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
  assert.equal(upcoming.some((event) => event.id === eventId), true);
  const rendered = buildCalendarMessages("stray_kids", "2026-10", [saved])[0].embeds[0].description;
  assert.match(rendered, /Oct 1 • <t:1790852400:t>/);
  assert.match(rendered, /<t:1790852400:t>/);
  assert.doesNotMatch(rendered, /2006/);
});

test("add event follows category-first interaction flow and saves without a second category step", async () => {
  const guildId = `manager-add-flow-${Date.now()}`;
  store.setCalendarChannels(guildId, "calendar-stray-kids", "calendar-community");

  const add = fakeInteraction({ customId: "harmony-manager:stray_kids:add", kind: "button", guildId });
  await handleEventSchedulerInteraction(add);
  assert.equal(add.responses[0].type, "reply");
  const categoryMenuJson = add.responses[0].payload.components[0].toJSON().components[0];
  assert.deepEqual(categoryMenuJson.options.map((option) => option.label), [
    "🎂 Birthday", "🎬 Content / Video", "🎤 Concert", "📺 Stream / Watch", "💿 Release",
    "📱 Video Call", "✨ Appearance", "🎮 Community / Game", "🛍️ Shopping / Pop-Up", "📌 Other",
  ]);
  assert.equal(categoryMenuJson.options.some((option) => option.label === "content"), false);

  const category = fakeInteraction({
    customId: "harmony-manager:stray_kids:addcategory:new", kind: "select", guildId, values: ["content"],
  });
  await handleEventSchedulerInteraction(category);
  assert.equal(category.responses[0].type, "update");
  assert.match(category.responses[0].payload.content, /optional Stray Kids member/);
  const member = fakeInteraction({
    customId: "harmony-manager:stray_kids:addmember:new", kind: "select", guildId, values: ["none"],
  });
  await handleEventSchedulerInteraction(member);
  assert.equal(member.responses[0].type, "modal");
  assert.equal(member.responses[0].modal.toJSON().custom_id, "harmony-manager:stray_kids:addmodal");
  assert.equal(member.responses[0].modal.toJSON().components.length, 5);

  const details = fakeInteraction({
    customId: "harmony-manager:stray_kids:addmodal", kind: "modal", guildId,
    fields: {
      title: "SKZ CODE", "event-date": "2099-01-04", "event-time": "",
      location: "Paris, France", description: "Episode details\nhttps://example.com/skz",
    },
  });
  await handleEventSchedulerInteraction(details);
  assert.equal(details.responses[0].type, "reply");
  assert.match(details.responses[0].payload.content, /Choose the event time zone/);
  const timezone = fakeInteraction({ customId: "harmony-manager:stray_kids:sktimezone", kind: "select", guildId, values: ["none"] });
  await handleEventSchedulerInteraction(timezone);
  assert.equal(timezone.responses[0].type, "update");
  assert.match(timezone.responses[0].payload.content, /Event saved/);
  const eventId = store.listCalendarEvents(guildId, "stray_kids", "2099-01-01T00:00:00.000Z", "2099-02-01T00:00:00.000Z")[0].id;
  const saved = store.getEvent(guildId, eventId);
  assert.equal(saved.category, "content");
  assert.equal(saved.link, "https://example.com/skz");
  assert.equal(saved.description, "Episode details");
  assert.equal(saved.event_location, "Paris, France");
  assert.equal(saved.all_day, 1);
  assert.equal(saved.event_at, null);
  assert.equal(saved.member, null);

});

test("Stray Kids member selection persists and renders exact Harmony emoji, while community stays undecorated", () => {
  const guildId = `member-emoji-${Date.now()}`;
  const members = [
    ["bang_chan", "<:Harmony_Wolfchan:1555008944127221861>"],
    ["lee_know", "<:Harmony_LeeBit:1555012112571433074>"],
    ["changbin", "<:Harmony_Dwaekki:1555012505103892590>"],
    ["hyunjin", "<:Harmony_Jiniret:1555012684510924800>"],
    ["han", "<:Harmony_Qoukka:1555012780732588062>"],
    ["felix", "<:Harmony_bbokari:1555014305194184834>"],
    ["seungmin", "<:Harmony_puppym:1555013392098525215>"],
    ["i_n", "<:Harmony_Foxlny:1555014818983977101>"],
  ];
  for (const [member, emoji] of members) {
    const description = buildCalendarMessages("stray_kids", "2099-01", [{ title: "Event", category: "content", member, event_date: "2099-01-01", all_day: 1 }], 0)[0].embeds[0].description;
    assert.match(description, new RegExp(`${emoji} 🎬 Jan 1 • All Day • \\*\\*Event\\*\\*`));
  }
  const ot8 = buildCalendarMessages("stray_kids", "2099-01", [{ title: "OT8", category: "content", member: null, event_date: "2099-01-01", all_day: 1 }], 0)[0].embeds[0].description;
  assert.match(ot8, /🎬 Jan 1 • All Day • \*\*OT8\*\*/);
  assert.doesNotMatch(ot8, /Harmony_/);
  const community = buildCalendarMessages("community", "2099-01", [{ title: "Community", category: "content", member: "felix", event_date: "2099-01-01", all_day: 1 }], 0)[0].embeds[0].description;
  assert.doesNotMatch(community, /Harmony_bbokari/);
});

test("edit event keeps friendly category changes and editable links", async () => {
  const guildId = `manager-edit-flow-${Date.now()}`;
  store.setCalendarChannels(guildId, "calendar-stray-kids", "calendar-community");
  const eventId = store.createCalendarEvent({
    guildId,
    calendarChannelId: "calendar-stray-kids",
    title: "Concert",
    eventDate: "2099-07-14",
    eventAt: "2099-07-15T00:00:00.000Z",
    eventTimezone: "America/New_York",
    calendarType: "stray_kids",
    category: "concert",
    link: "https://example.com/old",
    createdBy: "admin",
  });
  const edit = fakeInteraction({ customId: "harmony-manager:stray_kids:edit", kind: "button", guildId });
  await handleEventSchedulerInteraction(edit);
  assert.equal(edit.responses[0].type, "reply");

  const select = fakeInteraction({ customId: "harmony-manager:stray_kids:editselect", kind: "select", guildId, values: [String(eventId)] });
  await handleEventSchedulerInteraction(select);
  assert.equal(select.responses[0].type, "modal");
  const editModal = select.responses[0].modal.toJSON();
  assert.equal(editModal.components.length, 5);
  assert.equal(editModal.components.at(-1).components[0].custom_id, "description");
  assert.equal(editModal.components[2].components[0].value, "20:00");

  const editDetails = fakeInteraction({
    customId: `harmony-manager:stray_kids:editmodal:${eventId}`, kind: "modal", guildId,
    fields: {
      title: "Updated Concert", "event-date": "2099-08-14", "event-time": "18:30",
      location: "Tokyo, Japan", description: "Updated details\nhttps://example.com/new",
    },
  });
  await handleEventSchedulerInteraction(editDetails);
  assert.equal(editDetails.responses[0].type, "reply");
  assert.match(editDetails.responses[0].payload.content, /Choose the event time zone/);
  const editTimezone = fakeInteraction({ customId: `harmony-manager:stray_kids:skzedittimezone:${eventId}`, kind: "select", guildId, values: ["Asia/Tokyo"] });
  await handleEventSchedulerInteraction(editTimezone);
  const immediatelySaved = store.getEvent(guildId, eventId);
  assert.equal(immediatelySaved.title, "Updated Concert");
  assert.equal(immediatelySaved.event_date, "2099-08-14");
  const editCategoryMenu = editTimezone.responses[0].payload.components[0].toJSON().components[0];
  assert.ok(editCategoryMenu.options.some((option) => option.label === "🎤 Concert" && option.default));
  assert.equal(editCategoryMenu.options.some((option) => option.label === "concert"), false);

  const changedCategory = fakeInteraction({
    customId: `harmony-manager:stray_kids:editcategory:${eventId}`, kind: "select", guildId, values: ["content"],
  });
  await handleEventSchedulerInteraction(changedCategory);
  assert.equal(changedCategory.responses[0].type, "update");
  const memberChange = fakeInteraction({
    customId: `harmony-manager:stray_kids:editmember:${eventId}`, kind: "select", guildId, values: ["felix"],
  });
  await handleEventSchedulerInteraction(memberChange);
  assert.equal(memberChange.responses[0].type, "update");
  const updated = store.getEvent(guildId, eventId);
  assert.equal(updated.category, "content");
  assert.equal(updated.title, "Updated Concert");
  assert.equal(updated.event_date, "2099-08-14");
  assert.equal(updated.event_location, "Tokyo, Japan");
  assert.equal(updated.event_timezone, "Asia/Tokyo");
  assert.equal(updated.timezone, "Asia/Tokyo");
  assert.equal(updated.all_day, 0);
  assert.equal(updated.link, "https://example.com/new");
  assert.equal(updated.description, "Updated details");
  assert.equal(updated.member, "felix");

  const reopened = fakeInteraction({ customId: "harmony-manager:stray_kids:edit", kind: "button", guildId });
  await handleEventSchedulerInteraction(reopened);
  const reopenedSelect = fakeInteraction({ customId: "harmony-manager:stray_kids:editselect", kind: "select", guildId, values: [String(eventId)] });
  await handleEventSchedulerInteraction(reopenedSelect);
  const reopenedModal = reopenedSelect.responses[0].modal.toJSON();
  assert.equal(reopenedModal.components[0].components[0].value, "Updated Concert");
  assert.equal(reopenedModal.components[1].components[0].value, "2099-08-14");
  assert.equal(reopenedModal.components[2].components[0].value, "18:30");
  assert.equal(reopenedModal.components[3].components[0].value, "Tokyo, Japan");
  assert.match(reopenedModal.components[4].components[0].value, /https:\/\/example\.com\/new/);

  const clearMemberModal = fakeInteraction({
    customId: `harmony-manager:stray_kids:editmodal:${eventId}`, kind: "modal", guildId,
    fields: {
      title: "Updated Concert", "event-date": "2099-08-14", "event-time": "18:30",
      location: "Tokyo, Japan", description: "Updated details\nhttps://example.com/new",
    },
  });
  await handleEventSchedulerInteraction(clearMemberModal);
  const clearTimezone = fakeInteraction({ customId: `harmony-manager:stray_kids:skzedittimezone:${eventId}`, kind: "select", guildId, values: ["Asia/Tokyo"] });
  await handleEventSchedulerInteraction(clearTimezone);
  const keepCategory = fakeInteraction({
    customId: `harmony-manager:stray_kids:editcategory:${eventId}`, kind: "select", guildId, values: ["content"],
  });
  await handleEventSchedulerInteraction(keepCategory);
  const clearMember = fakeInteraction({
    customId: `harmony-manager:stray_kids:editmember:${eventId}`, kind: "select", guildId, values: ["none"],
  });
  await handleEventSchedulerInteraction(clearMember);
  assert.equal(store.getEvent(guildId, eventId).member, null);
});

test("preselected Stray Kids edit values can be kept through every selector", async () => {
  const guildId = `manager-edit-keep-${Date.now()}`;
  store.setCalendarChannels(guildId, "calendar-stray-kids", "calendar-community");
  const eventId = store.createCalendarEvent({
    guildId, calendarChannelId: "calendar-stray-kids", title: "Keep Me",
    eventDate: "2099-06-01", eventAt: "2099-06-01T16:00:00.000Z", eventTimezone: "America/New_York",
    timezone: "America/New_York", calendarType: "stray_kids", category: "content", member: "han",
    createdBy: "admin",
  });
  const edit = fakeInteraction({ customId: "harmony-manager:stray_kids:edit", kind: "button", guildId });
  await handleEventSchedulerInteraction(edit);
  const select = fakeInteraction({ customId: "harmony-manager:stray_kids:editselect", kind: "select", guildId, values: [String(eventId)] });
  await handleEventSchedulerInteraction(select);
  const details = fakeInteraction({
    customId: `harmony-manager:stray_kids:editmodal:${eventId}`, kind: "modal", guildId,
    fields: { title: "Keep Me", "event-date": "2099-06-01", "event-time": "12:00", location: "New York, USA", description: "" },
  });
  await handleEventSchedulerInteraction(details);
  const timezone = fakeInteraction({ customId: `harmony-manager:stray_kids:skzedittimezone:${eventId}`, kind: "select", guildId, values: ["America/New_York"] });
  await handleEventSchedulerInteraction(timezone);
  const continueTimezone = fakeInteraction({ customId: `harmony-manager:stray_kids:editkeep:timezone:${eventId}`, kind: "button", guildId });
  await handleEventSchedulerInteraction(continueTimezone);
  assert.equal(continueTimezone.responses[0].type, "update");
  assert.match(continueTimezone.responses[0].payload.content, /category/i);
  const categoryOptions = continueTimezone.responses[0].payload.components[0].toJSON().components[0].options;
  assert.equal(categoryOptions.find((option) => option.default).value, "content");

  const continueCategory = fakeInteraction({ customId: `harmony-manager:stray_kids:editkeep:category:${eventId}`, kind: "button", guildId });
  await handleEventSchedulerInteraction(continueCategory);
  assert.match(continueCategory.responses[0].payload.content, /member/i);
  const memberOptions = continueCategory.responses[0].payload.components[0].toJSON().components[0].options;
  assert.equal(memberOptions.find((option) => option.default).value, "han");

  const continueMember = fakeInteraction({ customId: `harmony-manager:stray_kids:editkeep:member:${eventId}`, kind: "button", guildId });
  await handleEventSchedulerInteraction(continueMember);
  assert.equal(continueMember.responses[0].type, "update");
  assert.equal(store.getEvent(guildId, eventId).category, "content");
  assert.equal(store.getEvent(guildId, eventId).member, "han");
  assert.equal(store.getEvent(guildId, eventId).title, "Keep Me");
});

test("preselected Youtiful edit values can be kept without changing the event", async () => {
  const guildId = `community-edit-keep-${Date.now()}`;
  store.setCalendarChannels(guildId, "calendar-stray-kids", "calendar-community");
  const eventId = store.createCalendarEvent({
    guildId, calendarChannelId: "calendar-community", title: "Community Event", eventDate: "2099-06-02",
    eventAt: "2099-06-02T16:00:00.000Z", eventTimezone: "America/New_York", timezone: "America/New_York",
    calendarType: "community", calendarEventType: "kdrama", category: "community", eventChannelId: "cinema", createdBy: "admin",
  });
  const edit = fakeInteraction({ customId: "harmony-manager:community:edit", kind: "button", guildId });
  await handleEventSchedulerInteraction(edit);
  const select = fakeInteraction({ customId: "harmony-manager:community:editselect", kind: "select", guildId, values: [String(eventId)] });
  await handleEventSchedulerInteraction(select);
  const timezoneButton = fakeInteraction({ customId: `harmony-manager:community:edittzpick:${eventId}`, kind: "button", guildId });
  await handleEventSchedulerInteraction(timezoneButton);
  const timezoneOptions = timezoneButton.responses[0].payload.components[0].toJSON().components[0].options;
  assert.equal(timezoneOptions.find((option) => option.default).value, "America/New_York");
  const keepTimezone = fakeInteraction({ customId: `harmony-manager:community:editkeep:timezone:${eventId}`, kind: "button", guildId });
  await handleEventSchedulerInteraction(keepTimezone);
  assert.match(keepTimezone.responses[0].payload.content, /EDIT EVENT/);

  const typeButton = fakeInteraction({ customId: `harmony-manager:community:edittypepick:${eventId}`, kind: "button", guildId });
  await handleEventSchedulerInteraction(typeButton);
  const keepType = fakeInteraction({ customId: `harmony-manager:community:editkeep:type:${eventId}`, kind: "button", guildId });
  await handleEventSchedulerInteraction(keepType);
  assert.match(keepType.responses[0].payload.content, /EDIT EVENT/);

  const channelButton = fakeInteraction({ customId: `harmony-manager:community:editchannelpick:${eventId}`, kind: "button", guildId });
  await handleEventSchedulerInteraction(channelButton);
  const keepChannel = fakeInteraction({ customId: `harmony-manager:community:editkeep:channel:${eventId}`, kind: "button", guildId });
  await handleEventSchedulerInteraction(keepChannel);
  assert.match(keepChannel.responses[0].payload.content, /EDIT EVENT/);
  const saved = store.getEvent(guildId, eventId);
  assert.equal(saved.event_timezone, "America/New_York");
  assert.equal(saved.calendar_event_type, "kdrama");
  assert.equal(saved.event_channel_id, "cinema");
});

test("expired Keep Current edit controls fail safely", async () => {
  const interaction = fakeInteraction({ customId: "harmony-manager:stray_kids:editkeep:member:999999", kind: "button", guildId: `expired-edit-${Date.now()}` });
  await handleEventSchedulerInteraction(interact…16103 tokens truncated…ve delivery evidence in the selected channel", async () => {
  const event = { id: 43, event_channel_id: "cinema", discord_event_id: null };
  const delivered = { id: "target", isTextBased: () => true, isSendable: () => true, send: async () => ({ id: "message-1", channelId: "target" }) };
  assert.equal(await sendImmediateCalendarAnnouncement(delivered, event, "guild", "Delivered"), true);

  const wrongDestination = { id: "target", isTextBased: () => true, isSendable: () => true, send: async () => ({ id: "message-2", channelId: "other" }) };
  assert.equal(await sendImmediateCalendarAnnouncement(wrongDestination, event, "guild", "Wrong destination"), false);

  const unconfirmed = { id: "target", isTextBased: () => true, isSendable: () => true, send: async () => ({}) };
  assert.equal(await sendImmediateCalendarAnnouncement(unconfirmed, event, "guild", "Unconfirmed"), false);
});

test("Review Event keeps reconciliation controls private and stale reviewers are blocked", async () => {
  const guildId = `native-review-${Date.now()}`;
  const sent = [];
  const channel = { isTextBased: () => true, send: async (payload) => { sent.push(payload); return { id: "review-notice" }; } };
  const candidateId = store.createCalendarEvent({ guildId, calendarChannelId: "calendar", title: "Private review", eventDate: "2099-10-20", eventAt: "2099-10-20T23:00:00.000Z", eventTimezone: "UTC", timezone: "UTC", calendarType: "community", category: "other", createdBy: "admin" });
  const native = { guildId, id: "private-review-event", name: "Private review", scheduledStartAt: new Date("2099-10-20T23:00:00Z") };
  const guild = {
    channels: { cache: new Map([["control", channel]]), fetch: async () => channel },
    scheduledEvents: { fetch: async () => native },
  };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  store.setReconciliationChannel(guildId, "control");
  await handleGuildScheduledEventCreate(client, native);
  assert.equal(sent[0].components[0].toJSON().components[0].label, "Review Event");

  const review = fakeInteraction({ customId: `harmony-manager:community:reviewnative:${native.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(review);
  assert.equal(review.responses[0].type, "reply");
  assert.equal(review.responses[0].payload.flags, 64);
  const linkId = review.responses[0].payload.components[0].toJSON().components[0].custom_id;
  assert.match(linkId, /linknative/);

  const link = fakeInteraction({ customId: linkId, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(link);
  assert.equal(link.responses[0].type, "modal");
  const linkSubmit = fakeInteraction({ customId: link.responses[0].modal.toJSON().custom_id, kind: "modal", guildId, guild, client, fields: { description: "" } });
  await handleEventSchedulerInteraction(linkSubmit);
  assert.equal(linkSubmit.responses[0].type, "reply");
  assert.match(linkSubmit.responses[0].payload.content, /Linked/);
  assert.ok(store.getEvent(guildId, candidateId).discord_event_id);

  const stale = fakeInteraction({ customId: `harmony-manager:community:reviewnative:${native.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(stale);
  assert.equal(stale.responses[0].payload.flags, 64);
  assert.match(stale.responses[0].payload.content, /already been reviewed/);

  const missingGuild = { ...guild, scheduledEvents: { fetch: async () => null } };
  const missing = fakeInteraction({ customId: `harmony-manager:community:reviewnative:missing-event`, kind: "button", guildId, guild: missingGuild, client });
  store.saveDiscordEventReconciliation(guildId, "missing-event", "missing-notice", "open");
  await handleEventSchedulerInteraction(missing);
  assert.equal(missing.responses[0].payload.flags, 64);
  assert.match(missing.responses[0].payload.content, /no longer available/);
});

test("Review Event Add to Calendar and Ignore remain private and durable", async () => {
  const guildId = `native-review-actions-${Date.now()}`;
  const notices = [];
  const channel = { isTextBased: () => true, send: async (payload) => { notices.push(payload); return { id: `notice-${notices.length}` }; } };
  const native = { guildId, id: "private-add-event", name: "Unmatched event", description: "From Discord", scheduledStartAt: new Date("2099-10-21T23:00:00Z") };
  const ignored = { guildId, id: "private-ignore-event", name: "Ignored event", scheduledStartAt: new Date("2099-10-22T23:00:00Z") };
  const guild = { channels: { cache: new Map([["control", channel]]), fetch: async () => channel }, scheduledEvents: { fetch: async (id) => id === native.id ? native : ignored } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  store.setReconciliationChannel(guildId, "control");

  await handleGuildScheduledEventCreate(client, native);
  const review = fakeInteraction({ customId: `harmony-manager:community:reviewnative:${native.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(review);
  const reviewLabels = review.responses[0].payload.components.flatMap((row) => row.toJSON().components.map((component) => component.label || component.placeholder));
  assert.deepEqual(reviewLabels, ["Add to Calendar", "Ignore"]);
  const add = fakeInteraction({ customId: `harmony-manager:community:nativeadd:${native.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(add);
  assert.equal(add.responses[0].type, "modal");
  const addSubmit = fakeInteraction({ customId: add.responses[0].modal.toJSON().custom_id, kind: "modal", guildId, guild, client, fields: { description: "From Discord" } });
  await handleEventSchedulerInteraction(addSubmit);
  assert.match(addSubmit.responses[0].payload.content, /Would you like to schedule announcements/);
  assert.equal(store.getDiscordEventReconciliation(guildId, native.id).status, "added");

  await handleGuildScheduledEventCreate(client, ignored);
  const ignore = fakeInteraction({ customId: `harmony-manager:community:nativedismiss:${ignored.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(ignore);
  assert.equal(ignore.responses[0].type, "update");
  assert.match(ignore.responses[0].payload.content, /left unchanged/);
  assert.equal(store.getDiscordEventReconciliation(guildId, ignored.id).status, "dismissed");
});

test("reconciliation Add to Calendar enters the canonical announcement flow", async () => {
  const guildId = `native-add-announcements-${Date.now()}`;
  const notices = [];
  const noticeEdits = [];
  const immediate = [];
  const control = {
    isTextBased: () => true,
    send: async (payload) => { notices.push(payload); return { id: "reconciliation-notice" }; },
    messages: { fetch: async () => ({ edit: async (payload) => { noticeEdits.push(payload); } }) },
  };
  const voice = {
    isTextBased: () => true,
    isSendable: () => true,
    send: async (payload) => { immediate.push(payload); return { id: "immediate-announcement" }; },
  };
  const native = { guildId, id: "native-add-announcements", name: "Canonical Add", description: "Watch together", scheduledStartAt: new Date("2099-11-20T23:00:00Z") };
  const guild = {
    channels: { cache: new Map([["control", control], ["cinema", voice]]), fetch: async (id) => guild.channels.cache.get(id) },
    scheduledEvents: { fetch: async () => native },
  };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  store.setReconciliationChannel(guildId, "control");
  await handleGuildScheduledEventCreate(client, native);

  const review = fakeInteraction({ customId: `harmony-manager:community:reviewnative:${native.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(review);
  const add = fakeInteraction({ customId: `harmony-manager:community:nativeadd:${native.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(add);
  const addSubmit = fakeInteraction({ customId: add.responses[0].modal.toJSON().custom_id, kind: "modal", guildId, guild, client, fields: { description: "Watch together" } });
  await handleEventSchedulerInteraction(addSubmit);
  assert.match(addSubmit.responses[0].payload.content, /Would you like to schedule announcements/);

  const added = store.getEventByDiscordId(guildId, native.id);
  assert.ok(added);
  await handleEventSchedulerInteraction(fakeInteraction({ customId: `harmony-manager:community:ysannounce:${added.id}`, kind: "button", guildId, guild, client }));
  await handleEventSchedulerInteraction(fakeInteraction({ customId: `harmony-manager:community:ysannouncemodal:${added.id}`, kind: "modal", guildId, guild, client, fields: { "announcement-message": "Canonical announcement" } }));
  await handleEventSchedulerInteraction(fakeInteraction({ customId: `harmony-manager:community:ysannouncechannel:${added.id}`, kind: "channel", guildId, guild, client, values: ["cinema"] }));
  const timing = fakeInteraction({ customId: `harmony-manager:community:ysannouncetiming:${added.id}`, kind: "select", guildId, guild, client, values: ["now", "604800", "259200", "86400", "3600"] });
  await handleEventSchedulerInteraction(timing);

  const saved = store.getEvent(guildId, added.id);
  assert.equal(immediate.length, 1);
  assert.match(immediate[0].content, /Canonical announcement/);
  assert.equal(saved.announcement_channel_id, "cinema");
  assert.deepEqual(JSON.parse(saved.announcement_offsets), [604800, 259200, 86400, 3600]);
  assert.match(timing.responses[0].payload.content, /Event created and announcements scheduled/);
  assert.match(noticeEdits[0].content, /has been reviewed/);
  assert.equal(notices.length, 1);
});

test("reconciliation Link Existing enters the canonical flow and preserves future schedules on Announce Now failure", async () => {
  const guildId = `native-link-announcements-${Date.now()}`;
  const noticeEdits = [];
  const candidateId = store.createCalendarEvent({ guildId, calendarChannelId: "calendar", title: "Canonical Link", eventDate: "2099-11-21", eventAt: "2099-11-21T23:00:00.000Z", eventTimezone: "UTC", timezone: "UTC", calendarType: "community", category: "other", createdBy: "admin" });
  const control = {
    isTextBased: () => true,
    send: async () => ({ id: "reconciliation-notice" }),
    messages: { fetch: async () => ({ edit: async (payload) => { noticeEdits.push(payload); } }) },
  };
  const blocked = { isTextBased: () => true, isSendable: () => true, send: async () => { throw new Error("missing Send Messages"); } };
  const native = { guildId, id: "native-link-announcements", name: "Canonical Link", scheduledStartAt: new Date("2099-11-21T23:00:00Z") };
  const guild = { channels: { cache: new Map([["control", control], ["server-updates", blocked]]), fetch: async (id) => guild.channels.cache.get(id) }, scheduledEvents: { fetch: async () => native } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  store.setReconciliationChannel(guildId, "control");
  await handleGuildScheduledEventCreate(client, native);

  const review = fakeInteraction({ customId: `harmony-manager:community:reviewnative:${native.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(review);
  const linkId = review.responses[0].payload.components[0].toJSON().components[0].custom_id;
  const link = fakeInteraction({ customId: linkId, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(link);
  const linkSubmit = fakeInteraction({ customId: link.responses[0].modal.toJSON().custom_id, kind: "modal", guildId, guild, client, fields: { description: "Link announcement" } });
  await handleEventSchedulerInteraction(linkSubmit);
  assert.match(linkSubmit.responses[0].payload.content, /Would you like to schedule announcements/);

  await handleEventSchedulerInteraction(fakeInteraction({ customId: `harmony-manager:community:ysannounce:${candidateId}`, kind: "button", guildId, guild, client }));
  await handleEventSchedulerInteraction(fakeInteraction({ customId: `harmony-manager:community:ysannouncemodal:${candidateId}`, kind: "modal", guildId, guild, client, fields: { "announcement-message": "Link announcement" } }));
  await handleEventSchedulerInteraction(fakeInteraction({ customId: `harmony-manager:community:ysannouncechannel:${candidateId}`, kind: "channel", guildId, guild, client, values: ["server-updates"] }));
  const timing = fakeInteraction({ customId: `harmony-manager:community:ysannouncetiming:${candidateId}`, kind: "select", guildId, guild, client, values: ["now", "604800", "259200", "86400", "3600"] });
  await handleEventSchedulerInteraction(timing);

  const saved = store.getEvent(guildId, candidateId);
  assert.equal(saved.announcement_channel_id, "server-updates");
  assert.deepEqual(JSON.parse(saved.announcement_offsets), [604800, 259200, 86400, 3600]);
  assert.match(timing.responses[0].payload.content, /future announcements were scheduled, but Harmony could not post the announcement now/);
  assert.match(noticeEdits[0].content, /has been reviewed/);
});

test("multiple Review Event matches open the private candidate selector only after Link Existing", async () => {
  const guildId = `native-review-multiple-${Date.now()}`;
  const channel = { isTextBased: () => true, send: async () => ({ id: "multiple-review-notice" }) };
  for (const eventDate of ["2099-10-23", "2099-10-24"]) {
    store.createCalendarEvent({ guildId, calendarChannelId: "calendar", title: "Repeated title", eventDate, eventAt: `${eventDate}T23:00:00.000Z`, eventTimezone: "UTC", timezone: "UTC", calendarType: "community", category: "other", createdBy: "admin" });
  }
  const native = { guildId, id: "multiple-review-event", name: "Repeated title", scheduledStartAt: new Date("2099-10-25T23:00:00Z") };
  const guild = { channels: { cache: new Map([["control", channel]]), fetch: async () => channel }, scheduledEvents: { fetch: async () => native } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  store.setReconciliationChannel(guildId, "control");
  await handleGuildScheduledEventCreate(client, native);

  const review = fakeInteraction({ customId: `harmony-manager:community:reviewnative:${native.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(review);
  const initial = review.responses[0].payload.components[0].toJSON().components;
  assert.deepEqual(initial.map((component) => component.label), ["Link Existing", "Add to Calendar", "Ignore"]);
  assert.equal(initial.some((component) => component.options), false);

  const choose = fakeInteraction({ customId: `harmony-manager:community:nativechoose:${native.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(choose);
  assert.equal(choose.responses[0].type, "update");
  const selector = choose.responses[0].payload.components[0].toJSON().components[0];
  assert.equal(selector.type, 3);
  assert.equal(selector.options.length, 2);

  const selected = fakeInteraction({ customId: selector.custom_id, kind: "select", guildId, guild, client, values: [selector.options[0].value] });
  await handleEventSchedulerInteraction(selected);
  assert.equal(selected.responses[0].type, "modal");
  const selectedSubmit = fakeInteraction({ customId: selected.responses[0].modal.toJSON().custom_id, kind: "modal", guildId, guild, client, fields: { description: "" } });
  await handleEventSchedulerInteraction(selectedSubmit);
  assert.match(selectedSubmit.responses[0].payload.content, /Linked/);
  assert.equal(store.getDiscordEventReconciliation(guildId, native.id).status, "linked");
});

test("Discord-first reconciliation uses only the configured channel and fails closed when unset", async () => {
  const guildId = `native-config-${Date.now()}`;
  const firstSent = [];
  const secondSent = [];
  const first = { isTextBased: () => true, send: async (payload) => { firstSent.push(payload); return { id: "first-notice" }; } };
  const second = { isTextBased: () => true, send: async (payload) => { secondSent.push(payload); return { id: "second-notice" }; } };
  const guild = { channels: { cache: new Map([["first", first], ["second", second]]), fetch: async (id) => guild.channels.cache.get(id) } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  const event = { guildId, id: "manual-config-event", name: "Configured destination", scheduledStartAt: new Date("2099-11-01T20:00:00Z") };

  await handleGuildScheduledEventCreate(client, event);
  assert.equal(firstSent.length + secondSent.length, 0);

  store.setReconciliationChannel(guildId, "first");
  await handleGuildScheduledEventCreate(client, { ...event, id: "manual-config-event-1" });
  assert.equal(firstSent.length, 1);
  assert.equal(secondSent.length, 0);

  store.setReconciliationChannel(guildId, "second");
  await handleGuildScheduledEventCreate(client, { ...event, id: "manual-config-event-2" });
  assert.equal(firstSent.length, 1);
  assert.equal(secondSent.length, 1);
});

test("Youtiful announcement schedules are independent, multi-selectable, and cancelled safely", () => {
  const guildId = `calendar-announcements-${Date.now()}`;
  const eventId = store.createCalendarEvent({ guildId, calendarChannelId: "calendar", title: "Watch party", eventDate: "2099-10-18", eventAt: "2099-10-18T23:00:00.000Z", eventTimezone: "UTC", timezone: "UTC", calendarType: "community", category: "community", eventChannelId: "cinema", createdBy: "admin" });
  const event = store.getEvent(guildId, eventId);
  const items = [604800, 259200, 86400, 3600, 0].filter((offset) => offset > 0).map((offset) => ({ scheduledFor: new Date(new Date(event.event_at).getTime() - offset * 1000).toISOString(), message: `Reminder ${offset}` }));
  const saved = store.saveEventAnnouncements(guildId, eventId, "announcements", [604800, 259200, 86400, 3600, 0], items, "Custom reminder copy");
  assert.equal(saved.announcement_channel_id, "announcements");
  assert.deepEqual(JSON.parse(saved.announcement_offsets), [604800, 259200, 86400, 3600]);
  assert.equal(saved.announcement_message, "Custom reminder copy");
  assert.equal(store.dueAnnouncements("2099-01-01T00:00:00.000Z").length, 0);
  assert.equal(store.cancelEvent(guildId, eventId, "admin"), true);
  assert.equal(store.dueAnnouncements("2100-01-01T00:00:00.000Z").some((item) => item.event_id === eventId), false);
});

test("legacy offset zero never becomes an automatic starting-now announcement and custom copy survives rebuild", () => {
  const guildId = `announcement-legacy-${Date.now()}`;
  const eventId = store.createCalendarEvent({ guildId, calendarChannelId: "calendar", title: "Watch party", eventDate: "2099-10-18", eventAt: "2099-10-18T23:00:00.000Z", eventTimezone: "UTC", timezone: "UTC", calendarType: "community", category: "community", createdBy: "admin" });
  store.updateEvent(guildId, eventId, { announcement_offsets: JSON.stringify([0, 86400]), announcement_message: "Come watch together!", announcement_channel_id: "announcements" });
  const legacy = store.getEvent(guildId, eventId);
  const future = [86400, 0].map((offset) => ({ scheduledFor: new Date(new Date(legacy.event_at).getTime() - offset * 1000).toISOString(), message: "Come watch together!" }));
  store.saveEventAnnouncements(guildId, eventId, "announcements", [0, 86400], future, legacy.announcement_message);
  const saved = store.getEvent(guildId, eventId);
  assert.deepEqual(JSON.parse(saved.announcement_offsets), [86400]);
  assert.equal(saved.announcement_message, "Come watch together!");
  const dueAtStart = store.dueAnnouncements("2099-10-18T23:00:00.000Z").filter((item) => item.event_id === eventId);
  assert.equal(dueAtStart.some((item) => item.scheduled_for === legacy.event_at), false);
  const legacyPendingId = store.createEvent({ guildId, sourceChannelId: "calendar", destinationChannelId: "calendar", title: "Legacy starting-now", link: "", timezone: "UTC", eventAt: legacy.event_at, eventDate: legacy.event_date, eventTimezone: "UTC", calendarType: "community", category: "community", createdBy: "admin", announcements: [{ scheduledFor: legacy.event_at, message: "Legacy start notice" }] });
  assert.equal(store.dueAnnouncements(legacy.event_at).some((item) => item.event_id === legacyPendingId), false);
});

test("Add to Calendar links the existing Discord event without creating another native event", async () => {
  const guildId = `native-add-${Date.now()}`;
  const native = { id: "native-existing", name: "Discord watch party", description: "From Discord", scheduledStartAt: new Date("2099-10-18T23:00:00Z"), scheduledEndAt: new Date("2099-10-19T00:00:00Z") };
  let creates = 0;
  const guild = { scheduledEvents: { fetch: async () => native, create: async () => { creates += 1; return { id: "should-not-create" }; } } };
  const interaction = fakeInteraction({ customId: `harmony-manager:community:nativeadd:${native.id}`, kind: "button", guildId, guild });
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  interaction.client = client;
  store.setCalendarChannels(guildId, "skz", "community");
  store.setManagerChannel(guildId, "control");
  store.saveDiscordEventReconciliation(guildId, native.id, "notice", "open");
  await handleEventSchedulerInteraction(interaction);
  assert.equal(interaction.responses[0].type, "modal");
  const submit = fakeInteraction({ customId: interaction.responses[0].modal.toJSON().custom_id, kind: "modal", guildId, guild, client, fields: { description: "Episodes 5 & 6" } });
  await handleEventSchedulerInteraction(submit);
  const linked = store.getEventByDiscordId(guildId, native.id);
  assert.ok(linked);
  assert.equal(linked.description, "Episodes 5 & 6");
  assert.equal(creates, 0);
  assert.match(submit.responses[0].payload.content, /Would you like to schedule announcements/);
});

test("Discord adoption pre-fills and stores a Harmony-only description without editing Discord", async () => {
  const guildId = `native-description-${Date.now()}`;
  const native = {
    id: "native-description-event",
    name: "Doom at Your Service",
    description: "Hello! Bring snacks and tissues!",
    scheduledStartAt: new Date("2099-12-10T23:00:00Z"),
  };
  let nativeEdits = 0;
  native.edit = async () => { nativeEdits += 1; };
  const guild = { scheduledEvents: { fetch: async () => native } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  store.saveDiscordEventReconciliation(guildId, native.id, "notice", "open");
  const add = fakeInteraction({ customId: `harmony-manager:community:nativeadd:${native.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(add);
  const modal = add.responses[0].modal.toJSON();
  assert.equal(modal.title, "Harmony calendar description");
  assert.equal(modal.components[0].components[0].value, native.description);
  const submit = fakeInteraction({ customId: modal.custom_id, kind: "modal", guildId, guild, client, fields: { description: "Episodes 5 & 6" } });
  await handleEventSchedulerInteraction(submit);
  assert.equal(store.getEventByDiscordId(guildId, native.id).description, "Episodes 5 & 6");
  assert.equal(native.description, "Hello! Bring snacks and tissues!");
  assert.equal(nativeEdits, 0);
});

test("adopting a recurring occurrence already projected in Harmony reuses its series anchor", async () => {
  const guildId = `native-dedupe-series-${Date.now()}`;
  const seriesId = `existing-series-${Date.now()}`;
  const anchorId = store.createCalendarEvent({
    guildId, calendarChannelId: "calendar", title: "Friday K-Drama", eventDate: "2099-12-03",
    eventAt: "2099-12-03T23:00:00.000Z", eventTimezone: "UTC", timezone: "UTC", calendarType: "community",
    category: "community", createdBy: "admin", recurrenceSeriesId: seriesId,
    recurrenceRule: JSON.stringify({ source: "discord", startAt: "2099-12-03T23:00:00.000Z", frequency: 2, interval: 1, byWeekday: [4], count: 3 }), recurrenceIndex: 0,
  });
  const anchor = store.getEvent(guildId, anchorId);
  const projected = store.createSeriesOccurrence(guildId, seriesId, { occurrenceIndex: 1, eventAt: "2099-12-10T23:00:00.000Z", eventEndAt: null }, anchor);
  const native = { id: "native-recurring-dedupe", name: "Friday K-Drama", description: "Native details", scheduledStartAt: new Date(projected.event_at), recurrenceRule: { startAt: new Date("2099-12-03T23:00:00Z"), frequency: 2, interval: 1, byWeekday: [4], count: 3 } };
  const guild = { scheduledEvents: { fetch: async () => native } };
  const interaction = { guildId, user: { id: "admin" }, guild };
  const adopted = await addNativeEventToCalendar(interaction, native.id, "Episodes 3 & 4");
  assert.equal(adopted.id, anchor.id);
  assert.equal(store.listSeriesEvents(guildId, seriesId).length, 3);
  assert.equal(store.getEventByDiscordId(guildId, native.id).id, anchor.id);
  assert.equal(store.getEvent(guildId, anchor.id).description, "Episodes 3 & 4");
  const repeated = await addNativeEventToCalendar(interaction, native.id, "Different text");
  assert.equal(repeated.id, anchor.id);
  assert.equal(store.listSeriesEvents(guildId, seriesId).length, 3);
});

test("native adoption does not hijack an unrelated one-off event with the same title and time", async () => {
  const guildId = `native-dedupe-one-off-${Date.now()}`;
  const native = {
    id: "native-one-off-identity",
    name: "Friday K-Drama",
    description: "Native details",
    scheduledStartAt: new Date("2099-12-10T23:00:00.000Z"),
  };
  const ordinaryId = store.createCalendarEvent({
    guildId, calendarChannelId: "calendar", title: native.name, eventDate: "2099-12-10",
    eventAt: native.scheduledStartAt.toISOString(), eventTimezone: "UTC", timezone: "UTC",
    calendarType: "community", category: "community", createdBy: "admin",
  });
  const guild = { scheduledEvents: { fetch: async () => native } };
  const adopted = await addNativeEventToCalendar({ guildId, user: { id: "admin" }, guild }, native.id, "Episodes 5 & 6");
  assert.notEqual(adopted.id, ordinaryId);
  assert.equal(store.getEvent(guildId, ordinaryId).discord_event_id, null);
  assert.equal(store.getEventByDiscordId(guildId, native.id).id, adopted.id);
  assert.equal(adopted.description, "Episodes 5 & 6");
});


test("all-day Stray Kids edit keeps the legacy timezone and reaches Shopping category", async () => {
  const guildId = `all-day-edit-timezone-${Date.now()}`;
  const eventId = store.createCalendarEvent({
    guildId,
    calendarChannelId: "calendar-stray-kids",
    title: "ODD&FRESH POP-UP",
    eventDate: "2026-10-22",
    eventAt: null,
    eventTimezone: null,
    timezone: "Asia/Seoul",
    calendarType: "stray_kids",
    category: "other",
    allDay: true,
    createdBy: "admin",
  });

  const edit = fakeInteraction({ customId: "harmony-manager:stray_kids:edit", kind: "button", guildId });
  await handleEventSchedulerInteraction(edit);
  const select = fakeInteraction({ customId: "harmony-manager:stray_kids:editselect", kind: "select", guildId, values: [String(eventId)] });
  await handleEventSchedulerInteraction(select);
  const modal = fakeInteraction({
    customId: `harmony-manager:stray_kids:editmodal:${eventId}`, kind: "modal", guildId,
    fields: { title: "ODD&FRESH POP-UP", "event-date": "2026-10-22", "event-time": "", location: "", description: "" },
  });
  await handleEventSchedulerInteraction(modal);
  const keep = fakeInteraction({ customId: `harmony-manager:stray_kids:editkeep:timezone:${eventId}`, kind: "button", guildId });
  await handleEventSchedulerInteraction(keep);

  const saved = store.getEvent(guildId, eventId);
  assert.equal(saved.event_timezone, null);
  assert.equal(saved.timezone, "Asia/Seoul");
  assert.equal(keep.responses[0].type, "update");
  const categoryMenu = keep.responses[0].payload.components[0].toJSON().components[0];
  assert.ok(categoryMenu.options.some((option) => option.label === "🛍️ Shopping / Pop-Up"));

  const category = fakeInteraction({ customId: `harmony-manager:stray_kids:editcategory:${eventId}`, kind: "select", guildId, values: ["shopping"] });
  await handleEventSchedulerInteraction(category);
  assert.equal(store.getEvent(guildId, eventId).category, "shopping");

  const timedId = store.createCalendarEvent({
    guildId, calendarChannelId: "calendar-stray-kids", title: "Timed event", eventDate: "2026-10-23",
    eventAt: "2026-10-23T16:00:00.000Z", eventTimezone: "America/New_York", timezone: "America/New_York",
    calendarType: "stray_kids", category: "content", createdBy: "admin",
  });
  store.updateEvent(guildId, timedId, { timezone: "Asia/Tokyo", event_timezone: "Asia/Tokyo" });
  const timed = store.getEvent(guildId, timedId);
  assert.equal(timed.timezone, "Asia/Tokyo");
  assert.equal(timed.event_timezone, "Asia/Tokyo");
});


test("scheduled announcement countdown labels use the configured offset and preserve the announcement body", () => {
  assert.equal(formatAnnouncementCountdown(259200), "✨ 3 days to go!");
  assert.equal(formatAnnouncementCountdown(86400), "✨ Tomorrow!");
  assert.equal(formatAnnouncementCountdown(7200), "✨ 2 hours to go!");
  assert.equal(formatAnnouncementCountdown(3600), "✨ 1 hour to go!");
  assert.equal(formatAnnouncementCountdown(0), "✨ Today!");

  const event = {
    title: "Bang Chan & CHAOS",
    event_at: "2099-10-18T23:00:00.000Z",
    announcement_message: "Bring your lightstick!",
    event_channel_id: "cinema",
  };
  const source = require("../src/services/eventSchedulerService");
  const items = source.calendarAnnouncementItems(event, [259200, 86400, 3600]);
  assert.equal(items.length, 3);
  assert.equal(items[0].message, "@everyone\n✨ 3 days to go!\n🗓️ <t:4096047600:F>\nBring your lightstick!");
  assert.equal(items[1].message, "@everyone\n✨ Tomorrow!\n🗓️ <t:4096047600:F>\nBring your lightstick!");
  assert.equal(items[2].message, "@everyone\n✨ 1 hour to go!\n🗓️ <t:4096047600:F>\nBring your lightstick!");
});

test("scheduled announcement offsets remain unchanged when countdown labels are generated", () => {
  const guildId = `countdown-offsets-${Date.now()}`;
  const eventId = store.createCalendarEvent({
    guildId,
    calendarChannelId: "calendar",
    title: "Countdown event",
    eventDate: "2099-10-18",
    eventAt: "2099-10-18T23:00:00.000Z",
    eventTimezone: "UTC",
    timezone: "UTC",
    calendarType: "community",
    category: "community",
    createdBy: "admin",
  });
  const event = store.getEvent(guildId, eventId);
  event.announcement_message = "Countdown event details";
  const source = require("../src/services/eventSchedulerService");
  const offsets = [259200, 86400, 3600];
  const items = source.calendarAnnouncementItems(event, offsets);
  const saved = store.saveEventAnnouncements(guildId, eventId, "announcements", offsets, items, "Countdown event details");
  assert.deepEqual(JSON.parse(saved.announcement_offsets), offsets);
  assert.deepEqual(store.listAnnouncements(eventId).map((item) => item.message), [
    "@everyone\n✨ 3 days to go!\n🗓️ <t:4096047600:F>\nCountdown event details",
    "@everyone\n✨ Tomorrow!\n🗓️ <t:4096047600:F>\nCountdown event details",
    "@everyone\n✨ 1 hour to go!\n🗓️ <t:4096047600:F>\nCountdown event details",
  ]);
});

test("Discord recurrence rules expand into deterministic Harmony occurrences without native writes", () => {
  const occurrences = generateDiscordRecurringOccurrences({
    startAt: "2099-10-02T23:00:00.000Z",
    endAt: "2099-10-03T00:00:00.000Z",
    recurrenceRule: { frequency: 2, interval: 1, byWeekday: [4], count: 3 },
  });
  assert.deepEqual(occurrences.map((item) => item.eventAt), [
    "2099-10-02T23:00:00.000Z", "2099-10-09T23:00:00.000Z", "2099-10-16T23:00:00.000Z",
  ]);
});

test("adopted Discord recurring events project future calendar rows and reminders idempotently", async () => {
  const guildId = `native-series-${Date.now()}`;
  const native = {
    guildId,
    id: "native-recurring-series",
    name: "Recurring Watch Party",
    description: "Series description",
    scheduledStartAt: new Date("2099-10-02T23:00:00.000Z"),
    scheduledEndAt: new Date("2099-10-03T00:00:00.000Z"),
    recurrenceRule: { startAt: new Date("2099-10-02T23:00:00.000Z"), endAt: null, frequency: 2, interval: 1, byWeekday: [4], byNWeekday: null, byMonth: null, byMonthDay: null, byYearDay: null, count: 3 },
  };
  let nativeCreates = 0;
  const guild = { scheduledEvents: { fetch: async () => native, create: async () => { nativeCreates += 1; throw new Error("must not create native events"); } } };
  const interaction = { guildId, user: { id: "admin" }, guild };
  const anchorId = await addNativeEventToCalendar(interaction, native.id);
  const anchor = store.getEvent(guildId, anchorId.id);
  assert.equal(anchor.discord_event_id, native.id);
  assert.equal(Number(anchor.recurrence_native_enabled), 2);
  assert.equal(JSON.parse(anchor.recurrence_rule).source, "discord");
  assert.equal(store.listSeriesEvents(guildId, anchor.recurrence_series_id).length, 3);
  assert.deepEqual(store.listSeriesEvents(guildId, anchor.recurrence_series_id).map((row) => row.event_at), [
    "2099-10-02T23:00:00.000Z", "2099-10-09T23:00:00.000Z", "2099-10-16T23:00:00.000Z",
  ]);

  const firstReminder = store.saveEventAnnouncements(guildId, anchor.id, "cinema", [86400], [
    { scheduledFor: "2099-10-01T23:00:00.000Z", message: "@everyone\n✨ Tomorrow!\nWatch together" },
  ], "Watch together");
  const firstRow = store.listAnnouncements(anchor.id)[0];
  await syncDiscordRecurringSeries(guildId, store.getEvent(guildId, anchor.id));
  await syncDiscordRecurringSeries(guildId, store.getEvent(guildId, anchor.id));
  const rows = store.listSeriesEvents(guildId, anchor.recurrence_series_id);
  assert.equal(rows.length, 3);
  assert.equal(store.listAnnouncements(anchor.id)[0].id, firstRow.id);
  assert.equal(store.listAnnouncements(anchor.id)[0].scheduled_for, firstRow.scheduled_for);
  assert.equal(store.listAnnouncements(rows[1].id).length, 1);
  assert.equal(store.listAnnouncements(rows[2].id).length, 1);
  assert.equal(nativeCreates, 0);
  assert.ok(firstReminder);
});

test("Announce Now automatically sends exactly one real everyone mention", async () => {
  const sent = [];
  const channel = {
    id: "cinema",
    isTextBased: () => true,
    isSendable: () => true,
    send: async (payload) => { sent.push(payload); return { id: "msg", channelId: "cinema" }; },
  };
  const event = { id: 1, title: "K-Drama", event_at: "2099-10-03T19:00:00.000Z", event_channel_id: null, discord_event_id: null };
  assert.equal(normalizeCalendarAnnouncementBody("@everyone\nDon't forget!"), "Don't forget!");
  assert.equal(await sendImmediateCalendarAnnouncement(channel, event, "guild", "@everyone\nDon't forget!"), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /^@everyone\n🗓️ <t:4094737200:F>\nDon't forget!/);
  assert.equal((sent[0].content.match(/@everyone/g) || []).length, 1);
  assert.deepEqual(sent[0].allowedMentions, { parse: ["everyone"] });
});

test("announcement timing keeps the event's non-midnight instant when subtracting offsets", () => {
  const event = { event_at: "2099-10-03T19:00:00.000Z", title: "Timed event", announcement_message: "Details" };
  const items = require("../src/services/eventSchedulerService").calendarAnnouncementItems(event, [259200, 86400, 3600]);
  assert.deepEqual(items.map((item) => item.scheduledFor), [
    "2099-09-30T19:00:00.000Z", "2099-10-02T19:00:00.000Z", "2099-10-03T18:00:00.000Z",
  ]);
});


test("calendar announcements include each event's localized timestamp", () => {
  const source = require("../src/services/eventSchedulerService");
  const event = { event_at: "2099-10-03T19:00:00.000Z", title: "Timed event", announcement_message: "Details" };
  const items = source.calendarAnnouncementItems(event, [86400]);
  assert.equal(items[0].message, "@everyone\n✨ Tomorrow!\n🗓️ <t:4094737200:F>\nDetails");
  assert.equal((items[0].message.match(/@everyone/g) || []).length, 1);
});

test("recurring occurrence message overrides survive projection and can return to the series default", async () => {
  const guildId = `native-override-${Date.now()}`;
  const seriesId = `series-${Date.now()}`;
  const anchorId = store.createCalendarEvent({ guildId, calendarChannelId: "calendar", title: "Recurring Watch Party", eventDate: "2099-10-02", eventAt: "2099-10-02T23:00:00.000Z", eventTimezone: "UTC", timezone: "UTC", calendarType: "community", category: "community", createdBy: "admin", discordEventId: "native-override-series", recurrenceSeriesId: seriesId, recurrenceRule: JSON.stringify({ source: "discord", startAt: "2099-10-02T23:00:00.000Z", frequency: 2, interval: 1, byWeekday: [4], count: 3 }), recurrenceIndex: 0, recurrenceNativeEnabled: 2 });
  const anchor = store.getEvent(guildId, anchorId);
  const occurrence = store.createSeriesOccurrence(guildId, seriesId, { occurrenceIndex: 1, eventAt: "2099-10-09T23:00:00.000Z", eventEndAt: "2099-10-10T00:00:00.000Z" }, anchor);
  store.saveEventAnnouncements(guildId, anchor.id, "cinema", [86400], [], "Series default");
  store.saveEventAnnouncements(guildId, occurrence.id, "cinema", [86400], [{ scheduledFor: "2099-10-08T23:00:00.000Z", message: "old default" }], "Series default");
  store.updateEvent(guildId, occurrence.id, { announcement_message_override: "Episodes 1 & 2!" });
  store.refreshPendingAnnouncementMessages(occurrence.id, [{ scheduledFor: "2099-10-08T23:00:00.000Z", message: "Episodes 1 & 2!" }]);
  await syncDiscordRecurringSeries(guildId, store.getEvent(guildId, anchor.id));
  assert.equal(store.getEvent(guildId, occurrence.id).announcement_message_override, "Episodes 1 & 2!");
  assert.match(store.listAnnouncements(occurrence.id)[0].message, /Episodes 1 & 2!/);
  store.updateEvent(guildId, occurrence.id, { announcement_message_override: null });
  store.refreshPendingAnnouncementMessages(occurrence.id, [{ scheduledFor: "2099-10-08T23:00:00.000Z", message: "Series default" }]);
  await syncDiscordRecurringSeries(guildId, store.getEvent(guildId, anchor.id));
  assert.equal(store.getEvent(guildId, occurrence.id).announcement_message_override, null);
  assert.equal(store.listAnnouncements(occurrence.id)[0].message, "Series default");
});


test("occurrence override refreshes only pending reminder messages", () => {
  const guildId = `override-pending-${Date.now()}`;
  const eventId = store.createCalendarEvent({
    guildId, calendarChannelId: "calendar", title: "Override event", eventDate: "2099-10-03",
    eventAt: "2099-10-03T19:00:00.000Z", eventTimezone: "UTC", timezone: "UTC",
    calendarType: "community", category: "community", createdBy: "admin",
  });
  const pendingAt = "2099-10-02T19:00:00.000Z";
  const sentAt = "2099-10-01T19:00:00.000Z";
  store.saveEventAnnouncements(guildId, eventId, "cinema", [86400, 172800], [
    { scheduledFor: pendingAt, message: "old pending" },
    { scheduledFor: sentAt, message: "old sent" },
  ], "Series default");
  const sent = getDb().prepare("SELECT * FROM scheduled_announcements WHERE event_id = ? AND scheduled_for = ?").get(eventId, sentAt);
  store.markSending(sent.id);
  store.markSent(sent.id, "discord-message");
  store.refreshPendingAnnouncementMessages(eventId, [
    { scheduledFor: pendingAt, message: "occurrence override" },
    { scheduledFor: sentAt, message: "should not replace" },
  ]);
  const rows = getDb().prepare("SELECT * FROM scheduled_announcements WHERE event_id = ? ORDER BY scheduled_for").all(eventId);
  assert.equal(rows.find((row) => row.scheduled_for === pendingAt).message, "occurrence override");
  const sentRow = rows.find((row) => row.scheduled_for === sentAt);
  assert.equal(sentRow.message, "old sent");
  assert.equal(sentRow.status, "sent");
  assert.equal(rows.length, 2);
});
