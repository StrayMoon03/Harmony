const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/stores/eventSchedulerStore");

test("calendar-only events do not require an announcement or link", () => {
  const guildId = `phase2b-${Date.now()}`;
  const eventId = store.createCalendarEvent({
    guildId,
    calendarChannelId: "calendar-channel",
    title: "SKZ CODE",
    eventDate: "2099-01-04",
    eventAt: null,
    eventTimezone: "America/New_York",
    calendarType: "stray_kids",
    category: "content",
    allDay: true,
    createdBy: "admin",
  });
  const event = store.getEvent(guildId, eventId);
  assert.equal(event.link, "");
  assert.equal(event.pending_count, 0);
  assert.deepEqual(store.listAnnouncements(eventId), []);
  assert.equal(store.updateEvent(guildId, eventId, { link: "https://example.com/skz" }).link, "https://example.com/skz");
  assert.equal(store.cancelEvent(guildId, eventId, "admin"), true);
});

test("recurring series cancellation can stop this-and-future without touching another series", () => {
  const guildId = `recurrence-cancel-${Date.now()}`;
  const make = (seriesId, index) => store.createCalendarEvent({
    guildId, calendarChannelId: "calendar-channel", title: seriesId, eventDate: `2099-01-${String(4 + index * 7).padStart(2, "0")}`,
    allDay: true, eventTimezone: null, calendarType: "community", category: "other", recurrenceSeriesId: seriesId,
    recurrenceRule: JSON.stringify({ type: "weekly", count: 3 }), recurrenceIndex: index, createdBy: "admin",
  });
  const firstSeries = [0, 1, 2].map((index) => make("series-a", index));
  const secondSeries = [0, 1].map((index) => make("series-b", index));
  assert.equal(store.cancelSeriesEvents(guildId, "series-a", "admin", 1), 2);
  assert.equal(store.getEvent(guildId, firstSeries[0]).cancelled_at, null);
  assert.equal(store.getEvent(guildId, firstSeries[1]), undefined);
  assert.ok(store.getEvent(guildId, secondSeries[0]));
});
