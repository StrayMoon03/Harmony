const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseEvent, localToUtc, buildCalendarMessages, parseManagerDraft,
  managerPanelContent, managerPanelComponents, managerCalendarType,
  managerModal,
} = require("../src/services/eventSchedulerService");

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
    timezone: "America/New_York",
    link: "",
    description: "New episode",
  }, "stray_kids");
  assert.equal(draft.calendarType, "stray_kids");
  assert.equal(draft.link, "");
  assert.equal(draft.allDay, true);
  assert.equal(draft.eventAt, null);
});

test("manager drafts retain timezone and validate optional links", () => {
  const draft = parseManagerDraft({
    title: "Concert",
    eventDate: "2099-07-14",
    eventTime: "20:00",
    timezone: "America/New_York",
    link: "https://example.com/concert",
    description: "Live show",
  }, "community");
  assert.equal(draft.allDay, false);
  assert.equal(draft.eventAt, "2099-07-15T00:00:00.000Z");
  assert.throws(() => parseManagerDraft({ title: "Bad", eventDate: "2099-01-01", eventTime: "", timezone: "America/New_York", link: "not-a-url", description: "" }, "community"), /http/);
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
