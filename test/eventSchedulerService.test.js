const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseEvent, localToUtc, buildCalendarMessages, parseManagerDraft,
  managerPanelContent, managerPanelComponents, managerCalendarType,
  managerModal, handleEventSchedulerInteraction,
  installScheduleManagers, publishMonthlyCalendar, refreshPublishedCalendar,
  buildYoutifulCalendarMessages, YOUTIFUL_EVENT_TYPES, YOUTIFUL_EVENT_TYPE_ICONS, YOUTIFUL_TIMEZONE_OPTIONS,
  interestedStateSupport,
  handleReminderInteraction,
  nativeEventEndTime,
  syncNativeScheduledEvent,
} = require("../src/services/eventSchedulerService");
const store = require("../src/stores/eventSchedulerStore");

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
  assert.equal(part.embeds[0].title, "📅 YOUTIFUL STAYS • OCTOBER 2026");
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
  assert.match(embed.description, /🎬 \*\*SKZ CODE\*\*/);
  assert.match(embed.description, /<t:4071240000:D>/);
  assert.match(embed.description, /<t:4071240000:t>/);
  assert.match(embed.description, /🎂 \*\*Birthday\*\* • All Day/);
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
  assert.match(embed.description, /Friday, October 16, 2026/);
  assert.match(embed.description, /🛍️ \*\*RUN IT JAPAN Pop-Up\*\* • All Day/);
  assert.ok(embed.description.indexOf("**RUN IT JAPAN Pop-Up**") < embed.description.indexOf("Limited goods"));
  assert.match(embed.description, /📍 Fukuoka, Japan/);
  assert.match(embed.description, /\[Open event link\]\(https:\/\/example\.com\/popup\)/);
});

test("timed calendar cards use one localized date token and a time-only token", () => {
  const parts = buildCalendarMessages("stray_kids", "2026-10", [{
    title: "SKZ CODE", category: "content", event_date: "2026-10-01", event_at: "2026-10-01T11:00:00.000Z", all_day: 0,
  }], 0);
  const description = parts[0].embeds[0].description;
  assert.match(description, /<t:1790852400:D>/);
  assert.match(description, /<t:1790852400:t> • 🎬 \*\*SKZ CODE\*\*/);
  assert.doesNotMatch(description, /<t:1790852400:F>/);
  assert.equal((description.match(/<t:1790852400:D>/g) || []).length, 1);
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
  const native = { edit: async (payload) => { calls.push(payload); } };
  const client = { guilds: { cache: new Map([["g", { scheduledEvents: { cache: new Map([["native-edit", native]]) } }]]) } };
  const event = {
    guild_id: "g", discord_event_id: "native-edit", event_at: "2026-10-24T09:30:00.000Z",
    event_end_at: "2026-10-24T12:30:00.000Z", title: "Updated concert", description: "Updated",
  };
  assert.equal(await syncNativeScheduledEvent(client, event), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scheduledEndTime.toISOString(), event.event_end_at);
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
});

test("manager modals allow blank optional fields", () => {
  const json = managerModal("manager:test", "Add event", [
    { id: "title", label: "Title", required: true, value: "Event" },
    { id: "link", label: "Link", value: "" },
  ]).toJSON();
  assert.equal(json.components.length, 2);
  assert.equal(json.components[1].components[0].value, undefined);
});

