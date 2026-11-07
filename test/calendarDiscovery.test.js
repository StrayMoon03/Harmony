const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const store = require("../src/stores/eventSchedulerStore");
const adapter = require("../src/services/calendarDiscoverySources/strayKidsJypeScheduleAdapter");
const comebackGuide = require("../src/services/calendarDiscoverySources/strayKidsComebackGuideIcsAdapter");
const icsAdapter = require("../src/services/calendarDiscoverySources/googleCalendarIcsAdapter");
const { runDiscovery, windowFor, fetchWithLimits, formatDiscoverySummary } = require("../src/services/calendarDiscoveryService");
const calendarCandidateCommand = require("../src/commands/calendarCandidate");

const liveDecemberPayload = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/jype-december-2026-live-response.json"), "utf8"));
const expectedEventShapes = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/jype-december-2026-expected-event-shapes.json"), "utf8"));
const comebackGuideIcs = fs.readFileSync(path.join(__dirname, "fixtures/skz-comeback-guide-december-2026.ics"), "utf8");
const emptyCalendarIcs = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:Asia/Seoul\r\nEND:VCALENDAR\r\n";

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Map(), json: async () => payload, text: async () => emptyCalendarIcs };
}

function multiSourceFetch(jypePayload, { ics = emptyCalendarIcs, failJyp = false, failGuide = false } = {}) {
  return async (url) => {
    if (String(url).includes("calendar.google.com/calendar/ical")) {
      return failGuide ? response(null, 503) : { ok: true, status: 200, headers: new Map(), text: async () => ics };
    }
    return failJyp ? response(null, 503) : response(jypePayload);
  };
}

test("JYP adapter includes only official event/show/release records and preserves date semantics", () => {
  const event = adapter.normalizeRecord({ id: 101, title: "Fan Meeting", category: "EVENT", isAllDay: false, scheduledAt: "2026-11-07T01:00:00.000Z", scheduledDate: "2026-11-06", timezone: "America/New_York" });
  assert.equal(event.candidate.discoveryKey, "jype-straykids-schedule:10:101");
  assert.equal(event.candidate.proposedEventAt, "2026-11-07T01:00:00.000Z");
  assert.equal(event.candidate.proposedEventDate, "2026-11-06");
  assert.equal(JSON.parse(event.candidate.sourceMetadata).timezone, "America/New_York");
  assert.equal(adapter.normalizeRecord({ id: 102, title: "Anniversary", category: "ANNIVERSARY", isAllDay: true, scheduledDate: "2026-11-01" }).reason, "excluded-category");
  assert.equal(adapter.normalizeRecord({ id: 103, title: "Other", category: "ETC", isAllDay: true, scheduledDate: "2026-11-01" }).reason, "excluded-category");
  const allDay = adapter.normalizeRecord({ id: 104, title: "Release", category: "RELEASE", isAllDay: true, scheduledDate: "2026-11-02", scheduledAt: "2026-11-02T00:00:00Z" });
  assert.equal(allDay.candidate.proposedEventAt, null);
  assert.equal(allDay.candidate.proposedEventDate, "2026-11-02");
  assert.equal(adapter.normalizeRecord({ id: 105, title: "Unknown", category: "SHOW", isAllDay: false }).reason, "missing-date");
});

test("discovery window protects first run and uses correction lookback afterward", () => {
  const now = new Date("2026-10-14T12:00:00.000Z");
  assert.deepEqual(windowFor(null, now), { startDate: "2026-10-14", endDate: "2027-02-11" });
  assert.deepEqual(windowFor({ initialized: 1 }, now), { startDate: "2026-10-12", endDate: "2027-02-11" });
});

