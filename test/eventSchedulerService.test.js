const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseEvent, localToUtc, buildCalendarMessages, parseManagerDraft,
  managerPanelContent, managerPanelComponents, managerCalendarType,
  managerModal, handleEventSchedulerInteraction,
  installScheduleManagers, publishMonthlyCalendar, refreshPublishedCalendar,
} = require("../src/services/eventSchedulerService");
const store = require("../src/stores/eventSchedulerStore");

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
  assert.match(parts[0], /🎬 \*\*SKZ CODE\*\*/);
  assert.match(parts[0], /<t:4071240000:F>/);
  assert.match(parts[0], /🎂 \*\*Birthday\*\*/);
  assert.doesNotMatch(parts[0], /🎂 \*\*Birthday\*\*\n<t:/);
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
  assert.ok(parts.every((part) => part.length <= 1900));
  assert.match(parts.at(-1), /Last updated/);
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

test("manager drafts resolve locations and separate description plus link", () => {
  const draft = parseManagerDraft({
    title: "Concert",
    eventDate: "2099-07-14",
    eventTime: "20:00",
    location: "Fukuoka, Japan",
    description: "Live show\nhttps://example.com/concert",
  }, "community");
  assert.equal(draft.allDay, false);
  assert.equal(draft.eventTimezone, "Asia/Tokyo");
  assert.equal(draft.link, "https://example.com/concert");
  assert.equal(draft.description, "Live show");
  const allDayWithoutLocation = parseManagerDraft({ title: "Birthday", eventDate: "2099-01-01", eventTime: "", location: "", description: "" }, "community");
  assert.equal(allDayWithoutLocation.allDay, true);
  assert.equal(allDayWithoutLocation.eventAt, null);
  assert.equal(allDayWithoutLocation.eventTimezone, null);
  assert.equal(allDayWithoutLocation.eventLocation, "");
  assert.throws(() => parseManagerDraft({ title: "Timed", eventDate: "2099-01-01", eventTime: "18:00", location: "", description: "" }, "community"), /resolve/);
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
  const rendered = buildCalendarMessages("stray_kids", "2026-10", [saved], 0).join("\n");
  assert.match(rendered, /<t:1790852400:F>/);
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
    "📱 Video Call", "✨ Appearance", "🎮 Community / Game", "📌 Other",
  ]);
  assert.equal(categoryMenuJson.options.some((option) => option.label === "content"), false);

  const category = fakeInteraction({
    customId: "harmony-manager:stray_kids:addcategory:new", kind: "select", guildId, values: ["content"],
  });
  await handleEventSchedulerInteraction(category);
  assert.equal(category.responses[0].type, "modal");
  assert.equal(category.responses[0].modal.toJSON().custom_id, "harmony-manager:stray_kids:addmodal");
  assert.equal(category.responses[0].modal.toJSON().components.length, 5);

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

  const editDetails = fakeInteraction({
    customId: `harmony-manager:stray_kids:editmodal:${eventId}`, kind: "modal", guildId,
    fields: {
      title: "Concert", "event-date": "2099-07-14", "event-time": "20:00",
      location: "New York, USA", description: "Updated details\nhttps://example.com/new",
    },
  });
  await handleEventSchedulerInteraction(editDetails);
  const editCategoryMenu = editDetails.responses[0].payload.components[0].toJSON().components[0];
  assert.ok(editCategoryMenu.options.some((option) => option.label === "🎤 Concert" && option.default));
  assert.equal(editCategoryMenu.options.some((option) => option.label === "concert"), false);

  const changedCategory = fakeInteraction({
    customId: `harmony-manager:stray_kids:editcategory:${eventId}`, kind: "select", guildId, values: ["content"],
  });
  await handleEventSchedulerInteraction(changedCategory);
  assert.equal(changedCategory.responses[0].type, "update");
  const updated = store.getEvent(guildId, eventId);
  assert.equal(updated.category, "content");
  assert.equal(updated.link, "https://example.com/new");
  assert.equal(updated.description, "Updated details");
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
  assert.match(afterAllDay.payload.content, /Bang Chan's 29th Birthday/);
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
  assert.match(afterTimed.payload.content, /Timed event/);
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
  assert.match((await strayKids.messages.fetch(originalMessage.id)).payload.content, /Bang Chan's 29th Birthday/);

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
  assert.match((await strayKids.messages.fetch(originalMessage.id)).payload.content, /SKZ CODE EP\. 104/);

  const view = fakeInteraction({ customId: "harmony-manager:stray_kids:view", kind: "button", guildId, client });
  await handleEventSchedulerInteraction(view);
  const viewModal = fakeInteraction({
    customId: "harmony-manager:stray_kids:viewmodal", kind: "modal", guildId, client,
    fields: { month: "2026-10" },
  });
  await handleEventSchedulerInteraction(viewModal);
  assert.equal(viewModal.responses[0].type, "deferReply");
  assert.equal(viewModal.responses.some((response) => response.type === "reply"), false);
  const previewContent = viewModal.responses.find((response) => response.type === "editReply").payload.content;
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
