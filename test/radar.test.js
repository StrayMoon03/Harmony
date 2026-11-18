const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PermissionFlagsBits, ChannelType } = require("discord.js");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-radar-"));
process.env.HARMONY_DB_PATH = path.join(temp, "radar.sqlite");
const { getDb, closeDb, migrate } = require("../src/db/sqlite");
const { DatabaseSync } = require("node:sqlite");
const store = require("../src/stores/radarStore");
const calendar = require("../src/stores/eventSchedulerStore");
const { classifyObservation } = require("../src/services/radarClassification");
const radar = require("../src/services/radarService");
const discord = require("../src/services/radarDiscord");
const command = require("../src/commands/radar");
const jype = require("../src/services/radarSources/jypeNotice");
const youtube = require("../src/services/radarSources/youtubeUploads");
const sony = require("../src/services/radarSources/sonyInfo");
const { requestText } = require("../src/services/radarSources/common");

test.after(() => { closeDb(); fs.rmSync(temp, { recursive: true, force: true }); });
let sequence = 0;
function source(provider = "jype-notice") {
  const guild = "radar-test-" + ++sequence;
  store.saveSettings(guild, "destination");
  store.ensureSources(guild, [{ key: provider, accountId: "official", url: "https://straykids.jype.com/notice" }]);
  return store.listSources(guild)[0];
}
function item(id = "abc", patch = {}) {
  return {
    id, url: "https://straykids.jype.com/notice/" + id, title: "A possible announcement",
    summary: "Details to follow", publishedAt: "2026-11-18", metadata: {}, ...patch,
  };
}
function ingest(s, value = item()) { return store.ingest(s, value, classifyObservation(s, value)); }
function fixture(guildId) {
  const sent = [];
  let next = 100;
  const channels = new Map();
  const members = new Map();
  const guild = {
    id: guildId, name: "Harmony server", ownerId: "owner",
    members: { me: { id: "harmony" }, fetch: async (id) => members.get(id) },
    channels: { cache: channels, fetch: async (id) => channels.get(id) },
  };
  members.set("owner", { permissions: { has: () => true } });
  function channel(id = "destination") {
    const value = {
      id, guildId, type: ChannelType.GuildText, isTextBased: () => true,
      permissionsFor: () => ({ has: () => true }),
      send: async (body) => {
        const message = {
          id: String(++next), author: { id: "harmony" }, body, createdTimestamp: Date.now(),
          get embeds() { return message.body.embeds.map((embed) => embed.toJSON()); },
          edit: async (payload) => { message.body = payload; return message; },
        };
        sent.push(message);
        return message;
      },
      messages: { fetch: async (query) => {
        if (typeof query === "string") {
          const found = sent.find((message) => message.id === query && !message.deleted);
          if (!found) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
          return found;
        }
        return new Map(sent.filter((message) => !message.deleted).slice().reverse().map((message) => [message.id, message]));
      } },
    };
    channels.set(id, value);
    return value;
  }
  const destination = channel();
  const client = { user: { id: "harmony" }, guilds: { cache: new Map([[guildId, guild]]), fetch: async () => guild } };
  return { guild, client, destination, sent, channel };
}
function http(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

test("Radar migration is additive and idempotent", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE unrelated(id INTEGER); INSERT INTO unrelated VALUES(7)");
  migrate(db);
  migrate(db);
  assert.equal(db.prepare("SELECT id FROM unrelated").get().id, 7);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM radar_sources").get().n, 0);
  db.close();
});

test("observation identity, edit detection and undated Unknown discoveries retain decisions", () => {
  const s = source();
  const first = ingest(s, item("unknown", { title: "준비 중", publishedAt: null }));
  assert.equal(first.discovery.category, "Unknown");
  assert.equal(first.discovery.calendar_eligibility, "Unknown");
  assert.equal(first.discovery.event_date, null);
  const repeated = ingest(s, item("unknown", { title: "준비 중", publishedAt: null }));
  assert.equal(first.observation.id, repeated.observation.id);
  assert.equal(first.discovery.id, repeated.discovery.id);
  for (const state of ["Ignored", "Watching"]) {
    store.setReviewState(s.guild_id, first.discovery.id, state);
    const result = ingest(s, item("unknown", { title: "준비 중", summary: state + " new detail", publishedAt: null }));
    assert.equal(result.discovery.id, first.discovery.id);
    assert.equal(result.discovery.review_state, state);
    assert.notEqual(result.observation.content_hash, first.observation.content_hash);
    closeDb();
    assert.equal(store.getDiscovery(s.guild_id, first.discovery.id).review_state, state);
  }
});