test("automatic discovery is idempotent, updates open candidates, and never reopens dismissal", async () => {
  const guildId = `discovery-${Date.now()}`;
  const channel = { isTextBased: () => true, send: async () => ({ id: "notice" }) };
  const guild = { id: guildId, channels: { cache: new Map([["control", channel]]), fetch: async () => channel } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  store.setReconciliationChannel(guildId, "control");
  const records = [
    { id: 201, title: "Show A", category: "SHOW", isAllDay: true, scheduledDate: "2026-10-20" },
    { id: 202, title: "Release B", category: "RELEASE", isAllDay: true, scheduledDate: "2026-10-21" },
    { id: 203, title: "Old", category: "EVENT", isAllDay: true, scheduledDate: "2025-01-01" },
  ];
  const fetchImpl = async () => response({ data: records });
  const first = await runDiscovery(client, { now: new Date("2026-10-14T12:00:00Z"), fetchImpl });
  assert.equal(first.results[0].newCount, 2);
  assert.equal(store.listCalendarCandidates(guildId).length, 2);
  assert.equal(store.listEvents(guildId).length, 0);
  const repeat = await runDiscovery(client, { now: new Date("2026-10-14T13:00:00Z"), fetchImpl });
  assert.equal(repeat.results[0].newCount, 0);
  assert.equal(store.listCalendarCandidates(guildId).length, 2);
  const candidate = store.listCalendarCandidates(guildId).find((item) => item.discovery_key.endsWith(":201"));
  store.decideCalendarCandidate(guildId, candidate.id, "dismissed", "admin");
  const changed = await runDiscovery(client, { now: new Date("2026-10-14T14:00:00Z"), fetchImpl: async () => response({ data: [{ ...records[0], title: "Show A (rescheduled)" }, records[1]] }) });
  assert.equal(changed.results[0].newCount, 0);
  assert.equal(store.getCalendarCandidate(guildId, candidate.id).status, "dismissed");
  assert.equal(store.getCalendarCandidate(guildId, candidate.id).title, "Show A");
});

test("source endpoint uses the official structured contract", async () => {
  let requested;
  const result = await adapter.fetchRecords({ startDate: "2026-10-14", endDate: "2027-02-11", fetchImpl: async (url, options) => {
    requested = { url, options };
    return response({ schedules: [{ id: "9260", title: "Stray Kids World Tour <RUN IT> FUKUOKA", category: "EVENT", isAllDay: true, scheduledAt: "2026-10-24T00:00:00+09:00", scheduledDate: "2026-10-24" }] });
  } });
  assert.match(result.url, /straykids\.jype\.com\/api\/schedules\?groupId=10/);
  assert.equal(result.records[0].id, "9260");
  assert.match(requested.url, /startDate=2026-10-14T00%3A00%3A00\.000Z/);
  assert.match(requested.url, /endDate=2027-02-11T23%3A59%3A59\.999Z/);
  assert.equal(requested.options.headers.accept, "application/json");
});

test("current live JYP December response shape normalizes all three returned Stray Kids records", async () => {
  const result = await adapter.fetchRecords({ startDate: "2026-12-01", endDate: "2026-12-31", fetchImpl: async () => response(liveDecemberPayload) });
  assert.equal(result.records.length, 3);
  assert.deepEqual(result.records.map((record) => record.category), ["EVENT", "EVENT", "EVENT"]);
  for (const record of result.records) assert.ok(adapter.normalizeRecord(record).candidate);
  assert.deepEqual(result.records.map((record) => record.scheduledDate), ["2026-12-05", "2026-12-12", "2026-12-13"]);
});

test("public Comeback Guide iCalendar feed shape preserves UID, URLs, local time, and multi-day date range", async () => {
  let request;
  const result = await comebackGuide.fetchRecords({
    startDate: "2026-12-01", endDate: "2026-12-31",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, headers: new Map(), text: async () => comebackGuideIcs };
    },
  });
  assert.equal(result.records.length, 5);
  assert.equal(request.options.headers.accept, "text/calendar");
  assert.equal(request.options.headers.cookie, undefined);
  const normalized = result.records.map((record) => comebackGuide.normalizeRecord(record, { retrievedAt: "2026-11-07T00:00:00Z" }));
  const fns = normalized.find((item) => item.candidate?.title.includes("FNS")).candidate;
  assert.equal(fns.proposedEventDate, "2026-12-02");
  assert.equal(fns.proposedEventAt, "2026-12-02T09:30:00.000Z");
  assert.equal(fns.proposedEventTimezone, "Asia/Seoul");
  assert.equal(fns.sourceProvenance[0].sourceId, "36ofp8beefffqrdi7q4aosj49s@google.com");
  assert.equal(fns.sourceProvenance[0].retrievedAt, "2026-11-07T00:00:00Z");
  assert.equal(fns.sourceProvenance[0].sourceName, "SKZ Comeback Guide");
  const hk = normalized.find((item) => item.candidate?.title.includes("Hong Kong")).candidate;
  assert.equal(hk.proposedEventTimezone, "Asia/Hong_Kong");
  assert.equal(hk.proposedEventAt, "2026-12-05T09:00:00.000Z");
  const taipei = normalized.find((item) => item.candidate?.title.includes("Taipei")).candidate;
  assert.equal(taipei.proposedEventTimezone, "Asia/Taipei");
  const sbs = normalized.find((item) => item.candidate?.title === "SBS Gayo Daejeon").candidate;
  assert.equal(sbs.proposedEventDate, "2026-12-24");
  assert.equal(sbs.proposedEventEndDate, "2026-12-25");
  assert.equal(sbs.proposedEventTimezone, "Asia/Seoul");
  assert.match(sbs.sourceUrl, /^https:\/\/news\.sbs\.co\.kr\//);
});

