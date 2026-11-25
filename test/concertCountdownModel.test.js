const test = require("node:test");
const assert = require("node:assert/strict");
const {
  localDate,
  dayIndex,
  concertState,
  buildCountdown,
} = require("../src/services/concertCountdownModel");
test("venue midnight and DST", () => {
  assert.equal(
    localDate(new Date("2027-03-14T05:59:00Z"), "America/Chicago"),
    "2027-03-13",
  );
  assert.equal(
    localDate(new Date("2027-03-14T06:00:00Z"), "America/Chicago"),
    "2027-03-14",
  );
  assert.equal(dayIndex("2027-03-15") - dayIndex("2027-03-14"), 1);
});
test("states and invalid dates", () => {
  assert.equal(concertState("2027-01-01", "2026-12-30").days, 2);
  assert.equal(concertState("2027-01-01", "2026-12-31").state, "tomorrow");
  assert.equal(concertState("2027-01-01", "2027-01-01").state, "today");
  assert.equal(concertState("2027-01-01", "2027-01-02").state, "completed");
  assert.throws(() => dayIndex("2027-02-30"));
});
test("approved selected guild events only, independent dates", () => {
  const config = {
    guildId: "1",
    eventIds: [1, 2, 3, 4],
    timezone: "America/Chicago",
    city: "Chicago",
    venue: "Soldier Field",
  };
  const event = (id, date, more = {}) => ({
    id,
    guild_id: "1",
    calendar_type: "stray_kids",
    category: "concert",
    all_day: 1,
    event_date: date,
    ...more,
  });
  const m = buildCountdown(
    config,
    [
      event(1, "2027-06-18"),
      event(2, "2027-06-19"),
      event(3, "2027-06-20", { cancelled_at: "yes" }),
      event(4, "2027-06-21", { guild_id: "2" }),
    ],
    new Date("2027-06-19T12:00Z"),
  );
  assert.deepEqual(
    m.panels.map((p) => p.state),
    ["completed", "today"],
  );
});
const { validateConfig } = require("../src/services/concertCountdownModel");
test("single date, leap day and year boundary use calendar days", () => {
  assert.equal(concertState("2028-03-01", "2028-02-28").days, 2);
  assert.equal(concertState("2028-03-01", "2028-02-29").state, "tomorrow");
  assert.equal(concertState("2028-01-01", "2027-12-31").state, "tomorrow");
  assert.throws(() => dayIndex("2027-02-29"));
  assert.throws(() => dayIndex("bad"));
});
test("DST fall back does not repeat or skip a countdown day", () => {
  const tz = "America/Chicago";
  assert.equal(localDate(new Date("2027-11-07T06:59Z"), tz), "2027-11-07");
  assert.equal(localDate(new Date("2027-11-07T07:01Z"), tz), "2027-11-07");
  assert.equal(
    concertState("2027-11-08", localDate(new Date("2027-11-07T07:01Z"), tz))
      .state,
    "tomorrow",
  );
  assert.throws(() => localDate(new Date(), "Mars/Chicago"));
  assert.throws(() => localDate(new Date(), ""));
});
test("timed concerts use venue-local dates; calendar reschedules and cancellations are authoritative", () => {
  const c = {
    guildId: "g",
    city: "Chicago",
    country: "USA",
    venue: "Soldier Field",
    timezone: "America/Chicago",
    eventIds: [7],
  };
  const e = {
    id: 7,
    guild_id: "g",
    calendar_type: "stray_kids",
    category: "concert",
    event_at: "2027-06-19T01:00Z",
    all_day: 0,
  };
  assert.equal(
    buildCountdown(c, [e], new Date("2027-06-17T12:00Z")).panels[0].date,
    "2027-06-18",
  );
  assert.equal(
    buildCountdown(
      c,
      [{ ...e, event_at: "2027-06-20T01:00Z" }],
      new Date("2027-06-17T12:00Z"),
    ).panels[0].days,
    2,
  );
  assert.equal(
    buildCountdown(c, [{ ...e, cancelled_at: "yes" }]).panels.length,
    0,
  );
  assert.equal(
    buildCountdown(c, [{ ...e, calendar_type: "community" }]).panels.length,
    0,
  );
  assert.equal(
    buildCountdown(c, [{ ...e, guild_id: "other" }]).panels.length,
    0,
  );
  assert.throws(() => validateConfig(c, []), /no longer approved/);
  assert.equal(buildCountdown(c, []).panels.length, 0);
});
test("configuration validation requires valid selected events and venue details", () => {
  const c = {
    guildId: "g",
    city: "City",
    venue: "Venue",
    country: "Country",
    timezone: "UTC",
    eventIds: [1],
  };
  const e = {
    id: 1,
    guild_id: "g",
    calendar_type: "stray_kids",
    category: "concert",
    all_day: 1,
    event_date: "2028-02-29",
  };
  assert.equal(validateConfig(c, [e]), c);
  assert.throws(() => validateConfig({ ...c, city: "" }, [e]), /city/);
  assert.throws(() => validateConfig({ ...c, eventIds: [] }, [e]), /Select/);
  assert.throws(
    () => validateConfig({ ...c, eventIds: Array(13).fill(1) }, [e]),
    /Select/,
  );
  assert.throws(
    () => validateConfig(c, [{ ...e, event_date: "2027-02-29" }]),
    /Invalid concert date/,
  );
});

test('next midnight follows IANA local boundaries across DST and international zones', () => {
  const { nextMidnight } = require('../src/services/concertCountdownModel');
  for (const [tz, start, expected, hours] of [
    ['America/Toronto', '2027-03-14T05:00:00Z', '2027-03-15T04:00:00.000Z', 23],
    ['America/Toronto', '2027-11-07T04:00:00Z', '2027-11-08T05:00:00.000Z', 25],
    ['America/Vancouver', '2027-03-14T07:00:00Z', '2027-03-15T07:00:00.000Z', 24],
    ['America/Vancouver', '2027-11-07T07:00:00Z', '2027-11-08T07:00:00.000Z', 24],
    ['Asia/Tokyo', '2027-06-18T15:00:00Z', '2027-06-19T15:00:00.000Z', 24],
    ['Europe/London', '2027-03-28T00:00:00Z', '2027-03-28T23:00:00.000Z', 23],
  ]) {
    const at = new Date(start), next = nextMidnight(at, tz);
    assert.equal(next.toISOString(), expected, tz);
    assert.equal((next - at) / 3600000, hours, tz);
    assert.notEqual(localDate(new Date(next - 1), tz), localDate(next, tz));
  }
  assert.equal(nextMidnight(new Date('2027-06-19T03:59:59.999Z'), 'America/Toronto').toISOString(), '2027-06-19T04:00:00.000Z');
});
