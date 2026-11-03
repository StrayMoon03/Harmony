Warning: truncated output (original token count: 57884)
Total output lines: 3622

const test = require("node:test");
const assert = require("node:assert/strict");
const { ChannelType, GuildScheduledEventEntityType, GuildScheduledEventStatus } = require("discord.js");
const {
  parseEvent, localToUtc, buildCalendarMessages, parseManagerDraft,
  managerPanelContent, managerPanelComponents, managerCalendarType,
  managerModal, handleEventSchedulerInteraction, isEventSchedulerInteraction,
  installScheduleManagers, refreshConfiguredScheduleManagers, publishMonthlyCalendar, refreshPublishedCalendar,
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
  handleGuildScheduledEventUpdate,
  handleGuildScheduledEventDelete,
  registerScheduledEventListeners,
  markPendingNativeCreate,
  clearPendingNativeCreate,
  markPendingNativeDelete,
  announcementChannelMenu,
  announcementEventIds,
  announcementEditorModal,
  sendImmediateCalendarAnnouncement,
  addNativeEventToCalendar,
  upcomingCalendarEvents,
  nativeSeriesOccurrences,
  syncDiscordRecurringSeries,
  normalizeCalendarAnnouncementBody,
  processScheduledAnnouncements,
  formatAnnouncementCountdown,
  calendarDateInTimezone,
  calendarCutoffBoundary,
  nativeCutoffDate,
  nativeDescriptionOccurrences,
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

test("published Youtiful dates use the event instant in the local presentation timezone", () => {
  const friday = [
    ["2026-10-17T01:00:00.000Z", "Oct 16", "9:00 PM"],
    ["2026-10-24T01:00:00.000Z", "Oct 23", "9:00 PM"],
    ["2026-10-31T01:00:00.000Z", "Oct 30", "9:00 PM"],
    ["2026-11-07T01:00:00.000Z", "Nov 6", "8:00 PM"],
  ].map(([eventAt]) => ({
    calendar_event_type: "kdrama", event_at: eventAt,
    event_date: eventAt.slice(0, 10), event_timezone: "UTC", timezone: "UTC",
    discord_event_origin: "adopted", all_day: 0, title: "Friday series",
  }));
  const october = buildYoutifulCalendarMessages("2026-10", friday.slice(0, 3), Date.parse("2026-10-01T00:00:00Z"))[0].embeds[0];
  const november = buildYoutifulCalendarMessages("2026-11", friday.slice(3), Date.parse("2026-11-01T00:00:00Z"))[0].embeds[0];
  assert.match(october.description, /Oct 16/);
  assert.match(october.description, /Oct 23/);
  assert.match(october.description, /Oct 30/);
  assert.doesNotMatch(october.description, /Oct 17|Oct 24|Oct 31/);
  assert.match(october.description, /<t:1792198800:t>/);
  assert.match(november.description, /Nov 6/);
  assert.match(november.description, /<t:1794013200:t>/);
  assert.doesNotMatch(november.description, /<t:.*:R>/);
  assert.match(november.footer.text, /Last updated/);
  assert.doesNotMatch(november.footer.text, /<t:\d+:R>/);
});

test("published Youtiful month selection uses local dates without mutating event_at", () => {
  const guildId = `calendar-local-month-${Date.now()}`;
  const control = fakeChannel("control-local-month");
  const community = fakeChannel("community-local-month");
  store.setCalendarChannels(guildId, "stray-local-month", community.id);
  const guild = fakeGuild(guildId, [control, community]);
  const client = { guilds: { cache: new Map([[guildId, guild]]), fetch: async () => guild } };
  const eventAt = "2026-10-17T01:00:00.000Z";
  const id = store.createCalendarEvent({
    guildId, calendarChannelId: community.id, title: "Friday series", eventDate: "2026-10-17",
    eventAt, eventTimezone: "UTC", calendarType: "community", category: "kdrama",
    createdBy: "admin", discordEventOrigin: "adopted", allDay: false,
  });
  return publishMonthlyCalendar(client, guildId, "community", "2026-10")
    .then(() => community.messages.fetch("community-local-month-message-1"))
    .then((message) => {
      assert.match(message.payload.embeds[0].description, /Oct 16/);
      assert.doesNotMatch(message.payload.embeds[0].description, /Oct 17/);
      assert.equal(store.getEvent(guildId, id).event_at, eventAt);
    });
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
  assert.equal(calls[0].description, event.description);
});

test("adopted native description edits stay Harmony-only", async () => {
  const calls = [];
  const native = { entityType: GuildScheduledEventEntityType.External, edit: async (payload) => { calls.push(payload); } };
  const client = { guilds: { cache: new Map([["g", { scheduledEvents: { cache: new Map([["native-adopted", native]]) } }]]) } };
  await syncNativeScheduledEvent(client, {
    guild_id: "g", discord_event_id: "native-adopted", discord_event_origin: "adopted",
    event_at: "2026-10-24T09:30:00.000Z", title: "Adopted event", description: "Harmony-only details",
  });
  assert.equal(Object.hasOwn(calls[0], "description"), false);
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
  const strayRows = managerPanelComponents("stray_kids", "manager-panel-test").flatMap((row) => row.toJSON().components);
  const ids = strayRows.slice(0, 4).map((button) => button.custom_id);
  assert.deepEqual(ids, [
    "harmony-manager:stray_kids:add",
    "harmony-manager:stray_kids:view",
    "harmony-manager:stray_kids:edit",
    "harmony-manager:stray_kids:cancel",
  ]);
  assert.ok(strayRows.some((button) => button.custom_id === "harmony-manager:stray_kids:discovery-check"));
  assert.ok(strayRows.some((button) => button.custom_id === "harmony-manager:stray_kids:discovery-toggle"));
  assert.ok(strayRows.some((button) => button.custom_id === "harmony-manager:stray_kids:discovery-status"));
  const communityRows = managerPanelComponents("community").flatMap((row) => row.toJSON().components);
  assert.ok(communityRows.some((button) => button.custom_id === "harmony-manager:community:findnative"));
  assert.ok(!communityRows.some((button) => button.custom_id.includes(":discovery-")));
  const toggle = strayRows.find((button) => button.custom_id === "harmony-manager:stray_kids:discovery-toggle");
  assert.equal(toggle.label, "⏱️ Turn Discovery On");
});

test("calendar discovery controls persist toggle state and report status", async () => {
  const guildId = `discovery-controls-${Date.now()}`;
  const replies = [];
  const makeInteraction = (customId) => ({
    customId,
    guildId,
    user: { id: "admin" },
    memberPermissions: { has: () => true },
    isButton: () => true,
    reply: async (payload) => replies.push(payload),
  });
  await handleEventSchedulerInteraction(makeInteraction("harmony-manager:stray_kids:discovery-toggle"));
  await handleEventSchedulerInteraction(makeInteraction("harmony-manager:stray_kids:discovery-status"));
  assert.match(replies[0].content, /now \*\*on\*\*/);
  assert.match(replies[1].content, /discovery is \*\*enabled\*\*/);
  const toggle = managerPanelComponents("stray_kids", guildId).flatMap((row) => row.toJSON().components)
    .find((button) => button.custom_id === "harmony-manager:stray_kids:discovery-toggle");
  assert.equal(toggle.label, "⏸️ Turn Discovery Off");
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
    isRoleSelectMenu: () => kind === "role",
    isUserSelectMenu: () => kind === "user",
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

test("outer scheduler routing accepts Birthday Manager user and role selectors", async () => {
  const guildId = `birthday-router-${Date.now()}`;
  const modes = ["add", "customize", "clear", "preview", "matchmember"];
  for (const mode of modes) {
    const interaction = fakeInteraction({
      customId: `harmony-manager:community:birthdaymember:${mode}`,
      kind: "user",
      guildId,
      values: ["100001"],
    });
    assert.equal(isEventSchedulerInteraction(interaction), true);
    await handleEventSchedulerInteraction(interaction);
    assert.equal(interaction.responses.length, 1);
    assert.ok(["update", "modal"].includes(interaction.responses[0].type));
  }

  const role = fakeInteraction({
    customId: "harmony-manager:community:birthdaysettingsrole",
    kind: "role",
    guildId,
    values: ["role-100001"],
  });
  assert.equal(isEventSchedulerInteraction(role), true);
  await handleEventSchedulerInteraction(role);
  assert.equal(role.responses[0].type, "update");
});

async function nativeAdoptionModal({ add, nativeId, scope, guildId, guild, client, userId = "admin", timezone = "America/New_York" }) {
  const scopeMenu = add.responses.at(-1).payload.components[0].toJSON().components[0];
  if (scopeMenu.custom_id.includes(":nativeaddtimezone:")) {
    const chooseTimezone = fakeInteraction({ customId: scopeMenu.custom_id, kind: "select", guildId, guild, client, userId, values: [timezone] });
    await handleEventSchedulerInteraction(chooseTimezone);
    return chooseTimezone.responses.at(-1).modal;
  }
  const chooseScope = fakeInteraction({ customId: scopeMenu.custom_id, kind: "select", guildId, guild, client, userId, values: [scope] });
  await handleEventSchedulerInteraction(chooseScope);
  const timezoneMenu = chooseScope.responses.at(-1).payload.components[0].toJSON().components[0];
  const chooseTimezone = fakeInteraction({ customId: timezoneMenu.custom_id, kind: "select", guildId, guild, client, userId, values: [timezone] });
  await handleEventSchedulerInteraction(chooseTimezone);
  return chooseTimezone.responses.at(-1).modal;
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
  await handleEventSchedulerInteraction(interaction);
  assert.match(interaction.responses[0].payload.content, /expired|available/i);
});

function fakeChannel(id) {
  const messages = new Map();
  let sequence = 0;
  return {
    id,
    sent: [],
    messages: {
      fetch: async (messageId) => {
        const message = messages.get(messageId);
        if (!message) throw new Error("missing message");
        return message;
      },
    },
    isTextBased: () => true,
    send: async (payload) => {
      const message = {
        id: `${id}-message-${++sequence}`,
        payload,
        edit: async (next) => { message.payload = next; return message; },
        delete: async () => { messages.delete(message.id); },
      };
      messages.set(message.id, message);
      return message;
    },
    messageCount: () => messages.size,
  };
}

function fakeGuild(id, channels) {
  const cache = new Map(channels.map((channel) => [channel.id, channel]));
  return { id, channels: { cache, fetch: async (channelId) => cache.get(channelId) || null } };
}

test("both managers use one control channel, reuse panels, and recreate deleted panels", async () => {
  const guildId = `manager-location-${Date.now()}`;
  const control = fakeChannel("control");
  const strayKids = fakeChannel("public-stray-kids");
  const community = fakeChannel("public-community");
  store.setCalendarChannels(guildId, strayKids.id, community.id);
  store.setManagerChannel(guildId, control.id);
  const guild = fakeGuild(guildId, [control, strayKids, community]);

  const first = await installScheduleManagers(guild);
  assert.deepEqual(first.map((item) => item.channelId), [control.id, control.id]);
  assert.equal(control.messageCount(), 2);
  assert.equal(strayKids.messageCount(), 0);
  assert.equal(community.messageCount(), 0);

  const ids = first.map((item) => item.messageId);
  const second = await installScheduleManagers(guild);
  assert.deepEqual(second.map((item) => item.messageId), ids);
  assert.equal(control.messageCount(), 2);

  await control.messages.fetch(ids[0]).then((message) => message.delete());
  const third = await installScheduleManagers(guild);
  assert.notEqual(third[0].messageId, ids[0]);
  assert.equal(control.messageCount(), 2);
  assert.equal(strayKids.messageCount(), 0);
  assert.equal(community.messageCount(), 0);
});

test("startup refresh updates only already-configured manager panels", async () => {
  const guildId = `manager-startup-refresh-${Date.now()}`;
  const control = fakeChannel("startup-refresh-control");
  store.setManagerChannel(guildId, control.id);
  const guild = fakeGuild(guildId, [control]);
  const installed = await installScheduleManagers(guild);
  const beforeIds = installed.map(({ messageId }) => messageId);
  const stale = await control.messages.fetch(beforeIds[0]);
  stale.payload = { content: "stale", components: [] };

  const refreshed = await refreshConfiguredScheduleManagers(guild);
  assert.deepEqual(refreshed.map(({ messageId }) => messageId), beforeIds);
  assert.equal(control.messageCount(), 2);
  const updated = await control.messages.fetch(beforeIds[0]);
  assert.match(updated.payload.content, /STRAY KIDS SCHEDULE MANAGER/);
  assert.ok(updated.payload.components.flatMap((row) => row.toJSON().components)
    .some((button) => button.custom_id === "harmony-manager:stray_kids:discovery-check"));
});

test("startup refresh does not create panels for an unconfigured manager", async () => {
  const guildId = `manager-startup-unconfigured-${Date.now()}`;
  const control = fakeChannel("startup-unconfigured-control");
  store.setManagerChannel(guildId, control.id);
  const guild = fakeGuild(guildId, [control]);
  assert.deepEqual(await refreshConfiguredScheduleManagers(guild), []);
  assert.equal(control.messageCount(), 0);
});

test("startup refresh skips stale references without creating messages", async () => {
  const guildId = `manager-startup-stale-${Date.now()}`;
  const control = fakeChannel("startup-stale-control");
  store.saveManagerPanel(guildId, "stray_kids", "missing-channel", "missing-message");
  const guild = fakeGuild(guildId, [control]);
  assert.deepEqual(await refreshConfiguredScheduleManagers(guild), []);
  assert.equal(control.messageCount(), 0);
});

test("startup refresh edit failures are nonfatal", async () => {
  const guildId = `manager-startup-failure-${Date.now()}`;
  const control = fakeChannel("startup-failure-control");
  store.saveManagerPanel(guildId, "community", control.id, "message-1");
  control.messages.fetch = async () => ({ edit: async () => { throw new Error("edit denied"); } });
  const guild = fakeGuild(guildId, [control]);
  await assert.doesNotReject(() => refreshConfiguredScheduleManagers(guild));
});

test("published calendars still target public calendar channels", async () => {
  const guildId = `publication-target-${Date.now()}`;
  const control = fakeChannel("control-publication");
  const strayKids = fakeChannel("calendar-stray-kids");
  const community = fakeChannel("calendar-community");
  store.setCalendarChannels(guildId, strayKids.id, community.id);
  store.setManagerChannel(guildId, control.id);
  const guild = fakeGuild(guildId, [control, strayKids, community]);
  const client = { guilds: { cache: new Map([[guildId, guild]]), fetch: async () => guild } };
  await publishMonthlyCalendar(client, guildId, "stray_kids", "2099-12");
  assert.equal(strayKids.messageCount(), 1);
  assert.equal(community.messageCount(), 0);
  assert.equal(control.messageCount(), 0);
});

test("adding events refreshes the existing published calendar without duplicating it", async () => {
  const guildId = `calendar-refresh-${Date.now()}`;
  const control = fakeChannel("control-refresh");
  const strayKids = fakeChannel("calendar-refresh-stray-kids");
  const community = fakeChannel("calendar-refresh-community");
  store.setCalendarChannels(guildId, strayKids.id, community.id);
  const guild = fakeGuild(guildId, [control, strayKids, community]);
  const client = { guilds: { cache: new Map([[guildId, guild]]), fetch: async () => guild } };

  await publishMonthlyCalendar(client, guildId, "stray_kids", "2026-10");
  assert.equal(strayKids.messageCount(), 1);
  const originalMessage = await strayKids.messages.fetch("calendar-refresh-stray-kids-message-1");

  const allDayId = store.createCalendarEvent({
    guildId, calendarChannelId: strayKids.id, title: "Bang Chan's 29th Birthday!",
    eventDate: "2026-10-03", eventTimezone: "Asia/Seoul", calendarType: "stray_kids",
    category: "birthday", createdBy: "admin", allDay: true,
  });
  assert.equal(await refreshPublishedCalendar(client, guildId, "stray_kids", "2026-10-03"), true);
  assert.equal(strayKids.messageCount(), 1);
  const afterAllDay = await strayKids.messages.fetch(originalMessage.id);
  assert.match(afterAllDay.payload.embeds[0].description, /Bang Chan's 29th Birthday/);
  assert.ok(store.getEvent(guildId, allDayId));

  const timedAt = localToUtc("2026-10-04", "07:00", "America/New_York");
  store.createCalendarEvent({
    guildId, calendarChannelId: strayKids.id, title: "Timed event", eventDate: "2026-10-04",
    eventAt: timedAt.toISOString(), eventTimezone: "America/New_York", calendarType: "stray_kids",
    category: "content", createdBy: "admin",
  });
  assert.equal(await refreshPublishedCalendar(client, guildId, "stray_kids", "2026-10-04"), true);
  assert.equal(strayKids.messageCount(), 1);
  const afterTimed = await strayKids.messages.fetch(originalMessage.id);
  assert.match(afterTimed.payload.embeds[0].description, /Timed event/);
});

test("manager Add Event refreshes publication and View Preview uses one acknowledged interaction", async () => {
  const guildId = `manager-live-flow-${Date.now()}`;
  const control = fakeChannel("control-live-flow");
  const strayKids = fakeChannel("calendar-live-flow-stray-kids");
  const community = fakeChannel("calendar-live-flow-community");
  store.setCalendarChannels(guildId, strayKids.id, community.id);
  const guild = fakeGuild(guildId, [control, strayKids, community]);
  const client = { guilds: { cache: new Map([[guildId, guild]]), fetch: async () => guild } };
  await publishMonthlyCalendar(client, guildId, "stray_kids", "2026-11");
  const originalMessage = await strayKids.messages.fetch("calendar-live-flow-stray-kids-message-1");

  const add = fakeInteraction({ customId: "harmony-manager:stray_kids:add", kind: "button", guildId, client });
  await handleEventSchedulerInteraction(add);
  const category = fakeInteraction({ customId: "harmony-manager:stray_kids:addcategory:new", kind: "select", guildId, client, values: ["birthday"] });
  await handleEventSchedulerInteraction(category);
  const details = fakeInteraction({
    customId: "harmony-manager:stray_kids:addmodal", kind: "modal", guildId, client,
    fields: { title: "Bang Chan's 29th Birthday!", "event-date": "2026-11-03", "event-time": "", location: "Seoul, South Korea", description: "" },
  });
  await handleEventSchedulerInteraction(details);
  assert.equal(details.responses[0].type, "reply");
  const birthdayTimezone = fakeInteraction({ customId: "harmony-manager:stray_kids:sktimezone", kind: "select", guildId, client, values: ["none"] });
  await handleEventSchedulerInteraction(birthdayTimezone);
  assert.equal(birthdayTimezone.responses[0].type, "update");
  assert.equal(strayKids.messageCount(), 1);
  assert.match((await strayKids.messages.fetch(originalMessage.id)).payload.embeds[0].description, /Bang Chan's 29th Birthday/);

  const timedAdd = fakeInteraction({ customId: "harmony-manager:stray_kids:add", kind: "button", guildId, client });
  await handleEventSchedulerInteraction(timedAdd);
  const timedCategory = fakeInteraction({ customId: "harmony-manager:stray_kids:addcategory:new", kind: "select", guildId, client, values: ["content"] });
  await handleEventSchedulerInteraction(timedCategory);
  const timedDetails = fakeInteraction({
    customId: "harmony-manager:stray_kids:addmodal", kind: "modal", guildId, client,
    fields: { title: "SKZ CODE EP. 104", "event-date": "2026-11-01", "event-time": "07:00", location: "New York, USA", description: "" },
  });
  await handleEventSchedulerInteraction(timedDetails);
  const timedTimezone = fakeInteraction({ customId: "harmony-manager:stray_kids:sktimezone", kind: "select", guildId, client, values: ["America/New_York"] });
  await handleEventSchedulerInteraction(timedTimezone);
  assert.equal(timedDetails.responses[0].type, "reply");
  assert.match((await strayKids.messages.fetch(originalMessage.id)).payload.embeds[0].description, /SKZ CODE EP\. 104/);

  const view = fakeInteraction({ customId: "harmony-manager:stray_kids:view", kind: "button", guildId, client });
  await handleEventSchedulerInteraction(view);
  const viewModal = fakeInteraction({
    customId: "harmony-manager:stray_kids:viewmodal", kind: "modal", guildId, client,
    fields: { month: "2026-11" },
  });
  await handleEventSchedulerInteraction(viewModal);
  assert.equal(viewModal.responses[0].type, "deferReply");
  assert.equal(viewModal.responses.some((response) => response.type === "reply"), false);
  const previewContent = viewModal.responses.find((response) => response.type === "editReply").payload.embeds[0].description;
  assert.match(previewContent, /Bang Chan's 29th Birthday/);
  assert.match(previewContent, /SKZ CODE EP\. 104/);

  const edit = fakeInteraction({ customId: "harmony-manager:stray_kids:edit", kind: "button", guildId, client });
  await handleEventSchedulerInteraction(edit);
  const editOptions = edit.responses[0].payload.components[0].toJSON().components[0].options;
  const editOption = editOptions.find((option) => option.label.includes("Bang Chan's 29th Birthday"));
  assert.ok(editOption);
  assert.match(editOption.label, /Bang Chan's 29th Birthday/);
  assert.doesNotMatch(editOption.label, /#\d+/);
  assert.match(editOption.description, /2026-11-03/);

  const cancel = fakeInteraction({ customId: "harmony-manager:stray_kids:cancel", kind: "button", guildId, client });
  await handleEventSchedulerInteraction(cancel);
  const cancelOptions = cancel.responses[0].payload.components[0].toJSON().components[0].options;
  const cancelOption = cancelOptions.find((option) => option.label.includes("Bang Chan's 29th Birthday"));
  assert.ok(cancelOption);
  assert.match(cancelOption.label, /Bang Chan's 29th Birthday/);
  assert.doesNotMatch(cancelOption.label, /#\d+/);
});


test("Youtiful create and edit modals use a timezone step instead of Location or End T…27884 tokens truncated…nteraction(scope);
  const timezoneMenu = scope.responses[0].payload.components[0].toJSON().components[0];
  const timezone = fakeInteraction({ customId: timezoneMenu.custom_id, kind: "select", guildId, guild, client, values: ["America/New_York"] });
  await handleEventSchedulerInteraction(timezone);
  const cutoffModal = timezone.responses[0].modal.toJSON();
  assert.match(cutoffModal.custom_id, /nativeaddcutoff/);
  const cutoff = fakeInteraction({ customId: cutoffModal.custom_id, kind: "modal", guildId, guild, client, fields: { "last-date": "2100-01-31" } });
  await handleEventSchedulerInteraction(cutoff);
  const cutoffContinue = cutoff.responses[0].payload.components[0].components[0].toJSON().custom_id;
  const startDescriptions = fakeInteraction({ customId: cutoffContinue, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(startDescriptions);
  const firstModal = startDescriptions.responses[0].modal.toJSON();
  assert.match(firstModal.custom_id, /nativeaddseriesmodal/);
  assert.equal(firstModal.components.length, 5);
  assert.equal(firstModal.components[0].components[0].label, "Message for all dates");
  assert.equal(firstModal.components[1].components[0].custom_id, "description-0");

  const pageOne = fakeInteraction({ customId: firstModal.custom_id, kind: "modal", guildId, guild, client, fields: {
    "description-0": "Episodes 1 & 2", "description-1": "Episodes 3 & 4",
    "description-2": "Episodes 5 & 6", "description-3": "Episodes 7 & 8",
  } });
  await handleEventSchedulerInteraction(pageOne);
  assert.equal(pageOne.responses[0].type, "reply");
  assert.match(pageOne.responses[0].payload.content, /Continue to the next occurrence descriptions/);
  const continueId = pageOne.responses[0].payload.components[0].components[0].toJSON().custom_id;
  const continuePage = fakeInteraction({ customId: continueId, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(continuePage);
  const secondModal = continuePage.responses[0].modal.toJSON();
  assert.match(secondModal.custom_id, /nativeaddseriesmodal/);
  assert.equal(secondModal.components.length, 2);
  assert.equal(secondModal.components[0].components[0].value, undefined);

  const pageTwo = fakeInteraction({ customId: secondModal.custom_id, kind: "modal", guildId, guild, client, fields: {
    "description-4": "Episodes 9 & 10", "description-5": "Episodes 11 & 12",
  } });
  await handleEventSchedulerInteraction(pageTwo);
  const rows = store.listSeriesEvents(guildId, store.getEventByDiscordId(guildId, native.id).recurrence_series_id);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.sort((left, right) => left.recurrence_index - right.recurrence_index).map((row) => row.description), [
    "Episodes 1 & 2", "Episodes 3 & 4", "Episodes 5 & 6", "Episodes 7 & 8", "Episodes 9 & 10", "Episodes 11 & 12",
  ]);
  const anchor = store.getEventByDiscordId(guildId, native.id);
  assert.equal(anchor.recurrence_exception, 1);
  assert.equal(anchor.recurrence_default_description, "");
  // A later recurrence sync may discover dates that were not present when
  // the import modal was submitted. The occurrence-specific anchor text must
  // never become the template for those newly projected dates.
  store.updateEvent(guildId, anchor.id, {
    recurrence_rule: JSON.stringify({ source: "discord", startAt: "2099-12-04T23:00:00.000Z", frequency: 2, interval: 1, byWeekday: [4], count: 7 }),
  });
  await syncDiscordRecurringSeries(guildId, store.getEvent(guildId, anchor.id));
  const future = store.getSeriesEvent(guildId, anchor.recurrence_series_id, 6);
  assert.ok(future);
  assert.equal(future.description, null);
  assert.equal(native.description, "Native recurring description");
  assert.equal(store.getEventByDiscordId(guildId, native.id).discord_event_id, native.id);
});

test("native recurring import cutoff bounds projection and can be extended without duplicates", async () => {
  const guildId = `native-cutoff-${Date.now()}`;
  const native = {
    id: "native-cutoff-series", name: "Cutoff K-Drama", description: "Native description",
    scheduledStartAt: new Date("2099-12-04T23:00:00.000Z"),
    recurrenceRule: { startAt: new Date("2099-12-04T23:00:00.000Z"), frequency: 2, interval: 1, byWeekday: [4], count: 7 },
  };
  const guild = { scheduledEvents: { fetch: async () => native } };
  const interaction = fakeInteraction({ customId: "harmony-manager:community:nativeadd", kind: "button", guildId, guild });
  const descriptions = { 0: "Episodes 1 & 2", 1: "Episodes 3 & 4" };
  const added = await addNativeEventToCalendar(interaction, native.id, descriptions[0], descriptions, "2099-12-11");
  let rows = store.listSeriesEvents(guildId, added.recurrence_series_id);
  assert.deepEqual(rows.map((row) => row.recurrence_index), [0, 1]);
  assert.equal(added.recurrence_end_date, "2099-12-11");
  await syncDiscordRecurringSeries(guildId, store.getEvent(guildId, added.id));
  assert.equal(store.listSeriesEvents(guildId, added.recurrence_series_id).length, 2);
  store.updateEvent(guildId, added.id, { recurrence_end_date: "2099-12-18" });
  await syncDiscordRecurringSeries(guildId, store.getEvent(guildId, added.id));
  rows = store.listSeriesEvents(guildId, added.recurrence_series_id);
  assert.deepEqual(rows.map((row) => row.recurrence_index), [0, 1, 2]);
  assert.equal(rows.filter((row) => row.recurrence_index === 2).length, 1);
  assert.equal(native.description, "Native description");
});

test("recurring import description pages stop at the selected Harmony cutoff", async () => {
  const guildId = `native-cutoff-modal-${Date.now()}`;
  const native = {
    id: "native-cutoff-modal", name: "Cutoff modal series", description: "Native details",
    scheduledStartAt: new Date("2099-12-04T23:00:00.000Z"),
    recurrenceRule: { startAt: new Date("2099-12-04T23:00:00.000Z"), frequency: 2, interval: 1, byWeekday: [4], count: 6 },
  };
  const guild = { scheduledEvents: { fetch: async () => native } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  store.saveDiscordEventReconciliation(guildId, native.id, "notice", "open");
  const add = fakeInteraction({ customId: `harmony-manager:community:nativeadd:${native.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(add);
  const scope = fakeInteraction({ customId: add.responses[0].payload.components[0].components[0].toJSON().custom_id, kind: "select", guildId, guild, client, values: ["series"] });
  await handleEventSchedulerInteraction(scope);
  const timezoneMenu = scope.responses[0].payload.components[0].toJSON().components[0];
  const timezone = fakeInteraction({ customId: timezoneMenu.custom_id, kind: "select", guildId, guild, client, values: ["America/New_York"] });
  await handleEventSchedulerInteraction(timezone);
  const cutoff = fakeInteraction({ customId: timezone.responses[0].modal.toJSON().custom_id, kind: "modal", guildId, guild, client, fields: { "last-date": "2099-12-11" } });
  await handleEventSchedulerInteraction(cutoff);
  const continueId = cutoff.responses[0].payload.components[0].components[0].toJSON().custom_id;
  const next = fakeInteraction({ customId: continueId, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(next);
  const descriptionModal = next.responses[0].modal.toJSON();
  assert.equal(descriptionModal.components.length, 3);
  assert.equal(descriptionModal.components[0].components[0].custom_id, "calendar-generic");
  assert.match(descriptionModal.components[1].components[0].label, /Friday/);
  assert.match(descriptionModal.components[2].components[0].label, /Friday/);
});

test("native recurring cutoff uses the local calendar date across the DST boundary", async () => {
  const guildId = `native-cutoff-dst-${Date.now()}`;
  const native = {
    id: "native-cutoff-dst-series", name: "DST K-Drama", description: "Native details",
    scheduledStartAt: new Date("2026-10-17T01:00:00.000Z"),
    recurrenceRule: { startAt: new Date("2026-08-22T01:00:00.000Z"), frequency: 2, interval: 1, byWeekday: [5], count: 12 },
  };
  const guild = { scheduledEvents: { fetch: async () => native } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  store.saveDiscordEventReconciliation(guildId, native.id, "notice", "open");

  const add = fakeInteraction({ customId: `harmony-manager:community:nativeadd:${native.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(add);
  const scope = fakeInteraction({ customId: add.responses[0].payload.components[0].components[0].toJSON().custom_id, kind: "select", guildId, guild, client, values: ["series"] });
  await handleEventSchedulerInteraction(scope);
  const timezoneMenu = scope.responses[0].payload.components[0].toJSON().components[0];
  const timezone = fakeInteraction({ customId: timezoneMenu.custom_id, kind: "select", guildId, guild, client, values: ["America/New_York"] });
  await handleEventSchedulerInteraction(timezone);
  const cutoff = fakeInteraction({ customId: timezone.responses[0].modal.toJSON().custom_id, kind: "modal", guildId, guild, client, fields: { "last-date": "2026-11-06" } });
  await handleEventSchedulerInteraction(cutoff);
  const start = fakeInteraction({ customId: cutoff.responses[0].payload.components[0].components[0].toJSON().custom_id, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(start);
  const descriptionModal = start.responses[0].modal.toJSON();
  assert.deepEqual(descriptionModal.components.slice(1).map((row) => row.components[0].label), [
    "Friday, October 16, 2026", "Friday, October 23, 2026", "Friday, October 30, 2026", "Friday, November 6, 2026",
  ]);

  const submit = fakeInteraction({ customId: descriptionModal.custom_id, kind: "modal", guildId, guild, client, fields: {
    "calendar-generic": "DST series", "description-0": "One", "description-1": "Two", "description-2": "Three", "description-3": "Four",
  } });
  await handleEventSchedulerInteraction(submit);
  const added = store.getEventByDiscordId(guildId, native.id);
  assert.ok(added);
  const persisted = store.listSeriesEvents(guildId, added.recurrence_series_id);
  assert.deepEqual(persisted.map((row) => row.event_at), [
    "2026-10-17T01:00:00.000Z", "2026-10-24T01:00:00.000Z", "2026-10-31T01:00:00.000Z", "2026-11-07T01:00:00.000Z",
  ]);
  assert.deepEqual(announcementEventIds(guildId, added), persisted.map((row) => row.id));
  await syncDiscordRecurringSeries(guildId, store.getEvent(guildId, added.id));
  assert.equal(store.listSeriesEvents(guildId, added.recurrence_series_id).length, 4);
  assert.equal(native.scheduledStartAt.toISOString(), "2026-10-17T01:00:00.000Z");
});

test("native cutoff comparisons use localized dates and preserve UTC instants", () => {
  const native = {
    scheduledStartAt: new Date("2026-10-17T01:00:00.000Z"),
    recurrenceRule: { startAt: new Date("2026-08-22T01:00:00.000Z"), frequency: 2, interval: 1, byWeekday: [5], count: 12 },
  };
  assert.equal(calendarDateInTimezone("2026-11-07T01:00:00.000Z", "America/New_York"), "2026-11-06");
  assert.equal(calendarDateInTimezone("2026-11-08T05:30:00.000Z", "America/New_York"), "2026-11-08");
  assert.equal(nativeCutoffDate("2026-10-16", native, "America/New_York"), "2026-10-16");
  assert.equal(nativeCutoffDate("2026-11-06", native, "America/New_York"), "2026-11-06");
  assert.equal(nativeDescriptionOccurrences(native, "2026-11-05", "America/New_York").length, 3);
  assert.equal(nativeDescriptionOccurrences(native, "2026-11-06", "America/New_York").at(-1).eventAt, "2026-11-07T01:00:00.000Z");
  assert.equal(calendarCutoffBoundary("2026-11-06", "America/New_York").toISOString(), "2026-11-07T04:59:59.999Z");
  assert.equal(calendarCutoffBoundary("2026-11-08", "America/New_York").toISOString(), "2026-11-09T04:59:59.999Z");
});

test("recurring native import hands the complete bounded series to announcements", async () => {
  const guildId = `native-announcement-scope-${Date.now()}`;
  const native = {
    guildId,
    id: "native-announcement-scope", name: "October K-Drama", description: "Native details",
    scheduledStartAt: new Date("2026-10-17T01:00:00.000Z"),
    // Discord can retain the historical series start while exposing the
    // currently selected/upcoming occurrence through scheduledStartAt.
    recurrenceRule: { startAt: new Date("2026-08-22T01:00:00.000Z"), frequency: 2, interval: 1, byWeekday: [5], count: 12 },
  };
  const guild = { scheduledEvents: { fetch: async () => native } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  store.saveDiscordEventReconciliation(guildId, native.id, "notice", "open");
  const add = fakeInteraction({ customId: `harmony-manager:community:nativeadd:${native.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(add);
  const scope = fakeInteraction({ customId: add.responses[0].payload.components[0].components[0].toJSON().custom_id, kind: "select", guildId, guild, client, values: ["series"] });
  await handleEventSchedulerInteraction(scope);
  const timezone = fakeInteraction({ customId: scope.responses[0].payload.components[0].toJSON().components[0].custom_id, kind: "select", guildId, guild, client, values: ["America/New_York"] });
  await handleEventSchedulerInteraction(timezone);
  const cutoff = fakeInteraction({ customId: timezone.responses[0].modal.toJSON().custom_id, kind: "modal", guildId, guild, client, fields: { "last-date": "2026-10-31" } });
  await handleEventSchedulerInteraction(cutoff);
  const start = fakeInteraction({ customId: cutoff.responses[0].payload.components[0].components[0].toJSON().custom_id, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(start);
  const descriptions = start.responses[0].modal.toJSON();
  assert.equal(descriptions.components.length, 4);
  assert.deepEqual(descriptions.components.slice(1).map((row) => row.components[0].label), ["Friday, October 16, 2026", "Friday, October 23, 2026", "Friday, October 30, 2026"]);
  const submit = fakeInteraction({ customId: descriptions.custom_id, kind: "modal", guildId, guild, client, fields: {
    "calendar-generic": "K-Drama with Us", "description-0": "Episodes 1 & 2", "description-1": "Episodes 3 & 4", "description-2": "",
  } });
  await handleEventSchedulerInteraction(submit);
  const added = store.getEventByDiscordId(guildId, native.id);
  assert.ok(added);
  const storedRule = JSON.parse(added.recurrence_rule);
  assert.equal(storedRule.anchorAt, "2026-10-17T01:00:00.000Z");
  assert.equal(storedRule.startAt, "2026-08-22T01:00:00.000Z");
  const persisted = store.listSeriesEvents(guildId, added.recurrence_series_id);
  assert.deepEqual(persisted.map((row) => row.event_date), ["2026-10-16", "2026-10-23", "2026-10-30"]);
  assert.deepEqual(persisted.map((row) => row.event_at), ["2026-10-17T01:00:00.000Z", "2026-10-24T01:00:00.000Z", "2026-10-31T01:00:00.000Z"]);
  assert.deepEqual(persisted.map((row) => row.recurrence_index), [0, 1, 2]);
  assert.deepEqual(persisted.map((row) => row.description), ["Episodes 1 & 2", "Episodes 3 & 4", "K-Drama with Us"]);
  assert.equal(persisted.some((row) => row.event_date < "2026-10-16"), false);
  await syncDiscordRecurringSeries(guildId, store.getEvent(guildId, added.id));
  assert.deepEqual(store.listSeriesEvents(guildId, added.recurrence_series_id).map((row) => row.event_date), ["2026-10-16", "2026-10-23", "2026-10-30"]);
  const nextNativeOccurrence = {
    ...native,
    scheduledStartAt: new Date("2026-10-24T01:00:00.000Z"),
  };
  await handleGuildScheduledEventUpdate(client, native, nextNativeOccurrence);
  assert.equal(store.getEvent(guildId, added.id).event_at, "2026-10-17T01:00:00.000Z");
  assert.deepEqual(store.listSeriesEvents(guildId, added.recurrence_series_id).map((row) => row.event_date), ["2026-10-16", "2026-10-23", "2026-10-30"]);
  assert.equal(added.recurrence_default_description, "K-Drama with Us");
  const prompt = submit.responses[0].payload.components[0].components[0].toJSON().custom_id;
  const announce = fakeInteraction({ customId: prompt, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(announce);
  const modal = announce.responses[0].modal.toJSON();
  assert.deepEqual(modal.components.slice(1).map((row) => row.components[0].label), ["Friday, October 16", "Friday, October 23", "Friday, October 30"]);
  assert.doesNotMatch(JSON.stringify(modal), /November 7/);

  const modalFields = Object.fromEntries(modal.components.slice(1).map((row) => [row.components[0].custom_id, ""]));
  modalFields["announcement-message"] = "K-Drama announcements";
  const announcementSubmit = fakeInteraction({ customId: modal.custom_id, kind: "modal", guildId, guild, client, fields: modalFields });
  await handleEventSchedulerInteraction(announcementSubmit);
  assert.match(announcementSubmit.responses[0].payload.content, /Choose the separate announcement channel/);
  const channel = fakeInteraction({
    customId: "harmony-manager:community:ysannouncechannel:" + added.id,
    kind: "channel", guildId, guild, client, values: ["announcements"],
  });
  await handleEventSchedulerInteraction(channel);
  const timing = fakeInteraction({
    customId: "harmony-manager:community:ysannouncetiming:" + added.id,
    kind: "select", guildId, guild, client, values: ["86400"],
  });
  await handleEventSchedulerInteraction(timing);
  assert.match(timing.responses[0].payload.content, /announcements scheduled/);
});

test("native series announcements use only the bounded persisted recurrence timeline", () => {
  const guildId = `native-announcement-cutoff-${Date.now()}`;
  const seriesId = `native-series-${Date.now()}`;
  const rule = JSON.stringify({ source: "discord", startAt: "2026-10-17T01:00:00.000Z", frequency: 2, interval: 1, byWeekday: [5], count: 8 });
  const anchorId = store.createCalendarEvent({
    guildId, title: "K-Drama", eventDate: "2026-10-17", eventAt: "2026-10-17T01:00:00.000Z", eventTimezone: "UTC", timezone: "UTC",
    calendarType: "community", category: "other", createdBy: "admin", recurrenceSeriesId: seriesId, recurrenceRule: rule,
    recurrenceIndex: 0, recurrenceEndDate: "2026-10-31", recurrenceNativeEnabled: 2,
  });
  const anchor = store.getEvent(guildId, anchorId);
  for (const [index, date] of [[1, "2026-08-29"], [2, "2026-09-05"], [3, "2026-10-24"], [4, "2026-10-31"], [5, "2026-11-07"]]) {
    store.createSeriesOccurrence(guildId, seriesId, { occurrenceIndex: index, eventAt: `${date}T01:00:00.000Z`, eventEndAt: null }, anchor);
  }
  return syncDiscordRecurringSeries(guildId, store.getEvent(guildId, anchorId)).then(() => {
  const ids = announcementEventIds(guildId, store.getEvent(guildId, anchorId));
  assert.deepEqual(ids.map((id) => store.getEvent(guildId, id).event_date), ["2026-10-17", "2026-10-24", "2026-10-31"]);
  });
});

test("native recurring evening occurrence keeps its Eastern local calendar date", async () => {
  const guildId = `native-evening-date-${Date.now()}`;
  const seriesId = `native-evening-series-${Date.now()}`;
  const anchorAt = "2026-10-24T00:00:00.000Z"; // October 23 at 8 PM in New York
  const rule = JSON.stringify({
    source: "discord", anchorAt, startAt: anchorAt, frequency: 2, interval: 1, byWeekday: [5], count: 2,
  });
  const anchorId = store.createCalendarEvent({
    guildId, title: "Friday K-Drama", eventDate: "2026-10-24", eventAt: anchorAt,
    eventTimezone: "America/New_York", timezone: "America/New_York", calendarType: "community",
    category: "kdrama", createdBy: "admin", recurrenceSeriesId: seriesId, recurrenceRule: rule,
    recurrenceIndex: 0, recurrenceNativeEnabled: 2,
  });

  await syncDiscordRecurringSeries(guildId, store.getEvent(guildId, anchorId), new Date("2026-10-31T23:59:59.000Z"));

  assert.equal(store.getEvent(guildId, anchorId).event_date, "2026-10-23");
  const next = store.getSeriesEvent(guildId, seriesId, 1);
  assert.equal(next.event_at, "2026-10-31T00:00:00.000Z");
  assert.equal(next.event_date, "2026-10-30");
});

test("native recurrence projection never regenerates a canceled occurrence", async () => {
  const guildId = `native-canceled-occurrence-${Date.now()}`;
  const seriesId = `native-canceled-series-${Date.now()}`;
  const anchorAt = "2026-10-18T00:00:00.000Z"; // October 17 at 8 PM in New York
  const rule = JSON.stringify({
    source: "discord", anchorAt, startAt: anchorAt, frequency: 2, interval: 1, byWeekday: [5], count: 3,
  });
  const anchorId = store.createCalendarEvent({
    guildId, title: "Friday K-Drama", eventDate: "2026-10-17", eventAt: anchorAt,
    eventTimezone: "America/New_York", timezone: "America/New_York", calendarType: "community",
    category: "kdrama", createdBy: "admin", recurrenceSeriesId: seriesId, recurrenceRule: rule,
    recurrenceIndex: 0, recurrenceNativeEnabled: 2,
  });
  const anchor = store.getEvent(guildId, anchorId);
  const canceled = store.createSeriesOccurrence(guildId, seriesId, {
    occurrenceIndex: 1, eventAt: "2026-10-25T00:00:00.000Z", eventDate: "2026-10-24", eventEndAt: null,
  }, anchor);
  assert.equal(store.cancelEvent(guildId, canceled.id, "admin"), true);

  await syncDiscordRecurringSeries(guildId, store.getEvent(guildId, anchorId), new Date("2026-10-27T00:00:00.000Z"));
  await syncDiscordRecurringSeries(guildId, store.getEvent(guildId, anchorId), new Date("2026-10-27T00:00:00.000Z"));

  const rows = store.listSeriesEvents(guildId, seriesId).filter((event) => Number(event.recurrence_index) === 1);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].cancelled_at);
  assert.equal(store.getSeriesEvent(guildId, seriesId, 1), null);
});

test("Choose an upcoming event excludes past linked occurrences but keeps current and future events", () => {
  const guildId = `manager-upcoming-filter-${Date.now()}`;
  const make = (title, eventDate, eventAt, discordEventId = null) => store.createCalendarEvent({
    guildId, title, eventDate, eventAt, eventTimezone: "America/New_York", timezone: "America/New_York",
    calendarType: "community", category: "kdrama", discordEventId, createdBy: "admin",
  });
  const oct17 = make("Past October 17", "2026-10-17", "2026-10-18T01:00:00.000Z", "past-17");
  const oct18 = make("Past October 18", "2026-10-18", "2026-10-19T01:00:00.000Z", "past-18");
  const tonight = make("Tonight October 23", "2026-10-24", "2026-10-24T01:00:00.000Z", "tonight");
  const seriesId = `manager-upcoming-series-${Date.now()}`;
  const seriesAnchorId = store.createCalendarEvent({
    guildId, title: "Future K-Drama", eventDate: "2026-10-17", eventAt: "2026-10-18T01:00:00.000Z",
    eventTimezone: "America/New_York", timezone: "America/New_York", calendarType: "community",
    category: "kdrama", discordEventId: "native-series", recurrenceSeriesId: seriesId,
    recurrenceIndex: 0, recurrenceNativeEnabled: 2, createdBy: "admin",
  });
  const tomorrow = store.createSeriesOccurrence(guildId, seriesId, {
    occurrenceIndex: 1, eventAt: "2026-10-25T01:00:00.000Z", eventDate: "2026-10-24", eventEndAt: null,
  }, store.getEvent(guildId, seriesAnchorId)).id;

  const upcoming = upcomingCalendarEvents(guildId, "community", new Date("2026-10-23T16:00:00.000Z"));
  const ids = upcoming.map((event) => event.id);
  assert.equal(ids.includes(oct17), false);
  assert.equal(ids.includes(oct18), false);
  assert.equal(ids.includes(tonight), true);
  assert.equal(ids.includes(tomorrow), true);
});

test("series announcement modal rebuilds occurrence fields from the persisted adopted series", () => {
  const guildId = `native-announcement-modal-refresh-${Date.now()}`;
  const seriesId = `series-${Date.now()}`;
  const anchorId = store.createCalendarEvent({
    guildId, calendarChannelId: null, title: "October K-Drama", eventDate: "2026-10-17",
    eventAt: "2026-10-17T01:00:00.000Z", eventTimezone: "UTC", timezone: "UTC", calendarType: "community",
    category: "other", createdBy: "admin", recurrenceSeriesId: seriesId, recurrenceIndex: 0,
  });
  const anchor = store.getEvent(guildId, anchorId);
  const oct24 = store.createSeriesOccurrence(guildId, seriesId, { occurrenceIndex: 1, eventAt: "2026-10-24T01:00:00.000Z", eventEndAt: null }, anchor);
  store.createSeriesOccurrence(guildId, seriesId, { occurrenceIndex: 2, eventAt: "2026-10-31T01:00:00.000Z", eventEndAt: null }, anchor);
  const unrelatedAug = store.createCalendarEvent({
    guildId, calendarChannelId: null, title: "Old K-Drama", eventDate: "2026-08-22", eventAt: "2026-08-22T01:00:00.000Z",
    eventTimezone: "UTC", timezone: "UTC", calendarType: "community", category: "other", createdBy: "admin",
  });
  const modal = announcementEditorModal(anchorId, {
    guildId, eventIds: [unrelatedAug, oct24.id], announcementScope: "series", announcementPage: 0,
  }, store.getEvent(guildId, anchorId), guildId).toJSON();
  const labels = modal.components.slice(1).map((row) => row.components[0].label);
  assert.deepEqual(labels, ["Saturday, October 17", "Saturday, October 24", "Saturday, October 31"]);
  assert.doesNotMatch(JSON.stringify(modal), /August|September/);
});

test("native recurring labels use the community IANA timezone across the DST transition", () => {
  const guildId = `native-label-dst-${Date.now()}`;
  const seriesId = `series-${Date.now()}`;
  const anchorId = store.createCalendarEvent({
    guildId, calendarChannelId: null, title: "DST Watch Party", eventDate: "2026-11-01",
    eventAt: "2026-11-01T03:30:00.000Z", eventTimezone: "UTC", timezone: "UTC",
    discordEventOrigin: "adopted", calendarType: "community", category: "other", createdBy: "admin",
    recurrenceSeriesId: seriesId, recurrenceIndex: 0,
  });
  const anchor = store.getEvent(guildId, anchorId);
  store.createSeriesOccurrence(guildId, seriesId, { occurrenceIndex: 1, eventAt: "2026-11-08T05:30:00.000Z", eventEndAt: null }, anchor);
  const modal = announcementEditorModal(anchorId, { guildId, announcementScope: "series" }, anchor, guildId).toJSON();
  assert.deepEqual(modal.components.slice(1).map((row) => row.components[0].label), ["Saturday, October 31", "Sunday, November 8"]);
});

test("fresh recurring adoption canonicalizes a stale series and hands only its bounded IDs to announcements", async () => {
  const guildId = `native-fresh-adoption-${Date.now()}`;
  const native = {
    id: "native-fresh-adoption", name: "Kdrama with Us! Europe and US EST friendly", description: "Native details",
    scheduledStartAt: new Date("2026-10-17T01:00:00.000Z"),
    recurrenceRule: { startAt: new Date("2026-10-17T01:00:00.000Z"), frequency: 2, interval: 1, byWeekday: [5], count: 3 },
  };
  const staleRule = JSON.stringify({ source: "discord", startAt: "2026-10-17T01:00:00.000Z", frequency: 2, interval: 1, byWeekday: [5], count: 3 });
  const seriesId = `stale-series-${Date.now()}`;
  const anchorId = store.createCalendarEvent({
    guildId, calendarChannelId: "calendar", title: native.name, eventDate: "2026-10-17", eventAt: native.scheduledStartAt.toISOString(),
    eventTimezone: "UTC", timezone: "UTC", calendarType: "community", category: "other", createdBy: "admin",
    recurrenceSeriesId: seriesId, recurrenceRule: staleRule, recurrenceIndex: 0,
  });
  const anchor = store.getEvent(guildId, anchorId);
  store.createSeriesOccurrence(guildId, seriesId, { occurrenceIndex: 1, eventAt: "2026-08-29T01:00:00.000Z", eventEndAt: null }, anchor);
  store.createSeriesOccurrence(guildId, seriesId, { occurrenceIndex: 2, eventAt: "2026-09-05T01:00:00.000Z", eventEndAt: null }, anchor);
  const guild = { scheduledEvents: { fetch: async () => native } };
  const added = await addNativeEventToCalendar({ guildId, user: { id: "admin" }, guild }, native.id, "Episodes 1 & 2", { 0: "Episodes 1 & 2", 1: "Episodes 3 & 4", 2: "Episodes 5 & 6" }, "2026-10-31", true, "Kdrama default");
  const rows = store.listSeriesEvents(guildId, seriesId);
  assert.equal(added.id, anchorId);
  assert.deepEqual(rows.map((row) => row.event_date), ["2026-10-16", "2026-10-23", "2026-10-30"]);
  assert.deepEqual(rows.map((row) => row.recurrence_index), [0, 1, 2]);
  assert.equal(rows.filter((row) => row.event_date === "2026-10-16").length, 1);
  assert.equal(store.getEventByDiscordId(guildId, native.id).id, anchorId);
  const handoffIds = announcementEventIds(guildId, added);
  assert.deepEqual(handoffIds, rows.map((row) => row.id));
  assert.deepEqual(handoffIds.map((id) => store.getEvent(guildId, id).event_date), ["2026-10-16", "2026-10-23", "2026-10-30"]);
});

test("recurring adoption converts a prior adopted one-off instead of creating a duplicate anchor", async () => {
  const guildId = `native-adopted-oneoff-${Date.now()}`;
  const native = {
    id: "native-adopted-oneoff", name: "Kdrama with Us! Europe and US EST friendly", description: "Native details",
    scheduledStartAt: new Date("2099-10-17T01:00:00.000Z"),
    recurrenceRule: { startAt: new Date("2099-10-17T01:00:00.000Z"), frequency: 2, interval: 1, byWeekday: [5], count: 3 },
  };
  const existingId = store.createCalendarEvent({
    guildId, calendarChannelId: "calendar", title: native.name, eventDate: "2099-10-17", eventAt: native.scheduledStartAt.toISOString(),
    eventTimezone: "UTC", timezone: "UTC", calendarType: "community", category: "other", createdBy: "admin", discordEventOrigin: "adopted",
  });
  const guild = { scheduledEvents: { fetch: async () => native } };
  const added = await addNativeEventToCalendar({ guildId, user: { id: "admin" }, guild }, native.id, "Episodes 1 & 2");
  const rows = store.listSeriesEvents(guildId, added.recurrence_series_id);
  assert.equal(added.id, existingId);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.event_date === "2099-10-16").length, 1);
  assert.equal(store.listCalendarEvents(guildId, "community", "2099-10-16T00:00:00.000Z", "2099-10-17T00:00:00.000Z").length, 1);
  assert.equal(store.getEventByDiscordId(guildId, native.id).id, existingId);
});

test("monthly publication filters events to the requested month", async () => {
  const guildId = `calendar-month-boundary-${Date.now()}`;
  const control = fakeChannel("month-control");
  const calendar = fakeChannel("month-calendar");
  store.setCalendarChannels(guildId, calendar.id, null);
  store.setManagerChannel(guildId, control.id);
  const guild = fakeGuild(guildId, [control, calendar]);
  const client = { guilds: { cache: new Map([[guildId, guild]]), fetch: async () => guild } };
  store.createCalendarEvent({ guildId, calendarChannelId: calendar.id, title: "October event", eventDate: "2026-10-31", calendarType: "stray_kids", category: "content", createdBy: "admin" });
  store.createCalendarEvent({ guildId, calendarChannelId: calendar.id, title: "November event", eventDate: "2026-11-01", calendarType: "stray_kids", category: "content", createdBy: "admin" });
  await publishMonthlyCalendar(client, guildId, "stray_kids", "2026-10");
  const message = await calendar.messages.fetch("month-calendar-message-1");
  assert.match(message.payload.embeds[0].description, /October event/);
  assert.doesNotMatch(message.payload.embeds[0].description, /November event/);
});

test("editing recurring events updates existing rows and refreshes one published month", async () => {
  const guildId = `calendar-edit-idempotent-${Date.now()}`;
  const control = fakeChannel("edit-idempotent-control");
  const calendar = fakeChannel("edit-idempotent-calendar");
  store.setCalendarChannels(guildId, null, calendar.id);
  store.setManagerChannel(guildId, control.id);
  const guild = fakeGuild(guildId, [control, calendar]);
  const client = { guilds: { cache: new Map([[guildId, guild]]), fetch: async () => guild } };
  const seriesId = `edit-idempotent-series-${Date.now()}`;
  const eventValues = (index, date) => ({
    guildId, calendarChannelId: calendar.id, title: "Friday K-Drama", eventDate: date,
    eventAt: `${date}T23:00:00.000Z`, eventTimezone: "UTC", timezone: "UTC", calendarType: "community",
    category: "kdrama", recurrenceSeriesId: seriesId, recurrenceIndex: index,
    recurrenceRule: JSON.stringify({ source: "discord" }), createdBy: "admin",
  });
  const firstId = store.createCalendarEvent(eventValues(0, "2026-10-17"));
  store.createCalendarEvent(eventValues(1, "2026-10-24"));
  store.createCalendarEvent(eventValues(2, "2026-10-31"));
  assert.equal(store.listSeriesEvents(guildId, seriesId).length, 3);

  applyRecurringChanges(guildId, store.getEvent(guildId, firstId), "this", { description: "Updated first occurrence" });
  assert.equal(store.listSeriesEvents(guildId, seriesId).length, 3);
  applyRecurringChanges(guildId, store.getEvent(guildId, firstId), "series", { category: "games", calendar_event_type: "games" });
  assert.equal(store.listSeriesEvents(guildId, seriesId).length, 3);
  assert.equal(store.listSeriesEvents(guildId, seriesId).filter((event) => event.category === "games").length, 3);

  await publishMonthlyCalendar(client, guildId, "community", "2026-10");
  const firstMessage = await calendar.messages.fetch("edit-idempotent-calendar-message-1");
  await refreshPublishedCalendar(client, guildId, "community", "2026-10-17");
  await refreshPublishedCalendar(client, guildId, "community", "2026-10-24");
  assert.equal(calendar.messageCount(), 1);
  assert.deepEqual(store.listPublishedCalendars(guildId, "community", "2026-10").map((row) => row.message_id), [firstMessage.id]);
  assert.equal(store.listSeriesEvents(guildId, seriesId).length, 3);
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

test("Discord recurrence projection re-anchors arbitrary patterns to the selected occurrence", () => {
  const cases = [
    {
      name: "weekly Friday with stale Saturday selector",
      startAt: "2026-10-16T01:00:00.000Z",
      rule: { frequency: 2, interval: 1, byWeekday: [5], count: 4 },
      until: "2026-11-06T23:59:59.999Z",
      expected: ["2026-10-16", "2026-10-23", "2026-10-30", "2026-11-06"],
    },
    {
      name: "weekly Saturday with stale Friday selector",
      startAt: "2026-10-17T19:00:00.000Z",
      rule: { frequency: 2, interval: 1, byWeekday: [4], count: 4 },
      until: "2026-11-07T23:59:59.999Z",
      expected: ["2026-10-17", "2026-10-24", "2026-10-31", "2026-11-07"],
    },
    {
      name: "weekly Tuesday with historical selector",
      startAt: "2026-10-20T19:00:00.000Z",
      rule: { frequency: 2, interval: 1, byWeekday: [0], count: 3 },
      until: "2026-11-03T23:59:59.999Z",
      expected: ["2026-10-20", "2026-10-27", "2026-11-03"],
    },
    {
      name: "biweekly Friday with historical selector",
      startAt: "2026-10-16T01:00:00.000Z",
      rule: { frequency: 2, interval: 2, byWeekday: [5], count: 3 },
      until: "2026-11-30T23:59:59.999Z",
      expected: ["2026-10-16", "2026-10-30", "2026-11-13"],
    },
  ];
  for (const scenario of cases) {
    const occurrences = generateDiscordRecurringOccurrences({ startAt: scenario.startAt, recurrenceRule: scenario.rule, until: scenario.until });
    assert.deepEqual(occurrences.map((item) => item.eventAt.slice(0, 10)), scenario.expected, scenario.name);
    assert.equal(occurrences[0].eventAt, scenario.startAt, `${scenario.name} must begin at the selected occurrence`);
    assert.ok(occurrences.every((item) => item.eventAt >= scenario.startAt), `${scenario.name} projected before the anchor`);
  }
});

test("native recurring cutoff modal uses the approved series-end wording", async () => {
  const guildId = `native-cutoff-wording-${Date.now()}`;
  const native = {
    id: `native-${guildId}`,
    name: "Weekly event",
    scheduledStartAt: new Date("2026-10-16T01:00:00.000Z"),
    recurrenceRule: { startAt: new Date("2026-08-21T01:00:00.000Z"), frequency: 2, interval: 1, byWeekday: [5], count: 3 },
  };
  const guild = { scheduledEvents: { fetch: async () => native } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  store.saveDiscordEventReconciliation(guildId, native.id, null, "open");
  const add = fakeInteraction({ customId: `harmony-manager:community:nativeadd:${native.id}`, kind: "button", guildId, guild, client });
  await handleEventSchedulerInteraction(add);
  const scopeId = add.responses[0].payload.components[0].components[0].toJSON().custom_id;
  const scope = fakeInteraction({ customId: scopeId, kind: "select", guildId, guild, client, values: ["series"] });
  await handleEventSchedulerInteraction(scope);
  const timezone = fakeInteraction({ customId: scope.responses[0].payload.components[0].toJSON().components[0].custom_id, kind: "select", guildId, guild, client, values: ["America/New_York"] });
  await handleEventSchedulerInteraction(timezone);
  const modal = timezone.responses[0].modal.toJSON();
  assert.equal(modal.title, "When should this series end?");
  assert.equal(modal.components[0].components[0].label, "Last event date (YYYY-MM-DD)");
});

test("independent native recurring intake workflows keep their own date timelines", async () => {
  const guildId = `native-independent-series-${Date.now()}`;
  const events = {
    A: {
      id: `native-a-${guildId}`, name: "Saturday series",
      scheduledStartAt: new Date("2026-10-17T19:00:00.000Z"),
      recurrenceRule: { startAt: new Date("2026-08-22T19:00:00.000Z"), frequency: 2, interval: 1, byWeekday: [4], count: 4 },
    },
    B: {
      id: `native-b-${guildId}`, name: "Friday series",
      scheduledStartAt: new Date("2026-10-17T01:00:00.000Z"),
      recurrenceRule: { startAt: new Date("2026-08-22T01:00:00.000Z"), frequency: 2, interval: 1, byWeekday: [5], count: 4 },
    },
  };
  const guild = { scheduledEvents: { fetch: async (id) => Object.values(events).find((event) => event.id === id) } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  for (const native of Object.values(events)) store.saveDiscordEventReconciliation(guildId, native.id, null, "open");

  async function startCutoff(native, userId) {
    const add = fakeInteraction({ customId: `harmony-manager:community:nativeadd:${native.id}`, kind: "button", guildId, guild, client, userId });
    await handleEventSchedulerInteraction(add);
    const scopeId = add.responses[0].payload.components[0].components[0].toJSON().custom_id;
    const scope = fakeInteraction({ customId: scopeId, kind: "select", guildId, guild, client, userId, values: ["series"] });
    await handleEventSchedulerInteraction(scope);
    const timezone = fakeInteraction({ customId: scope.responses[0].payload.components[0].toJSON().components[0].custom_id, kind: "select", guildId, guild, client, userId, values: ["America/New_York"] });
    await handleEventSchedulerInteraction(timezone);
    const cutoff = fakeInteraction({ customId: timezone.responses[0].modal.toJSON().custom_id, kind: "modal", guildId, guild, client, userId, fields: { "last-date": "2026-10-31" } });
    await handleEventSchedulerInteraction(cutoff);
    return cutoff.responses[0].payload.components[0].components[0].toJSON().custom_id;
  }

  const aContinue = await startCutoff(events.A, "admin-a");
  const bContinue = await startCutoff(events.B, "admin-b");
  const aButton = fakeInteraction({ customId: aContinue, kind: "button", guildId, guild, client, userId: "admin-a" });
  const bButton = fakeInteraction({ customId: bContinue, kind: "button", guildId, guild, client, userId: "admin-b" });
  await handleEventSchedulerInteraction(aButton);
  await handleEventSchedulerInteraction(bButton);
  const assertDates = (interaction, expected) => assert.deepEqual(interaction.responses[0].modal.toJSON().components.slice(1).map((row) => row.components[0].label), expected);
  const saturdayDates = [
    "Saturday, October 17, 2026", "Saturday, October 24, 2026", "Saturday, October 31, 2026",
  ];
  const fridayDates = [
    "Friday, October 16, 2026", "Friday, October 23, 2026", "Friday, October 30, 2026",
  ];
  assertDates(aButton, saturdayDates);
  assertDates(bButton, fridayDates);

  const sameAdminA = await startCutoff(events.A, "same-admin");
  const sameAdminB = await startCutoff(events.B, "same-admin");
  const sameAdminBButton = fakeInteraction({ customId: sameAdminB, kind: "button", guildId, guild, client, userId: "same-admin" });
  const sameAdminAButton = fakeInteraction({ customId: sameAdminA, kind: "button", guildId, guild, client, userId: "same-admin" });
  await handleEventSchedulerInteraction(sameAdminBButton);
  await handleEventSchedulerInteraction(sameAdminAButton);
  assertDates(sameAdminBButton, fridayDates);
  assertDates(sameAdminAButton, saturdayDates);
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

test("adopted native presentation timezone persists across recurrence sync and series edits", async () => {
  const guildId = `native-timezone-persistence-${Date.now()}`;
  const native = {
    id: "native-mexico-series", name: "Mexico watch party",
    scheduledStartAt: new Date("2026-10-17T01:00:00.000Z"),
    scheduledEndAt: new Date("2026-10-17T02:00:00.000Z"),
    recurrenceRule: { startAt: new Date("2026-08-22T01:00:00.000Z"), frequency: 2, interval: 1, byWeekday: [5], count: 3 },
  };
  const interaction = { guildId, user: { id: "admin" }, guild: { scheduledEvents: { fetch: async () => native } } };
  const added = await addNativeEventToCalendar(interaction, native.id, "", { 0: "One", 1: "Two" }, "2026-10-24", true, "Default", "America/Mexico_City");
  let rows = store.listSeriesEvents(guildId, added.recurrence_series_id);
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((row) => row.event_timezone === "America/Mexico_City" && row.timezone === "America/Mexico_City"));
  assert.equal(rows[0].event_at, "2026-10-17T01:00:00.000Z");
  await syncDiscordRecurringSeries(guildId, store.getEvent(guildId, added.id));
  rows = store.listSeriesEvents(guildId, added.recurrence_series_id);
  assert.ok(rows.every((row) => row.event_timezone === "America/Mexico_City"));
  const before = Object.fromEntries(rows.map((row) => [row.id, row.event_at]));
  const changed = applyRecurringChanges(guildId, store.getEvent(guildId, added.id), "series", {
    event_timezone: "America/New_York", timezone: "America/New_York", event_at: "2099-01-01T00:00:00.000Z",
  });
  assert.ok(changed.length >= 2);
  rows = store.listSeriesEvents(guildId, added.recurrence_series_id);
  assert.ok(rows.every((row) => row.event_timezone === "America/New_York"));
  for (const row of rows) assert.equal(row.event_at, before[row.id]);
  await syncDiscordRecurringSeries(guildId, store.getEvent(guildId, added.id));
  rows = store.listSeriesEvents(guildId, added.recurrence_series_id);
  assert.ok(rows.every((row) => row.event_timezone === "America/New_York"));
});

test("one-off adopted native event persists the selected presentation timezone without changing its instant", async () => {
  const guildId = `native-timezone-oneoff-${Date.now()}`;
  const native = { id: "native-mexico-oneoff", name: "One-off", scheduledStartAt: new Date("2026-10-17T01:00:00.000Z") };
  const interaction = { guildId, user: { id: "admin" }, guild: { scheduledEvents: { fetch: async () => native } } };
  const added = await addNativeEventToCalendar(interaction, native.id, "Details", null, null, false, null, "America/Mexico_City");
  assert.equal(added.event_at, "2026-10-17T01:00:00.000Z");
  assert.equal(added.event_timezone, "America/Mexico_City");
  assert.equal(added.timezone, "America/Mexico_City");
});