test("multi-source discovery deduplicates JYP and Comeback Guide coverage and retains provenance", async () => {
  const guildId = `discovery-multisource-${Date.now()}`;
  const guild = { id: guildId, channels: { cache: new Map(), fetch: async () => null } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  const result = await runDiscovery(client, {
    now: new Date("2026-11-07T12:00:00Z"),
    fetchImpl: multiSourceFetch(liveDecemberPayload, { ics: comebackGuideIcs }),
  });
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map((item) => item.sourceName), ["JYP Official", "SKZ Comeback Guide"]);
  assert.equal(result.results[0].newCount, 3);
  assert.equal(result.results[1].newCount, 2);
  assert.equal(result.results[1].crossSourceMatches, 3);
  const candidates = store.listCalendarCandidates(guildId);
  assert.equal(candidates.length, 5);
  assert.equal(store.listEvents(guildId).length, 0);
  const musicBank = candidates.find((candidate) => candidate.proposed_event_date === "2026-12-13");
  assert.ok(musicBank);
  assert.equal(musicBank.proposed_event_at, null, "explicit JYP all-day metadata is not overwritten by a secondary timed listing");
  assert.equal(JSON.parse(musicBank.source_metadata).allDay, true);
  assert.match(JSON.parse(musicBank.source_metadata).location, /Tokyo/);
  const provenance = JSON.parse(musicBank.source_provenance);
  assert.deepEqual(provenance.map((item) => item.sourceName).sort(), ["JYP Official", "SKZ Comeback Guide"]);
  assert.ok(provenance.every((item) => item.sourceId && item.sourceUrl && item.originalTitle && item.sourceDateTime && item.retrievedAt));
  const summary = formatDiscoverySummary(result.results);
  assert.match(summary, /JYP Official — 3 fetched/);
  assert.match(summary, /SKZ Comeback Guide — 5 fetched/);
  assert.match(summary, /cross-source matches 3/);
  assert.match(summary, /No calendar events were created automatically/);
});

test("secondary-source-only events are reviewable when JYP fails", async () => {
  const guildId = `discovery-secondary-only-${Date.now()}`;
  const guild = { id: guildId, channels: { cache: new Map(), fetch: async () => null } };
  const result = await runDiscovery({ guilds: { cache: new Map([[guildId, guild]]) } }, {
    now: new Date("2026-11-07T12:00:00Z"),
    fetchImpl: multiSourceFetch({ schedules: [] }, { ics: comebackGuideIcs, failJyp: true }),
  });
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[1].ok, true);
  assert.equal(result.results[1].newCount, 5);
  assert.equal(store.listCalendarCandidates(guildId).length, 5);
  assert.equal(store.listEvents(guildId).length, 0);
  assert.match(formatDiscoverySummary(result.results), /JYP Official — unavailable/);
});