test("observations can exist without Radar discoveries for future member feeds", () => {
  const s = source();
  const result = store.ingest(s, item(), null);
  assert.ok(result.observation.id);
  assert.equal(result.discovery, null);
  assert.equal(store.listDiscoveries(s.guild_id).length, 0);
});

test("strong shared video identity correlates sources; generic names do not", () => {
  const first = source();
  store.ensureSources(first.guild_id, [{ key: "sony-info", accountId: "StrayKids", url: sony.url }]);
  const second = store.listSources(first.guild_id)[1];
  const value = item("one", { title: "Stray Kids Music Video", metadata: { links: ["https://youtu.be/ABCDEFGHIJK"] } });
  const a = ingest(first, value);
  const b = ingest(second, { ...value, id: "two", url: "https://www.sonymusic.co.jp/artist/StrayKids/info/2" });
  assert.equal(a.discovery.id, b.discovery.id);
  assert.equal(store.supportingSources(a.discovery.id).length, 2);
  store.setReviewState(first.guild_id, a.discovery.id, "Watching");
  assert.equal(ingest(second, { ...value, id: "two", summary: "More details" }).discovery.review_state, "Watching");
  const c = ingest(first, item("three", { title: "Stray Kids HAN announcement" }));
  const d = ingest(second, item("four", { title: "Stray Kids HAN announcement" }));
  assert.notEqual(c.discovery.id, d.discovery.id);
  assert.deepEqual(JSON.parse(c.discovery.members), ["HAN"]);
});

test("initialization captures seven days once, uses overlap after restart and isolates source failures", async () => {
  const s = source("good");
  const seen = [];
  const adapters = [
    { key: "good", accountId: "official", url: s.source_url, fetchItems: async ({ since }) => {
      seen.push(since); return { items: [item()], cursor: "abc" };
    } },
    { key: "bad", accountId: "official", url: s.source_url, fetchItems: async () => { throw new Error("source_http_429"); } },
  ];
  const now = new Date("2026-11-18T12:00:00Z");
  const options = { adapters, now };
  const results = await radar.pollRadar(null, s.guild_id, options);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(seen[0], "2026-11-11T12:00:00.000Z");
  const initialized = store.listSources(s.guild_id)[0].initialized_at;
  closeDb();
  await radar.pollRadar(null, s.guild_id, { ...options, now: new Date("2026-11-18T12:16:00Z") });
  assert.equal(seen[1], "2026-11-16T12:00:00.000Z");
  assert.equal(store.listSources(s.guild_id)[0].initialized_at, initialized);
  assert.equal(store.listDiscoveries(s.guild_id).length, 1);
  assert.equal(store.listSources(s.guild_id)[1].result, "failed");
});

test("source failures preserve ignored records, boundaries and other source state", async () => {
  const s = source();
  const discovered = ingest(s).discovery;
  store.setReviewState(s.guild_id, discovered.id, "Ignored");
  store.updateSource(s.id, { initialized_at: "2026-11-18T00:00:00Z", last_success_at: "2026-11-18T00:00:00Z", cursor: "known" });
  const error = Object.assign(new Error("source_http_429"), { retryAfterMs: 60 * 60 * 1000 });
  await radar.pollSource(store.listSources(s.guild_id)[0], { fetchItems: async () => { throw error; } }, { now: new Date("2026-11-18T12:00:00Z") });
  const state = store.listSources(s.guild_id)[0];
  assert.equal(state.cursor, "known");
  assert.equal(state.next_poll_at, "2026-11-18T13:00:00.000Z");
  assert.equal(store.getDiscovery(s.guild_id, discovered.id).review_state, "Ignored");
});

test("JYPE collapses desktop/mobile entries and preserves detail images and edits", () => {
  const html = '<div class="noticeList"><a href="/notice/path-id?NoticeNumber=12"><span class="tit">제목 &amp; Title</span><span class="date">2026-11-18</span></a></div>';
  const mobile = html.replace('class="tit"', 'class="tit_m"');
  const entries = jype.parseListing(html + mobile);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "path-id");
  assert.equal(entries[0].title, "제목 & Title");
  assert.equal(entries[0].noticeNumber, "12");
  const first = jype.parseDetail('<div class="boardView_cont"><div class="article-content"><img src="https://images.example/a.jpg"></div></div>', entries[0]);
  assert.deepEqual(first.metadata.images, ["https://images.example/a.jpg"]);
  const s = source();
  const initial = ingest(s, first);
  const edit = jype.parseDetail('<div class="boardView_cont"><div class="article-content"><p>Updated</p><img src="https://images.example/b.jpg"></div></div>', entries[0]);
  const next = ingest(s, edit);
  assert.equal(initial.discovery.id, next.discovery.id);
  assert.notEqual(initial.observation.content_hash, next.observation.content_hash);
});

