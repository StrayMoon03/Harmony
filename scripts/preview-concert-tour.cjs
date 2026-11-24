"use strict";
// Isolated fixtures only: no production database, Discord client, publication or deployment.
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
process.env.HARMONY_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "tour-ui-preview-")),
  "fixture.sqlite",
);
const tour = require("../src/services/concertTourCalendar"),
  manager = require("../src/services/concertCountdownManager"),
  calendar = require("../src/stores/eventSchedulerStore"),
  rooms = require("../src/stores/adminRoomStore");
const out = path.join(__dirname, "../docs/countdown-tour-fix");
fs.mkdirSync(out, { recursive: true });
const guild = "fixture-tour-server";
rooms.savePanel({
  guildId: guild,
  channelId: "fixture-private",
  messageId: "fixture-panel",
});
calendar.createCalendarEvent({
  guildId: guild,
  calendarChannelId: "fixture-calendar",
  title: "RUN IT Chicago",
  eventDate: "2027-06-18",
  allDay: true,
  eventTimezone: "America/Chicago",
  timezone: "America/Chicago",
  eventLocation: "Soldier Field",
  calendarType: "stray_kids",
  category: "other",
  createdBy: "fixture-admin",
});
const s = manager.createSession({
  guildId: guild,
  channelId: "fixture-private",
  user: { id: "fixture-admin" },
});
s.room = "fixture-chicago-room";
const previews = { locations: manager.eventPage(s) };
s.locationKey = "chicago";
previews.missing = manager.eventPage(s);
previews.review = manager.tourReviewPage(s, tour.scopedManifest("chicago"));
const review = s.importReview;
tour.importConfirmed(
  guild,
  review.manifest,
  review.fingerprint,
  "fixture-admin",
);
previews.ready = manager.eventPage(s);
fs.writeFileSync(
  path.join(out, "ui-payloads.json"),
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
const quote = (value) => '"' + String(value).replaceAll('"', '""') + '"';
const columns = [
  "City",
  "Country",
  "Venue",
  "Venue local date",
  "Time zone",
  "Official source",
  "Checked",
];
const lines = tour.bundled.locations.flatMap((l) =>
  l.dates.map((d) =>
    [
      l.city,
      l.country,
      l.venue,
      d.date,
      l.timezone,
      d.sourceUrl,
      tour.bundled.verifiedAt,
    ]
      .map(quote)
      .join(","),
  ),
);
fs.writeFileSync(
  path.join(out, "confirmed-tour-coverage.csv"),
  columns.map(quote).join(",") + "\n" + lines.join("\n") + "\n",
);
console.log(
  "Generated actual component payloads and a 53-date source coverage checklist; fixtures only.",
);