test("source identity matching is conservative across dates, separate days, and ambiguous same-day events", () => {
  const guildId = `discovery-conservative-${Date.now()}`;
  const create = (title, date, provider, id, at = null) => store.createOrGetCalendarCandidate({
    guildId, title, proposedEventDate: date, proposedEventAt: at,
    sourceUrl: `https://example.test/${provider}/${id}`, sourceType: "automatic_discovery",
    sourceProvider: provider, discoveryKey: `${provider}:${id}`,
    sourceProvenance: [{ provider, sourceName: provider, sourceId: id, sourceUrl: `https://example.test/${provider}/${id}`, originalTitle: title, sourceDateTime: at || date, retrievedAt: "2026-11-07T00:00:00Z" }],
  });
  create("Stray Kids World Tour <RUN IT> HONG KONG", "2026-12-05", "jype-straykids-schedule", "hk");
  const hk = create("RUN IT World Tour - Hong Kong, China", "2026-12-05", "stray-kids-comeback-guide", "hk-ics");
  assert.equal(hk.duplicate, true);
  assert.equal(hk.crossSourceMatch, true);
  create("Fuji TV 2026 FNS Music Festival Broadcast", "2026-12-02", "source-a", "fns-a");
  const fns = create("2026 FNS Kayo Festival First Night", "2026-12-02", "source-b", "fns-b");
  assert.equal(fns.duplicate, true);
  assert.equal(fns.crossSourceMatch, true);
  const taipei = create("RUN IT World Tour - Taipei, Taiwan", "2026-12-12", "stray-kids-comeback-guide", "taipei");
  assert.equal(taipei.duplicate, false);
  create("SBS Gayo Daejeon Day 1", "2026-12-24", "source-a", "sbs1");
  const day2 = create("SBS Gayo Daejeon Day 2", "2026-12-25", "source-b", "sbs2");
  assert.equal(day2.duplicate, false);
  create("Music Bank Global Festival", "2026-12-13", "source-a", "mb1", "2026-12-13T08:00:00Z");
  const ambiguous = create("Music Bank Awards Afterparty", "2026-12-13", "source-b", "mb2", "2026-12-13T08:00:00Z");
  assert.equal(ambiguous.duplicate, false);
  const hkCandidate = store.listCalendarCandidates(guildId).find((item) => item.proposed_event_date === "2026-12-05");
  assert.equal(JSON.parse(hkCandidate.source_provenance).length, 2);
});

test("three providers retain provenance on one candidate and decided candidates are never recreated or reopened", () => {
  const guildId = `discovery-provenance-decisions-${Date.now()}`;
  const make = (provider, id, title = "2026 Music Bank Global Festival in Japan") => store.createOrGetCalendarCandidate({
    guildId, title, proposedEventDate: "2026-12-13", proposedEventAt: "2026-12-13T08:00:00.000Z",
    sourceUrl: `https://example.test/${provider}/${id}`, sourceType: "automatic_discovery", sourceProvider: provider,
    discoveryKey: `${provider}:${id}`, sourceProvenance: [{ provider, sourceName: provider, sourceId: id, sourceUrl: `https://example.test/${provider}/${id}`, originalTitle: title, sourceDateTime: "2026-12-13T08:00:00Z", retrievedAt: "2026-11-07T00:00:00Z" }],
  });
  const first = make("jype-straykids-schedule", "mb");
  assert.equal(first.duplicate, false);
  const second = make("stray-kids-comeback-guide", "mb2", "MUSIC BANK GLOBAL FESTIVAL IN JAPAN 2026 x Stray Kids");
  assert.equal(second.duplicate, true);
  assert.equal(second.crossSourceMatch, true);
  const third = make("trusted-third-calendar", "mb3", "2026 Music Bank Global Festival in Tokyo");
  assert.equal(third.duplicate, true);
  assert.equal(third.crossSourceMatch, true);
  assert.equal(store.listCalendarCandidates(guildId).length, 1);
  assert.equal(JSON.parse(store.getCalendarCandidate(guildId, first.candidate.id).source_provenance).length, 3);
  store.decideCalendarCandidate(guildId, first.candidate.id, "dismissed", "admin");
  const rediscovered = make("new-public-calendar", "mb4", "2026 Music Bank Global Festival in Tokyo");
  assert.equal(rediscovered.duplicate, true);
  assert.equal(rediscovered.candidate.status, "dismissed");
  assert.equal(store.listCalendarCandidates(guildId).length, 1);
  const linkedGuild = `${guildId}-linked`;
  const linked = store.createOrGetCalendarCandidate({
    guildId: linkedGuild, title: "SBS Gayo Daejeon", proposedEventDate: "2026-12-24",
    sourceUrl: "https://example.test/sbs", sourceType: "automatic_discovery", sourceProvider: "skz-comeback-guide",
    discoveryKey: "skz-comeback-guide:sbs", sourceProvenance: [{ provider: "skz-comeback-guide", sourceName: "Guide", sourceId: "sbs", sourceUrl: "https://example.test/sbs", originalTitle: "SBS Gayo Daejeon", sourceDateTime: "2026-12-24", retrievedAt: "2026-11-07T00:00:00Z" }],
  });
  store.decideCalendarCandidate(linkedGuild, linked.candidate.id, "linked", "admin", null, 456);
  const linkedAgain = store.createOrGetCalendarCandidate({
    guildId: linkedGuild, title: "SBS Gayo Daejeon", proposedEventDate: "2026-12-24",
    sourceUrl: "https://example.test/sbs-new", sourceType: "automatic_discovery", sourceProvider: "second-guide",
    discoveryKey: "second-guide:sbs", sourceProvenance: [{ provider: "second-guide", sourceName: "Second Guide", sourceId: "sbs2", sourceUrl: "https://example.test/sbs-new", originalTitle: "SBS Gayo Daejeon", sourceDateTime: "2026-12-24", retrievedAt: "2026-11-07T00:00:00Z" }],
  });
  assert.equal(linkedAgain.duplicate, true);
  assert.equal(linkedAgain.candidate.status, "linked");
  assert.equal(linkedAgain.candidate.calendar_event_id, 456);
  assert.equal(store.listCalendarCandidates(linkedGuild).length, 1);
});

