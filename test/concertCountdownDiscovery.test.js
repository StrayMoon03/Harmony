const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
process.env.HARMONY_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "concert-discovery-")), "test.sqlite");
const discovery = require("../src/services/concertCountdownDiscovery");
const tour = require("../src/services/concertTourCalendar");
const { getDb } = require("../src/db/sqlite");
const now = new Date("2026-11-24T12:00Z");
const chicago = tour.bundled.locations.find(l => l.key === "chicago");
const announcement = { id: "123", title: "Stray Kids RUN IT concert additional Chicago date", summary: "Soldier Field concert 2027-06-20", url: "https://straykids.jype.com/notice/123" };
test("real Radar source readers perform bounded HTTP checks and return provenance without database or public writes", async () => {
  const requests = [];
  const result = await discovery.search("real-readers", { now, locations: [chicago], fetchImpl: async url => {
    requests.push(String(url));
    if (url.includes("sonymusic")) return new Response('callback(' + JSON.stringify({ total_count: 1, items: [{ id: 42, title: "Stray Kids world tour concert", article: "Chicago Soldier Field 2027-06-20", date: "2026.11.24" }] }) + ');');
    if (url.includes("/notice/123")) return new Response('<div class="noticeDetail">Chicago Soldier Field concert 2027-06-20</div>');
    return new Response('<a href="/notice/123"><span class="tit">Stray Kids RUN IT Chicago concert</span><span class="date">' + (url.includes("PgIndex=2") ? "2026-11-01" : "2026-11-24") + '</span></a>');
  } });
  assert.ok(requests.some(u => u.includes("straykids.jype.com/notice")));
  assert.ok(requests.some(u => u.includes("sonymusic.co.jp")));
  assert.equal(result.items.length, 2);
  assert.ok(result.sources.every(s => s.ok));
  assert.deepEqual(result.items[0].dates, ["2027-06-20"]);
  assert.ok(result.items.every(i => tour.officialSource(i.url)));
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM scheduled_events").get().n, 0);
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM radar_discoveries").get().n, 0);
});
test("discovery review manifests only import on approval, reuse existing records and preserve source provenance", async () => {
  const item = { ...announcement, ...discovery.suggestions(announcement, [chicago]) };
  const input = discovery.manifest(item, { city: "Chicago", country: "United States", venue: "Soldier Field", timezone: "America/Chicago", dates: "2027-06-20, 2027-06-20" }, now);
  const plan = tour.audit("import-review", input);
  assert.equal(plan.counts.missing, 1);
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM scheduled_events WHERE guild_id='import-review'").get().n, 0);
  const first = tour.importConfirmed("import-review", input, plan.fingerprint, "owner");
  const second = tour.importConfirmed("import-review", input, tour.audit("import-review", input).fingerprint, "owner");
  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.deepEqual(first.eventIds, second.eventIds);
  assert.equal(tour.listConcerts("import-review")[0].link, announcement.url);
  assert.equal(getDb().prepare("SELECT approved_by FROM concert_tour_events WHERE guild_id='import-review'").get().approved_by, "owner");
});
test("source failures and partial listings are visible and cannot be reported as a complete no-new-dates search", async () => {
  const seen = [];
  const sources = [
    { key: "partial", fetchItems: async ({ source }) => { seen.push(source.traversal_state); return { items: [announcement], continuation: "checkpoint", limitation: "saved traversal" }; } },
    { key: "failure", fetchItems: async () => { throw Error("request failed"); } },
  ];
  const first = await discovery.search("partial", { now, sources, locations: [chicago] });
  assert.match(first.sources[0].limitation, /Partial listings/);
  assert.equal(first.sources[1].ok, false);
  await discovery.search("partial", { now: new Date(now.getTime() + 61000), sources, locations: [chicago] });
  assert.deepEqual(seen, [null, "checkpoint"]);
});
test("concurrent searches share work and manual searches respect local and provider retry delays", async () => {
  let calls = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  const source = { key: "slow", fetchItems: async () => { calls++; await ready; return { items: [] }; } };
  const first = discovery.search("parallel", { now, sources: [source], locations: [] });
  const second = discovery.search("parallel", { now, sources: [source], locations: [] });
  release();
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
  await assert.rejects(discovery.search("parallel", { now, sources: [source], locations: [] }), /checked recently/);
  const limited = { key: "limited", fetchItems: async () => { throw Object.assign(Error("limited"), { retryAfterMs: 120000 }); } };
  await discovery.search("limited", { now, sources: [limited], locations: [] });
  await assert.rejects(discovery.search("limited", { now: new Date(now.getTime() + 61000), sources: [limited], locations: [] }), /checked recently/);
});
test("multi-location announcements and invalid dates are not guessed; untrusted URLs and invalid imports are rejected", async () => {
  const london = tour.bundled.locations.find(l => l.key === "london");
  const guess = discovery.suggestions({ ...announcement, summary: "Chicago and London concerts 2027-06-20 2027-06-30 2027-02-31" }, [chicago, london]);
  assert.equal(guess.location, null);
  assert.deepEqual(guess.dates, []);
  const invalid = discovery.suggestions({ ...announcement, summary: "Chicago 2027-02-31" }, [chicago]);
  assert.deepEqual(invalid.dates, []);
  const bad = { ...announcement, url: "https://example.test/tour" };
  const result = await discovery.search("untrusted", { now, sources: [{ key: "test", fetchItems: async () => ({ items: [bad] }) }], locations: [chicago] });
  assert.equal(result.items.length, 0);
  assert.throws(() => discovery.manifest(bad, {}, now), /supported official/);
  assert.throws(() => discovery.manifest(announcement, { city: "Chicago", country: "USA", venue: "Soldier Field", timezone: "Not/AZone", dates: "2027-06-20" }, now));
});