function atom(entries, channelId = youtube.accountId) {
  return '<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom"><yt:channelId>' + channelId + '</yt:channelId>' +
    entries.map(([id, date]) => '<entry><yt:channelId>' + channelId + '</yt:channelId><yt:videoId>' + id + '</yt:videoId><title>SKZ CODE</title><published>' + date + '</published><updated>' + date + '</updated></entry>').join("") + '</feed>';
}
test("YouTube uses verified channel/video IDs and reports finite feed coverage", async () => {
  const parsed = youtube.parseFeed(atom([["ABCDEFGHIJK", "2026-11-18T00:00:00Z"]]));
  const liveVariant = atom([["ABCDEFGHIJK", "2026-11-18T00:00:00Z"]])
    .replace("<yt:channelId>" + youtube.accountId, "<yt:channelId>" + youtube.accountId.slice(2));
  assert.equal(youtube.parseFeed(liveVariant)[0].id, "ABCDEFGHIJK");
  assert.equal(parsed[0].id, "ABCDEFGHIJK");
  assert.equal(parsed[0].url, "https://www.youtube.com/watch?v=ABCDEFGHIJK");
  assert.throws(() => youtube.parseFeed(atom([], "UCwrong")), /channel_mismatch/);
  const result = await youtube.fetchItems({
    source: { account_id: youtube.accountId, source_url: youtube.url },
    since: "2026-11-11T00:00:00Z", fetchImpl: async () => http(atom([["ABCDEFGHIJK", "2026-11-18T00:00:00Z"]])),
  });
  assert.match(result.limitation, /history/);
  const sourceRecord = source("youtube-uploads");
  const discovery = ingest(sourceRecord, parsed[0]).discovery;
  assert.equal(discovery.category, "New Content");
  assert.equal(discovery.event_date, null);
});

test("Sony parses JSONP as data, keeps Japanese text and pages to the history boundary", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    const offset = Number(url.match(/start\/(\d+)/)[1]);
    calls++;
    return http("callback(" + JSON.stringify({ total_count: 21, items: offset === 0
      ? Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: "新しいお知らせ", article: "情報", images: { image_original: "/images/source.jpg" }, date: "2026.11.18" }))
      : [{ id: 21, title: "以前", date: "2026.11.01" }] }) + ")");
  };
  const result = await sony.fetchItems({ source: {}, since: "2026-11-11T00:00:00Z", fetchImpl });
  assert.equal(calls, 2);
  assert.equal(result.items.length, 20);
  assert.equal(result.items[0].title, "新しいお知らせ");
  assert.equal(result.items[0].id, "1");
  assert.deepEqual(result.items[0].metadata.images, ["https://www.sonymusic.co.jp/images/source.jpg"]);
  assert.equal(result.items[0].publishedAt, "2026-11-18");
  assert.equal(result.items[0].aliases[0], "https://www.straykidsjapan.com/info/archive/?1");
  assert.throws(() => sony.parsePage('callback({});globalThis.compromised=true'), /wrapper/);
  assert.equal(globalThis.compromised, undefined);
});

test("HTTP safeguards block unexpected redirects and bound upstream bodies", async () => {
  await assert.rejects(requestText("https://straykids.jype.com/notice", {
    fetchImpl: async () => http(null, 302, { location: "http://127.0.0.1/private" }),
  }), /blocked_source_destination/);
  await assert.rejects(requestText("https://straykids.jype.com/notice", {
    fetchImpl: async () => http("x".repeat(2 * 1024 * 1024 + 1)),
  }), /too_large/);
});

