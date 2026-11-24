const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "concert-tour-"));
process.env.HARMONY_DB_PATH = path.join(temp, "tour.sqlite");
const { getDb, closeDb } = require("../src/db/sqlite");
const calendar = require("../src/stores/eventSchedulerStore"),
  countdowns = require("../src/stores/concertCountdownStore");
const tour = require("../src/services/concertTourCalendar"),
  identity = require("../src/services/concertTourIdentity"),
  {
    buildCountdown,
    validateConfig,
  } = require("../src/services/concertCountdownModel");
let next = 0;
const guild = () => "tour-test-" + ++next;
const chicago = () => tour.scopedManifest("chicago");
function event(g, extra = {}) {
  return calendar.createCalendarEvent({
    guildId: g,
    calendarChannelId: "approved-calendar",
    title: "Stray Kids World Tour RUN IT CHICAGO",
    eventLocation: "Soldier Field",
    timezone: "America/Chicago",
    eventTimezone: "America/Chicago",
    eventDate: "2027-06-18",
    allDay: true,
    calendarType: "stray_kids",
    category: "concert",
    createdBy: "admin",
    ...extra,
  });
}
function approve(g, m = tour.bundled) {
  const review = tour.audit(g, m);
  return tour.importConfirmed(g, m, review.fingerprint, "admin");
}
function config(g, ids) {
  return {
    guildId: g,
    city: "Chicago",
    country: "United States",
    venue: "Soldier Field",
    timezone: "America/Chicago",
    eventIds: ids,
  };
}
test("verified reference covers every announced city, all 53 performances and additional nights", () => {
  const m = tour.validateManifest(tour.bundled),
    all = identity.stops(m);
  const expected = [
    "Seoul",
    "Tokyo",
    "Nagoya",
    "Osaka",
    "Fukuoka",
    "Hong Kong",
    "Taipei",
    "Bangkok",
    "Singapore",
    "Yokohama",
    "Seattle",
    "Vancouver",
    "Santa Clara",
    "San Diego",
    "Los Angeles",
    "Arlington",
    "Houston",
    "Atlanta",
    "Miami",
    "Orlando",
    "Chicago",
    "Baltimore",
    "Toronto",
    "East Rutherford",
    "Paris",
    "London",
    "Munich",
    "Vienna",
    "Barcelona",
    "Arnhem",
    "Milan",
  ].sort();
  assert.deepEqual(
    [...new Set(m.locations.map((l) => l.city))].sort(),
    expected,
  );
  assert.equal(all.length, 53);
  assert.equal(m.locations.length, 34);
  for (const [key, date] of [
    ["chicago", "2027-06-19"],
    ["paris", "2027-07-10"],
    ["london", "2027-07-14"],
    ["munich", "2027-07-18"],
    ["arnhem", "2027-07-28"],
    ["seoul-special", "2027-01-01"],
    ["seoul-special", "2027-01-02"],
  ])
    assert.ok(all.some((s) => s.location.key === key && s.date === date));
  assert.ok(all.every((s) => tour.officialSource(s.sourceUrl)));
  assert.equal(new Set(all.map((s) => s.key)).size, 53);
});
test("read-only picker lists missing locations without creating any calendar records", () => {
  const g = guild();
  assert.equal(tour.groups(g).length, 34);
  assert.equal(tour.groups(g, "Chicago")[0].audit.length, 2);
  assert.equal(tour.listConcerts(g).length, 0);
  assert.equal(tour.audit(g).counts.missing, 53);
  assert.equal(
    getDb()
      .prepare("SELECT count(*) n FROM scheduled_events WHERE guild_id=?")
      .get(g).n,
    0,
  );
});
test("approved import creates all confirmed dates in the existing canonical calendar, with no notifications", () => {
  const g = guild();
  calendar.setCalendarChannels(g, "real-calendar", null);
  const result = approve(g);
  assert.equal(result.created, 53);
  assert.equal(tour.listConcerts(g).length, 53);
  assert.equal(tour.audit(g).counts.ready, 53);
  assert.equal(
    getDb()
      .prepare(
        "SELECT count(*) n FROM scheduled_announcements WHERE event_id IN (SELECT id FROM scheduled_events WHERE guild_id=?)",
      )
      .get(g).n,
    0,
  );
  assert.equal(
    getDb()
      .prepare("SELECT count(*) n FROM concert_countdowns WHERE guild_id=?")
      .get(g).n,
    0,
  );
  assert.ok(
    tour
      .listConcerts(g)
      .every(
        (e) =>
          e.source_channel_id === "real-calendar" &&
          e.category === "concert" &&
          e.all_day === 1 &&
          e.event_at === null,
      ),
  );
});
test("repeat and simultaneous stale imports never create duplicate calendar entries", () => {
  const g = guild(),
    m = chicago(),
    review = tour.audit(g, m);
  const first = tour.importConfirmed(g, m, review.fingerprint, "admin");
  assert.equal(first.created, 2);
  assert.throws(
    () => tour.importConfirmed(g, m, review.fingerprint, "another-admin"),
    /changed/,
  );
  const again = approve(g, m);
  assert.equal(again.created, 0);
  assert.equal(again.reused, 2);
  assert.equal(tour.listConcerts(g).length, 2);
});
test("existing canonical events are reused without changing IDs, timing, descriptions or links", () => {
  const g = guild(),
    id = event(g, {
      allDay: false,
      eventAt: "2027-06-19T01:00:00Z",
      eventDate: "2027-06-19",
      link: "https://example.test/custom",
      description: "Keep my notes",
    }),
    before = calendar.getEvent(g, id);
  const result = approve(g, chicago());
  assert.equal(result.created, 1);
  assert.equal(result.reused, 1);
  assert.deepEqual(calendar.getEvent(g, id), before);
  assert.equal(tour.listConcerts(g).length, 2);
});
test("legacy misclassification is visible and usable without silently rewriting the calendar", () => {
  const g = guild(),
    id = event(g, { category: "other" });
  assert.equal(tour.audit(g, chicago()).counts.repair, 1);
  const rows = tour.listConcerts(g, "Chicago");
  assert.equal(rows[0].id, id);
  assert.equal(calendar.getEvent(g, id).category, "other");
  validateConfig(config(g, [id]), rows);
  assert.equal(
    buildCountdown(config(g, [id]), rows, new Date("2027-06-17T12:00Z"))
      .panels[0].state,
    "tomorrow",
  );
  const result = approve(g, chicago());
  assert.equal(result.repaired, 1);
  assert.equal(calendar.getEvent(g, id).category, "concert");
});
test("wrong-calendar concerts are audited and repaired only following approval, reusing their IDs", () => {
  const g = guild(),
    id = event(g, { calendarType: "community" });
  assert.equal(tour.listConcerts(g).length, 0);
  assert.equal(tour.audit(g, chicago()).counts.repair, 1);
  const result = approve(g, chicago());
  assert.equal(result.repaired, 1);
  assert.equal(calendar.getEvent(g, id).calendar_type, "stray_kids");
  assert.equal(tour.listConcerts(g).length, 2);
});
test("search supports city, country, venue, numeric dates, month names and local city aliases", () => {
  const g = guild();
  approve(g);
  for (const [query, expected] of [
    ["Chicago", 2],
    ["United States", 13],
    ["US", 13],
    ["Soldier Field", 2],
    ["2027-06-19", 1],
    ["6/19/2027", 1],
    ["June 19 2027", 1],
    ["Canada", 2],
    ["Munchen", 2],
    ["München", 2],
    ["Wien", 1],
    ["Milano", 1],
    ["Nanterre", 2],
    ["Inglewood", 1],
  ])
    assert.equal(tour.listConcerts(g, query).length, expected, query);
});
test("venue-local dates are used for matching and date searches across UTC midnight", () => {
  const g = guild(),
    id = event(g, {
      allDay: false,
      eventAt: "2027-06-19T01:00:00Z",
      eventDate: "2027-06-19",
    });
  assert.equal(tour.audit(g, chicago()).entries[0].eventId, id);
  assert.equal(tour.listConcerts(g, "2027-06-18").length, 1);
  assert.equal(tour.listConcerts(g, "2027-06-19").length, 0);
});
test("location groups collect multiple nights and keep distinct venues in the same city separate", () => {
  const g = guild();
  approve(g);
  const chicago = tour.groups(g, "Chicago");
  assert.equal(chicago.length, 1);
  assert.equal(chicago[0].events.length, 2);
  const tokyo = tour.groups(g, "Tokyo");
  assert.equal(tokyo.length, 2);
  assert.deepEqual(tokyo.map((l) => l.events.length).sort(), [2, 3]);
  const seoul = tour.groups(g, "Seoul");
  assert.equal(seoul.length, 2);
  assert.deepEqual(seoul.map((l) => l.events.length).sort(), [2, 5]);
});
test("presales, watch parties and unapproved Radar/Calendar Review candidates cannot become tour performances", () => {
  const g = guild();
  event(g, { title: "RUN IT Chicago presale", category: "other" });
  event(g, { title: "RUN IT Chicago watch party", category: "stream" });
  calendar.createOrGetCalendarCandidate({
    guildId: g,
    title: "RUN IT Chicago",
    proposedEventDate: "2027-06-18",
    sourceUrl: "https://example.test/announcement",
    sourceType: "member_submission",
  });
  assert.equal(tour.listConcerts(g).length, 0);
  assert.equal(tour.audit(g, chicago()).counts.missing, 2);
  assert.equal(approve(g, chicago()).created, 2);
  assert.equal(calendar.listCalendarCandidates(g, "open").length, 1);
});
test("ambiguous existing records are skipped and never duplicated", () => {
  const g = guild();
  event(g);
  event(g);
  const plan = tour.audit(g, chicago());
  assert.equal(plan.entries[0].status, "blocked");
  const result = approve(g, chicago());
  assert.equal(result.blocked, 1);
  assert.equal(result.created, 1);
  assert.equal(tour.listConcerts(g).length, 3);
});
test("uncertain same-date legacy records and invalid-date tour records require review instead of another insert", () => {
  const g = guild();
  event(g, { title: "Chicago", category: "other" });
  assert.equal(tour.audit(g, chicago()).entries[0].status, "blocked");
  const g2 = guild();
  event(g2, { eventDate: null });
  assert.equal(tour.audit(g2, chicago()).counts.blocked, 2);
});
test("canceled dates are never resurrected and reschedules retain the existing stable IDs", () => {
  const g = guild();
  approve(g, chicago());
  const records = tour.listConcerts(g),
    first = records[0].id,
    second = records[1].id;
  calendar.cancelEvent(g, first, "admin");
  calendar.updateEvent(g, second, { event_date: "2027-06-20" });
  const review = tour.audit(g, chicago());
  assert.equal(review.counts.cancelled, 1);
  assert.equal(review.counts.rescheduled, 1);
  const result = approve(g, chicago());
  assert.equal(result.created, 0);
  assert.equal(result.cancelled, 1);
  assert.equal(tour.listConcerts(g)[0].id, second);
  assert.equal(calendar.getEvent(g, second).event_date, "2027-06-20");
});
test("all countdown configuration, image, enabled state and message IDs survive import unchanged", () => {
  const g = guild(),
    id = event(g);
  countdowns.save(g, "concert-room", config(g, [id]));
  countdowns.photo(g, "concert-room", Buffer.from("persistent photo"), "jpeg");
  countdowns.update(g, "concert-room", {
    enabled: 1,
    message_id: "existing-message",
    published_at: "already-published",
  });
  const before = countdowns.get(g, "concert-room");
  approve(g);
  assert.deepEqual(countdowns.get(g, "concert-room"), before);
  closeDb();
  assert.deepEqual(countdowns.get(g, "concert-room"), before);
});
test("import transaction rolls back all writes if any date fails", () => {
  const g = guild(),
    m = chicago(),
    before = tour.audit(g, m);
  getDb().exec(
    "CREATE TRIGGER fail_test_import BEFORE INSERT ON scheduled_events WHEN NEW.guild_id='" +
      g +
      "' AND NEW.event_date='2027-06-19' BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  assert.throws(
    () => tour.importConfirmed(g, m, before.fingerprint, "admin"),
    /fixture failure/,
  );
  assert.equal(tour.audit(g, m).counts.missing, 2);
  assert.equal(
    getDb()
      .prepare("SELECT count(*) n FROM concert_tour_events WHERE guild_id=?")
      .get(g).n,
    0,
  );
  getDb().exec("DROP TRIGGER fail_test_import");
});
test("guild isolation applies to audit, imports, metadata and search", () => {
  const a = guild(),
    b = guild();
  approve(a, chicago());
  assert.equal(tour.listConcerts(b).length, 0);
  assert.equal(tour.audit(b, chicago()).counts.missing, 2);
  assert.equal(approve(b, chicago()).created, 2);
  assert.equal(tour.listConcerts(a).length, 2);
});
test("validated JSON supports future confirmed locations with no code change or redeployment", () => {
  const g = guild(),
    m = {
      tourId: "run-it-2026-2027",
      verifiedAt: "2026-11-24",
      locations: [
        {
          key: "fixture-future",
          city: "Fixture City",
          country: "Fixture Country",
          venue: "Fixture Stadium",
          timezone: "Europe/London",
          aliases: ["Testland"],
          dates: [
            {
              date: "2028-02-29",
              sourceUrl: "https://straykids.jype.com/notice/future-fixture",
            },
          ],
        },
      ],
    };
  assert.equal(approve(g, m).created, 1);
  assert.equal(tour.listConcerts(g, "Testland").length, 1);
  assert.equal(tour.groups(g, "Fixture Country")[0].city, "Fixture City");
  assert.equal(approve(g, m).created, 0);
});
test("invalid dates, zones, duplicate physical dates, huge manifests and untrusted source URLs are rejected", () => {
  const clone = () => JSON.parse(JSON.stringify(chicago()));
  for (const mutate of [
    (m) => (m.locations[0].dates[0].date = "2027-02-29"),
    (m) => (m.locations[0].timezone = "Mars/Chicago"),
    (m) =>
      (m.locations[0].dates[0].sourceUrl = "http://straykids.jype.com/notice"),
    (m) =>
      (m.locations[0].dates[0].sourceUrl =
        "https://ticketmaster.com.evil.test/date"),
    (m) =>
      (m.locations[0].dates[0].sourceUrl =
        "https://user:password@straykids.jype.com/notice"),
    (m) => m.locations.push({ ...m.locations[0], key: "duplicate-identity" }),
    (m) => (m.locations = Array(101).fill(m.locations[0])),
  ]) {
    const m = clone();
    mutate(m);
    assert.throws(() => tour.validateManifest(m));
  }
});
test("read-only CLI audits existing records without opening migrations or changing the file", () => {
  const g = guild();
  event(g);
  closeDb();
  const before = fs.readFileSync(process.env.HARMONY_DB_PATH);
  const p = spawnSync(
    process.execPath,
    [
      "scripts/audit-concert-tour.cjs",
      "--database",
      process.env.HARMONY_DB_PATH,
      "--guild",
      g,
    ],
    { cwd: path.resolve(__dirname, ".."), encoding: "utf8" },
  );
  assert.equal(p.status, 0, p.stderr);
  const result = JSON.parse(p.stdout);
  assert.equal(
    result.entries.find(
      (e) => e.location.key === "chicago" && e.date === "2027-06-18",
    ).status,
    "reuse",
  );
  assert.deepEqual(fs.readFileSync(process.env.HARMONY_DB_PATH), before);
});
test("unlinked legacy reschedules are flagged instead of recreating their original dates", () => {
  const g = guild(),
    id = event(g, { eventDate: "2027-06-20" });
  const plan = tour.audit(g, chicago());
  assert.equal(plan.counts.blocked, 2);
  const result = approve(g, chicago());
  assert.equal(result.created, 0);
  assert.equal(tour.listConcerts(g)[0].id, id);
});
test("non-English city names and uppercase legacy classifications remain searchable", () => {
  const g = guild();
  event(g, {
    title: "RUN IT 서울",
    category: "Concert",
    eventDate: "2027-01-01",
    eventLocation: "Gocheok Sky Dome",
    timezone: "Asia/Seoul",
    eventTimezone: "Asia/Seoul",
  });
  assert.equal(tour.listConcerts(g, "Seoul").length, 1);
  assert.equal(tour.listConcerts(g, "South Korea").length, 1);
});
test("full date queries match calendar dates exactly rather than fragments of other dates", () => {
  const g = guild();
  approve(g);
  assert.equal(tour.listConcerts(g, "6/1/2027").length, 0);
  assert.equal(tour.listConcerts(g, "June 1, 2027").length, 0);
  assert.equal(tour.listConcerts(g, "Chicago 2027.06.19").length, 1);
  assert.equal(tour.listConcerts(g, "19/6/2027").length, 1);
  assert.equal(tour.listConcerts(g, "2027-02-30").length, 0);
});
