const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/stores/eventSchedulerStore");
const adapter = require("../src/services/calendarDiscoverySources/strayKidsJypeScheduleAdapter");
const { runDiscovery, windowFor } = require("../src/services/calendarDiscoveryService");
const calendarCandidateCommand = require("../src/commands/calendarCandidate");

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
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
  const result = await adapter.fetchRecords({ startDate: "2026-10-14", endDate: "2027-02-11", fetchImpl: async (url, options) => { requested = { url, options }; return response({ schedules: [] }); } });
  assert.match(result.url, /straykids\.jype\.com\/api\/schedules\?groupId=10/);
  assert.equal(result.records.length, 0);
  assert.match(requested.url, /startDate=2026-10-14/);
  assert.equal(requested.options.headers.accept, "application/json");
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
  assert.match(reply.content, /Only Harmony calendar administrators/);
});
