// Offline fixtures only. Never connects to Discord or a production calendar.
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
process.env.HARMONY_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "countdown-preview-")),
  "fixture.sqlite",
);
const { render } = require("../src/services/concertCountdownRender");
const { buildCountdown } = require("../src/services/concertCountdownModel");
const store = require("../src/stores/concertCountdownStore"),
  calendar = require("../src/stores/eventSchedulerStore"),
  rooms = require("../src/stores/adminRoomStore");
const manager = require("../src/services/concertCountdownManager");
const output = path.resolve(__dirname, "../docs/countdown-previews");
fs.mkdirSync(output, { recursive: true });
const config = {
  guildId: "fixture-server",
  city: "Chicago",
  country: "United States",
  venue: "Soldier Field",
  timezone: "America/Chicago",
  eventIds: [1, 2, 3],
};
const dates = ["2027-06-18", "2027-06-19", "2027-06-20"];
const events = dates.map((date, n) => ({
  id: n + 1,
  guild_id: config.guildId,
  calendar_type: "stray_kids",
  category: "concert",
  all_day: 1,
  event_date: date,
}));
(async () => {
  for (const [name, count, now] of [
    ["chicago-two-dates", 2, "2026-11-24T17:00Z"],
    ["single-date", 1, "2026-11-24T17:00Z"],
    ["multiple-dates", 3, "2026-11-24T17:00Z"],
    ["concert-day-states", 3, "2027-06-19T17:00Z"],
  ]) {
    const model = {
      ...buildCountdown(config, events.slice(0, count), new Date(now)),
      testLabel: "TEST PREVIEW • FIXTURE DATES • NO VENUE PHOTO",
    };
    fs.writeFileSync(path.join(output, name + ".png"), await render(model));
  }
  rooms.savePanel({
    guildId: config.guildId,
    channelId: "private-fixture",
    messageId: "fixture-panel",
  });
  const actualIds = dates
    .slice(0, 2)
    .map((date) =>
      calendar.createCalendarEvent({
        guildId: config.guildId,
        calendarChannelId: "calendar-fixture",
        title: "Chicago concert — TEST FIXTURE",
        eventDate: date,
        eventLocation: "Soldier Field",
        eventTimezone: "America/Chicago",
        calendarType: "stray_kids",
        category: "concert",
        allDay: true,
        createdBy: "fixture-admin",
      }),
    );
  store.save(config.guildId, "fixture-concert-room", {
    ...config,
    eventIds: actualIds,
  });
  const s = manager.createSession({
    guildId: config.guildId,
    channelId: "private-fixture",
    user: { id: "fixture-admin" },
  });
  s.room = "fixture-concert-room";
  s.draft = { ...config, eventIds: actualIds };
  const previews = {
    home: manager.home(s),
    details: manager.detail(s),
    setup: manager.draftPage(s),
    events: manager.eventPage(s),
    venueModal: manager.fieldsModal(s).toJSON(),
  };
  fs.writeFileSync(
    path.join(output, "manager-payloads.json"),
    JSON.stringify(
      previews,
      (key, value) =>
        key === "custom_id"
          ? value.replace(
              /harmony-countdown:[a-f0-9]+:/,
              "harmony-countdown:PREVIEW:",
            )
          : value,
      2,
    ) + "\n",
  );
  console.log(
    "Generated four actual-renderer PNGs and actual manager component payloads (fixtures only).",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