test("a source failure is isolated while successful source events are still processed", async () => {
  const guildId = `discovery-failure-isolation-${Date.now()}`;
  const guild = { id: guildId, channels: { cache: new Map(), fetch: async () => null } };
  const result = await runDiscovery({ guilds: { cache: new Map([[guildId, guild]]) } }, {
    now: new Date("2026-11-07T12:00:00Z"),
    fetchImpl: multiSourceFetch({ schedules: [] }, { ics: comebackGuideIcs, failGuide: true }),
  });
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.equal(store.listCalendarCandidates(guildId).length, 0);
  assert.match(formatDiscoverySummary(result.results), /SKZ Comeback Guide — unavailable/);
});

test("JYP-shaped fixture for reported December events reaches review candidates when returned by source", async () => {
  const guildId = `discovery-jype-december-examples-${Date.now()}`;
  const guild = { id: guildId, channels: { cache: new Map(), fetch: async () => null } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  const result = await runDiscovery(client, {
    now: new Date("2026-11-06T12:00:00Z"),
    fetchImpl: async () => response({ schedules: expectedEventShapes }),
  });
  const outcome = result.results[0];
  assert.equal(outcome.fetched, 7);
  assert.equal(outcome.normalized, 7);
  assert.equal(outcome.newCount, 7);
  assert.equal(outcome.skipped, 0);
  const candidates = store.listCalendarCandidates(guildId);
  assert.equal(candidates.length, 7);
  assert.equal(store.listEvents(guildId).length, 0);
  const byTitle = new Map(candidates.map((candidate) => [candidate.title, candidate]));
  for (const record of expectedEventShapes) {
    const candidate = byTitle.get(record.title);
    assert.ok(candidate, record.title);
    assert.equal(candidate.proposed_event_date, record.scheduledDate);
    assert.equal(candidate.discovery_key, `${adapter.SOURCE_PROVIDER}:10:${record.id}`);
    if (record.isAllDay) assert.equal(candidate.proposed_event_at, null);
    else assert.equal(candidate.proposed_event_at, record.scheduledAt);
  }
  const broadcast = byTitle.get("Fuji TV 2026 FNS Music Festival Broadcast");
  assert.equal(JSON.parse(broadcast.source_metadata).explicitOffset, "+09:00");
  assert.equal(formatDiscoverySummary(result.results).includes("normalized 7"), true);
});

test("discovery diagnostics classify normalization, date-window skips, duplicates, and prior admin decisions", async () => {
  const guildId = `discovery-diagnostics-${Date.now()}`;
  const guild = { id: guildId, channels: { cache: new Map(), fetch: async () => null } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  store.createOrGetCalendarCandidate({
    guildId,
    title: "Previously reviewed event",
    proposedEventDate: "2026-11-10",
    sourceUrl: "https://straykids.jype.com/schedule?scheduleId=known-1",
    sourceProvider: adapter.SOURCE_PROVIDER,
    discoveryKey: `${adapter.SOURCE_PROVIDER}:10:known-1`,
    sourceType: "automatic_discovery",
  });
  const records = [
    { id: "known-1", title: "Previously reviewed event", category: "EVENT", isAllDay: true, scheduledDate: "2026-11-10" },
    { id: "old-1", title: "Old event", category: "SHOW", isAllDay: true, scheduledDate: "2025-11-10" },
    { id: "anniversary-1", title: "Birthday", category: "ANNIVERSARY", isAllDay: true, scheduledDate: "2026-11-11" },
    { title: "Missing ID", category: "EVENT", isAllDay: true, scheduledDate: "2026-11-12" },
  ];
  const result = await runDiscovery(client, { now: new Date("2026-11-06T12:00:00Z"), fetchImpl: async () => response({ schedules: records }) });
  const outcome = result.results[0];
  assert.equal(outcome.fetched, 4);
  assert.equal(outcome.normalized, 2);
  assert.equal(outcome.duplicate, 1);
  assert.equal(outcome.skipped, 3);
  assert.equal(outcome.adminDecisionPreserved, 0);
  assert.deepEqual(outcome.categories, { EVENT: 2, SHOW: 1, ANNIVERSARY: 1 });
  assert.deepEqual(outcome.skipReasons, { "outside-discovery-window": 1, "normalization:excluded-category": 1, "normalization:missing-id": 1 });
  assert.match(formatDiscoverySummary([outcome]), /outside-discovery-window 1/);

  const candidate = store.listCalendarCandidates(guildId)[0];
  store.decideCalendarCandidate(guildId, candidate.id, "dismissed", "admin");
  const afterDecision = await runDiscovery(client, { now: new Date("2026-11-06T13:00:00Z"), fetchImpl: async () => response({ schedules: [records[0]] }) });
  assert.equal(afterDecision.results[0].adminDecisionPreserved, 1);
  assert.equal(store.getCalendarCandidate(guildId, candidate.id).status, "dismissed");
});

test("unrecognized JYP response envelope fails as a source-shape diagnostic, not an empty successful run", async () => {
  await assert.rejects(
    () => adapter.fetchRecords({ startDate: "2026-12-01", endDate: "2026-12-31", fetchImpl: async () => response({ scheduleList: [{ id: "x" }] }) }),
    (error) => error.code === "unexpected-response-shape"
  );
});

test("source-shape API failures produce safe actionable Check Now diagnostics", async () => {
  const guildId = `discovery-source-shape-error-${Date.now()}`;
  const guild = { id: guildId, channels: { cache: new Map(), fetch: async () => null } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  const result = await runDiscovery(client, {
    now: new Date("2026-11-06T12:00:00Z"),
    fetchImpl: async () => response({ scheduleList: [{ id: "private-payload-marker" }] }),
  });
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].failureReason, "response-shape-unknown");
  assert.equal("error" in result.results[0], false);
  const summary = formatDiscoverySummary(result.results);
  assert.match(summary, /source failures 1 \(response-shape-unknown 1\)/);
  assert.doesNotMatch(summary, /private-payload-marker|scheduleList/);
});

test("HTTP wrapper exposes upstream validators to source adapters", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ etag: '"source-v1"', "last-modified": "Wed, 14 Oct 2026 11:00:00 GMT" }),
    text: async () => JSON.stringify({ schedules: [] }),
  });
  try {
    const wrapped = await fetchWithLimits("https://example.test/source");
    assert.equal(wrapped.headers.get("etag"), '"source-v1"');
    assert.equal(wrapped.headers.get("last-modified"), "Wed, 14 Oct 2026 11:00:00 GMT");
  } finally {
    global.fetch = originalFetch;
  }
});