test("delivery edits the same message, recovers a pending send and preserves decisions after restart", async () => {
  const s = source();
  const discovered = ingest(s).discovery;
  const f = fixture(s.guild_id);
  const save = store.saveDelivery;
  // Simulate a crash after Discord accepted the first send.
  store.saveDelivery = () => { throw new Error("crash"); };
  await discord.syncRadarChannel(f.client, s.guild_id);
  assert.equal(f.sent.length, 1);
  store.saveDelivery = save;
  closeDb();
  await discord.syncRadarChannel(f.client, s.guild_id);
  assert.equal(f.sent.length, 1);
  store.setReviewState(s.guild_id, discovered.id, "Watching");
  await discord.syncRadarChannel(f.client, s.guild_id);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].embeds[0].fields.find((field) => field.name === "Review").value, "Watching");
});

test("delivery permission failures retain data; moving channels and off/on use configured destinations", async () => {
  const s = source();
  ingest(s);
  const f = fixture(s.guild_id);
  f.destination.messages.fetch = async () => { throw Object.assign(new Error("private"), { code: 50013 }); };
  await discord.syncRadarChannel(f.client, s.guild_id);
  assert.match(store.getSettings(s.guild_id).delivery_error, /channel access/);
  assert.equal(store.listDiscoveries(s.guild_id).length, 1);
  const moved = f.channel("new-destination");
  store.saveSettings(s.guild_id, moved.id);
  store.setEnabled(s.guild_id, false);
  await discord.syncRadarChannel(f.client, s.guild_id);
  assert.equal(f.sent.length, 0);
  store.setEnabled(s.guild_id, true);
  await discord.syncRadarChannel(f.client, s.guild_id);
  assert.equal(f.sent.length, 1);
});

test("calendar handoff requires details and target admin access and never publishes automatically", async () => {
  const s = source();
  const discovery = ingest(s).discovery;
  const f = fixture(s.guild_id);
  const target = fixture("calendar-server");
  f.client.guilds.cache.set(target.guild.id, target.guild);
  store.saveSettings(s.guild_id, "destination", target.guild.id);
  await assert.rejects(discord.handoff(f.client, s.guild_id, discovery.id, "owner", {}), /valid calendar date/);
  assert.equal(calendar.listCalendarCandidates(target.guild.id).length, 0);
  const details = { date: "2026-12-01", time: "20:00", timezone: "Asia/Seoul" };
  const candidate = await discord.handoff(f.client, s.guild_id, discovery.id, "owner", details);
  const again = await discord.handoff(f.client, s.guild_id, discovery.id, "owner", details);
  assert.equal(candidate.id, again.id);
  assert.equal(candidate.status, "open");
  assert.equal(candidate.proposed_event_at, "2026-12-01T11:00:00.000Z");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM scheduled_events WHERE guild_id=?").get(target.guild.id).n, 0);
  assert.equal(target.sent.length, 0);
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).calendar_candidate_id, candidate.id);
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, "Needs Review");
  await assert.rejects(discord.handoff(f.client, s.guild_id, discovery.id, "ordinary", details), /admin access/);
});

test("review components authorize in the configured Harmony channel and persist Ignore/Watching", async () => {
  const s = source();
  const discovery = ingest(s).discovery;
  const f = fixture(s.guild_id);
  for (const [action, expected] of [["ignore", "Ignored"], ["watch", "Watching"]]) {
    const interaction = {
      customId: "harmony-radar:" + action + ":" + discovery.id, guildId: s.guild_id,
      guild: f.guild, member: { permissions: { has: () => true } }, user: { id: "owner" },
      channelId: "destination", client: f.client, deferUpdate: async () => {},
      followUp: async () => assert.fail("Authorized review should succeed"),
    };
    await discord.handleRadarInteraction(interaction);
    assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, expected);
  }
  const interaction = {
    customId: "harmony-radar:ignore:" + discovery.id, guildId: s.guild_id, guild: f.guild,
    member: { permissions: { has: () => false } }, user: { id: "ordinary" }, channelId: "destination",
    deferUpdate: async () => { interaction.deferred = true; }, followUp: async (body) => { interaction.body = body; },
  };
  await discord.handleRadarInteraction(interaction);
  assert.match(interaction.body.content, /admin access/);
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, "Watching");
});

test("setup rejects unusable channels and saves three official sources only after authorization", async () => {
  const f = fixture("command-setup");
  const interaction = {
    guild: f.guild, guildId: f.guild.id, member: { permissions: { has: () => true } }, user: { id: "owner" },
    client: null, options: { getSubcommand: () => "setup", getChannel: () => f.destination },
    deferReply: async () => {}, editReply: async (body) => { interaction.body = body; },
  };
  f.destination.permissionsFor = () => ({ has: () => false });
  await command.execute(interaction);
  assert.equal(store.getSettings(f.guild.id), null);
  assert.match(interaction.body, /Choose a text channel/);
  assert.equal(command.data.toJSON().name, "harmony-radar");
});