function fakeInteraction({ customId, kind, guildId, userId = "admin", values = [], fields = {}, client = {} }) {
  const interaction = {
    customId,
    guildId,
    user: { id: userId },
    client,
    memberPermissions: { has: () => true },
    values,
    fields: { getTextInputValue: (name) => fields[name] || "" },
    responses: [],
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "select",
    isModalSubmit: () => kind === "modal",
    reply: async (payload) => { interaction.responses.push({ type: "reply", payload }); },
    deferReply: async (payload) => { interaction.responses.push({ type: "deferReply", payload }); },
    followUp: async (payload) => { interaction.responses.push({ type: "followUp", payload }); },
    editReply: async (payload) => { interaction.responses.push({ type: "editReply", payload }); },
    showModal: async (modal) => { interaction.responses.push({ type: "modal", modal }); },
    update: async (payload) => { interaction.responses.push({ type: "update", payload }); },
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
  assert.match(rendered, /<t:1790852400:D>/);
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
  assert.match(details.responses[0].payload.content, /Event saved/);
  assert.deepEqual(details.responses[0].payload.components, []);
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
    assert.match(description, new RegExp(`${emoji} 🎬 \\*\\*Event\\*\\*`));
  }
  const ot8 = buildCalendarMessages("stray_kids", "2099-01", [{ title: "OT8", category: "content", member: null, event_date: "2099-01-01", all_day: 1 }], 0)[0].embeds[0].description;
  assert.match(ot8, /🎬 \*\*OT8\*\*/);
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
  // Modal submission itself persists the editable fields; category/member are
  // metadata follow-ups and must not gate the core edit.
  const immediatelySaved = store.getEvent(guildId, eventId);
  assert.equal(immediatelySaved.title, "Updated Concert");
  assert.equal(immediatelySaved.event_date, "2099-08-14");
  const editCategoryMenu = editDetails.responses[0].payload.components[0].toJSON().components[0];
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
  await publishMonthlyCalendar(client, guildId, "stray_kids", "2026-10");
  const originalMessage = await strayKids.messages.fetch("calendar-live-flow-stray-kids-message-1");

  const add = fakeInteraction({ customId: "harmony-manager:stray_kids:add", kind: "button", guildId, client });
  await handleEventSchedulerInteraction(add);
  const category = fakeInteraction({ customId: "harmony-manager:stray_kids:addcategory:new", kind: "select", guildId, client, values: ["birthday"] });
  await handleEventSchedulerInteraction(category);
  const details = fakeInteraction({
    customId: "harmony-manager:stray_kids:addmodal", kind: "modal", guildId, client,
    fields: { title: "Bang Chan's 29th Birthday!", "event-date": "2026-10-03", "event-time": "", location: "Seoul, South Korea", description: "" },
  });
  await handleEventSchedulerInteraction(details);
  assert.equal(details.responses[0].type, "reply");
  assert.equal(details.responses.some((response) => response.type === "editReply"), false);
  assert.equal(strayKids.messageCount(), 1);
  assert.match((await strayKids.messages.fetch(originalMessage.id)).payload.embeds[0].description, /Bang Chan's 29th Birthday/);

  const timedAdd = fakeInteraction({ customId: "harmony-manager:stray_kids:add", kind: "button", guildId, client });
  await handleEventSchedulerInteraction(timedAdd);
  const timedCategory = fakeInteraction({ customId: "harmony-manager:stray_kids:addcategory:new", kind: "select", guildId, client, values: ["content"] });
  await handleEventSchedulerInteraction(timedCategory);
  const timedDetails = fakeInteraction({
    customId: "harmony-manager:stray_kids:addmodal", kind: "modal", guildId, client,
    fields: { title: "SKZ CODE EP. 104", "event-date": "2026-10-01", "event-time": "07:00", location: "New York, USA", description: "" },
  });
  await handleEventSchedulerInteraction(timedDetails);
  assert.equal(timedDetails.responses[0].type, "reply");
  assert.match((await strayKids.messages.fetch(originalMessage.id)).payload.embeds[0].description, /SKZ CODE EP\. 104/);

  const view = fakeInteraction({ customId: "harmony-manager:stray_kids:view", kind: "button", guildId, client });
  await handleEventSchedulerInteraction(view);
  const viewModal = fakeInteraction({
    customId: "harmony-manager:stray_kids:viewmodal", kind: "modal", guildId, client,
    fields: { month: "2026-10" },
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
  assert.match(editOption.description, /2026-10-03/);

  const cancel = fakeInteraction({ customId: "harmony-manager:stray_kids:cancel", kind: "button", guildId, client });
  await handleEventSchedulerInteraction(cancel);
  const cancelOptions = cancel.responses[0].payload.components[0].toJSON().components[0].options;
  const cancelOption = cancelOptions.find((option) => option.label.includes("Bang Chan's 29th Birthday"));
  assert.ok(cancelOption);
  assert.match(cancelOption.label, /Bang Chan's 29th Birthday/);
  assert.doesNotMatch(cancelOption.label, /#\d+/);
});


test("Youtiful create and edit modals use a timezone step instead of Location or End Time", async () => {
  const guildId = "youtiful-timezone-ui-" + Date.now();
  const add = fakeInteraction({ customId: "harmony-manager:community:add", kind: "button", guildId });
  await handleEventSchedulerInteraction(add);
  const type = fakeInteraction({ customId: "harmony-manager:community:ystype", kind: "select", guildId, values: ["kdrama"] });
  await handleEventSchedulerInteraction(type);
  const title = fakeInteraction({ customId: "harmony-manager:community:ystitle", kind: "select", guildId, values: ["title:K-Drama With Us"] });
  await handleEventSchedulerInteraction(title);
  const addModal = title.responses[0].modal.toJSON();
  const addIds = addModal.components.map((row) => row.components[0].custom_id);
  assert.deepEqual(addIds, ["event-date", "event-time", "description"]);
  assert.equal(addIds.includes("location"), false);
  assert.equal(addIds.includes("event-end-time"), false);

  const eventDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const eventId = store.createCalendarEvent({ guildId, calendarChannelId: "calendar-community", title: "K-Drama With Us", eventDate, allDay: true, eventTimezone: null, timezone: null, calendarType: "community", category: "kdrama", calendarEventType: "kdrama", createdBy: "admin" });
  const edit = fakeInteraction({ customId: "harmony-manager:community:edit", kind: "button", guildId });
  await handleEventSchedulerInteraction(edit);
  const select = fakeInteraction({ customId: "harmony-manager:community:editselect", kind: "select", guildId, values: [String(eventId)] });
  await handleEventSchedulerInteraction(select);
  const editModal = select.responses[0].modal.toJSON();
  const editIds = editModal.components.map((row) => row.components[0].custom_id);
  assert.deepEqual(editIds, ["title", "event-date", "event-time", "description"]);
  assert.equal(editIds.includes("location"), false);
  assert.equal(editIds.includes("event-end-time"), false);
});

test("Youtiful timezone choices store IANA zones and enforce timed/all-day rules", () => {
  assert.equal(YOUTIFUL_TIMEZONE_OPTIONS.find((option) => option.label === "Eastern Time").value, "America/New_York");
  assert.equal(YOUTIFUL_TIMEZONE_OPTIONS.find((option) => option.label === "Korea Time").value, "Asia/Seoul");
  assert.equal(YOUTIFUL_TIMEZONE_OPTIONS.find((option) => option.label === "Japan Time").value, "Asia/Tokyo");
  const timed = parseManagerDraft({ title: "Community event", eventDate: "2026-10-24", eventTime: "18:30", timezone: "America/New_York", description: "" }, "community");
  assert.equal(timed.eventTimezone, "America/New_York");
  assert.equal(timed.eventLocation, "");
  assert.throws(() => parseManagerDraft({ title: "Missing timezone", eventDate: "2026-10-24", eventTime: "18:30", timezone: "", description: "" }, "community"), /time zone/i);
  const allDay = parseManagerDraft({ title: "Birthday", eventDate: "2026-10-03", eventTime: "", timezone: "", description: "" }, "community");
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.eventAt, null);
  assert.equal(allDay.eventTimezone, null);
});

test("explicit Youtiful edit timezone cannot fall back to legacy data", () => {
  assert.throws(() => parseManagerDraft({
    title: "Edited timed event",
    eventDate: "2026-10-24",
    eventTime: "18:30",
    timezone: "",
    fallbackTimezone: "America/New_York",
    description: "",
  }, "community"), /time zone/i);

  assert.throws(() => parseManagerDraft({
    title: "Edited timed event",
    eventDate: "2026-10-24",
    eventTime: "18:30",
    timezone: "not-an-iana-zone",
    fallbackTimezone: "Asia/Seoul",
    description: "",
  }, "community"), /time zone/i);

  const explicitAllDay = parseManagerDraft({
    title: "Edited all-day event",
    eventDate: "2026-10-03",
    eventTime: "",
    timezone: "",
    fallbackTimezone: "Asia/Seoul",
    description: "",
  }, "community");
  assert.equal(explicitAllDay.allDay, true);
  assert.equal(explicitAllDay.eventTimezone, null);
});

test("legacy Youtiful location/timezone data remains editable without changing Stray Kids location behavior", () => {
  const legacy = parseManagerDraft({ title: "Legacy event", eventDate: "2026-10-24", eventTime: "18:30", location: "Fukuoka, Japan", fallbackTimezone: "Asia/Tokyo", description: "" }, "community");
  assert.equal(legacy.eventTimezone, "Asia/Tokyo");
  const skz = parseManagerDraft({ title: "Stray Kids event", eventDate: "2026-10-24", eventTime: "18:30", location: "Fukuoka, Japan", description: "" }, "stray_kids");
  assert.equal(skz.eventTimezone, "Asia/Tokyo");
});