test("wrapped 200 persists validators and wrapped 304 preserves them", async () => {
  const guildId = `discovery-validators-${Date.now()}`;
  const guild = { id: guildId, channels: { cache: new Map(), fetch: async () => null } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  const originalFetch = global.fetch;
  let call = 0;
  global.fetch = async () => {
    call += 1;
    if (call === 1) return {
      ok: true,
      status: 200,
      headers: new Headers({ etag: '"source-v1"', "last-modified": "Wed, 14 Oct 2026 11:00:00 GMT" }),
      json: async () => ({ schedules: [] }),
      text: async () => JSON.stringify({ schedules: [] }),
    };
    return { ok: false, status: 304, headers: new Headers({ etag: '"source-v1"' }), text: async () => "" };
  };
  try {
    await runDiscovery(client, { now: new Date("2026-10-14T12:00:00Z"), fetchImpl: fetchWithLimits });
    const first = store.getCalendarDiscoveryState(guildId, adapter.SOURCE_KEY);
    store.saveCalendarDiscoveryState(guildId, adapter.SOURCE_KEY, { lastSourceHash: "known-source-hash" });
    const before = store.getCalendarDiscoveryState(guildId, adapter.SOURCE_KEY);
    const second = await runDiscovery(client, { now: new Date("2026-10-14T13:00:00Z"), fetchImpl: fetchWithLimits });
    const after = store.getCalendarDiscoveryState(guildId, adapter.SOURCE_KEY);
    assert.equal(first.etag, '"source-v1"');
    assert.equal(first.last_modified, "Wed, 14 Oct 2026 11:00:00 GMT");
    assert.equal(second.results[0].notModified, true);
    assert.equal(after.last_source_hash, before.last_source_hash);
    assert.equal(after.etag, before.etag);
    assert.equal(after.last_modified, before.last_modified);
    assert.notEqual(after.last_success_at, before.last_success_at);
  } finally {
    global.fetch = originalFetch;
  }
});

test("HTTP 304 preserves discovery state and never becomes an empty schedule", async () => {
  const guildId = `discovery-304-${Date.now()}`;
  const guild = { id: guildId, channels: { cache: new Map(), fetch: async () => null } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  const before = store.saveCalendarDiscoveryState(guildId, adapter.SOURCE_KEY, {
    initialized: 1,
    lastSuccessAt: "2026-10-14T11:00:00.000Z",
    lastSourceHash: "known-source-hash",
    etag: '"known-etag"',
    lastModified: "Wed, 14 Oct 2026 11:00:00 GMT",
  });
  const existing = store.createOrGetCalendarCandidate({
    guildId,
    title: "Existing official show",
    proposedEventDate: "2026-10-20",
    sourceUrl: "https://straykids.jype.com/schedule?scheduleId=999",
    sourceProvider: adapter.SOURCE_PROVIDER,
    discoveryKey: `${adapter.SOURCE_PROVIDER}:10:999`,
    sourceType: "automatic_discovery",
  });
  const result = await runDiscovery(client, {
    now: new Date("2026-10-14T12:00:00Z"),
    fetchImpl: async () => response(null, 304),
  });
  const after = store.getCalendarDiscoveryState(guildId, adapter.SOURCE_KEY);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].notModified, true);
  assert.equal(store.listCalendarCandidates(guildId).length, 1);
  assert.equal(store.getCalendarCandidate(guildId, existing.candidate.id).title, "Existing official show");
  assert.equal(after.last_source_hash, before.last_source_hash);
  assert.equal(after.etag, before.etag);
  assert.equal(after.last_modified, before.last_modified);
  assert.notEqual(after.last_success_at, before.last_success_at);
});