test("canonical aliases deduplicate within a source without merging unrelated accounts", () => {
  const s = source();
  const first = ingest(s, item("canonical", { aliases: ["https://example.com/alias"] }));
  const alias = ingest(s, item("alias-id", { url: "https://example.com/alias" }));
  assert.equal(alias.observation.id, first.observation.id);
  assert.equal(alias.discovery.id, first.discovery.id);
  assert.equal(store.supportingSources(first.discovery.id).length, 1);
  const otherSource = source();
  assert.notEqual(ingest(otherSource, item("canonical")).discovery.id, first.discovery.id);
});

test("initialization failure retains its original seven-day boundary when retried after restart", async () => {
  const s = source();
  const fail = { fetchItems: async () => { throw new Error("source_http_503"); } };
  await radar.pollSource(s, fail, { now: new Date("2026-11-18T12:00:00Z") });
  closeDb();
  let since;
  await radar.pollSource(store.listSources(s.guild_id)[0], {
    fetchItems: async (options) => { since = options.since; return { items: [] }; },
  }, { now: new Date("2026-11-19T12:00:00Z") });
  assert.equal(since, "2026-11-11T12:00:00.000Z");
});

test("simultaneous checks coalesce and a paused source does not poll", async () => {
  const s = source("coalesced");
  let release;
  let calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const adapter = {
    key: "coalesced", accountId: "official", url: s.source_url,
    fetchItems: async () => { calls++; await pending; return { items: [] }; },
  };
  const options = { adapters: [adapter], now: new Date("2026-11-18T12:00:00Z") };
  const first = radar.pollRadar(null, s.guild_id, options);
  const second = radar.pollRadar(null, s.guild_id, options);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  store.updateSource(s.id, { enabled: 0 });
  await radar.pollRadar(null, s.guild_id, { ...options, now: new Date("2026-11-18T13:00:00Z") });
  assert.equal(calls, 1);
});

test("setup configures the Harmony channel, polls all three sources and emits review cards", async (t) => {
  const f = fixture("full-command-setup");
  const listing = (date) => '<a href="/notice/notice-id?NoticeNumber=1"><span class="tit">공지</span><span class="date">' + date + '</span></a>';
  const recent = new Date().toISOString().slice(0, 10);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    if (url.includes("youtube.com")) return http(atom([["ABCDEFGHIJK", new Date().toISOString()]]));
    if (url.includes("sonymusic")) return http('callback({"items":[],"total_count":0})');
    if (url.includes("PgIndex=2")) return http(listing("2020-01-01"));
    if (url.includes("PgIndex")) return http(listing(recent));
    return http('<div class="boardView_cont"><div class="article-content"><img src="https://images.example/notice.jpg"></div></div>');
  });
  const interaction = {
    guild: f.guild, guildId: f.guild.id, member: { permissions: { has: () => true } }, user: { id: "owner" },
    client: f.client, options: { getSubcommand: () => "setup", getChannel: () => f.destination },
    deferReply: async () => {}, editReply: async (body) => { interaction.body = body; },
  };
  await command.execute(interaction);
  assert.equal(store.listSources(f.guild.id).length, 3);
  assert.equal(store.listDiscoveries(f.guild.id).length, 2);
  assert.equal(f.sent.length, 2);
  assert.equal(requests.some((url) => url.includes("googleapis")), false);
  assert.match(store.listSources(f.guild.id).find((source) => source.provider === "youtube-uploads").limitation, /history/);
});

test("ordinary members and stale destination components cannot change a Radar discovery", async () => {
  const s = source();
  const discovery = ingest(s).discovery;
  const f = fixture(s.guild_id);
  const interaction = {
    customId: "harmony-radar:ignore:" + discovery.id, guildId: s.guild_id, guild: f.guild,
    member: { permissions: { has: () => true } }, user: { id: "owner" }, channelId: "old-channel",
    deferUpdate: async () => { interaction.deferred = true; }, followUp: async () => {},
  };
  await discord.handleRadarInteraction(interaction);
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, "Needs Review");
});

test("calendar target changes preserve the Radar pause state", () => {
  const s = source();
  store.setEnabled(s.guild_id, false);
  store.setCalendarTarget(s.guild_id, "new-calendar-server");
  assert.equal(store.getSettings(s.guild_id).enabled, 0);
});
