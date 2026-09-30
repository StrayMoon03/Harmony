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