test("manual discover is admin-only and the command is ephemeral", async () => {
  const options = calendarCandidateCommand.data.toJSON().options;
  assert.ok(options.some((item) => item.name === "discover"));
  let reply;
  await calendarCandidateCommand.execute({
    options: { getSubcommand: () => "discover" },
    memberPermissions: { has: () => false },
    reply: async (payload) => { reply = payload; },
  });
  assert.equal(reply.flags, 64);
  assert.match(reply.content, /Only server admins with Manage Server or Administrator permission/);
});

test("automatic discovery defaults off, persists when enabled, and manual checks still run", async () => {
  const guildId = `discovery-toggle-${Date.now()}`;
  const guild = { id: guildId, channels: { cache: new Map(), fetch: async () => null } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  const fetchImpl = async () => response({ schedules: [] });
  const automaticOff = await runDiscovery(client, { automatic: true, fetchImpl });
  assert.equal(automaticOff.results.length, 0);
  store.setCalendarDiscoveryEnabled(guildId, true);
  const automaticOn = await runDiscovery(client, { automatic: true, fetchImpl });
  assert.equal(automaticOn.results.length, 2);
  assert.equal(store.getCalendarDiscoveryConfig(guildId).enabled, 1);
  store.saveCalendarDiscoveryState(guildId, "future-official-source", { lastError: "test state" });
  assert.equal(store.isCalendarDiscoveryEnabled(guildId), true);
  const manual = await runDiscovery(client, { automatic: false, fetchImpl });
  assert.equal(manual.results.length, 2);
});
