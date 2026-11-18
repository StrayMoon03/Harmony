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
const { requestText, workBudget } = require("../src/services/radarSources/common");

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
          id: String(++next), channelId: id, author: { id: "harmony" }, body, createdTimestamp: Date.now(),
          get embeds() { return message.body.embeds.map((embed) => embed.toJSON()); },
          edit: async (payload) => { message.body = payload; return message; },
        };
        sent.push(message);
        return message;
      },
      messages: { fetch: async (query) => {
        if (typeof query === "string" || query.message) {
          const messageId = query.message || query;
          const found = sent.find((message) => message.id === messageId && message.channelId === id && !message.deleted);
          if (!found) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
          return found;
        }
        return new Map(sent.filter((message) => !message.deleted && message.channelId === id &&
          (!query.before || Number(message.id) < Number(query.before))).slice().reverse().slice(0, query.limit)
          .map((message) => [message.id, message]));
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

test("Radar migration preserves populated Harmony settings, history and calendar records, idempotently", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  for (const table of ["radar_support", "radar_deliveries", "radar_observations", "radar_discoveries", "radar_sources", "radar_settings"]) db.exec("DROP TABLE " + table);
  db.exec(`
    INSERT INTO welcome_pass_settings(guild_id,role_id,channel_id,updated_at) VALUES('existing','stay','welcome','2026-11-18');
    INSERT INTO welcome_pass_bias_roles(guild_id,bias,role_id,updated_at) VALUES('existing','Seungmin','puppy','2026-11-18');
    INSERT INTO greeting_settings(guild_id,channel_id,entrance_message,exit_message,updated_at) VALUES('existing','welcome','Hello','Bye','2026-11-18');
    INSERT INTO member_count_activity(guild_id,week_key,observed_at,kind) VALUES('existing','2026-11-16','2026-11-18','join');
    INSERT INTO calendar_settings(guild_id,stray_kids_channel_id,updated_at) VALUES('existing','calendar','2026-11-18');
    INSERT INTO scheduled_events(guild_id,source_channel_id,destination_channel_id,title,link,event_date,created_by,created_at)
      VALUES('existing','source','calendar','Approved event','https://example.com/event','2026-12-01','owner','2026-11-18');
    INSERT INTO calendar_candidates(guild_id,title,source_url,dedupe_key,status,created_at,updated_at)
      VALUES('existing','Pending review','https://example.com/pending','url:pending','open','2026-11-18','2026-11-18');
  `);
  const tables = ["welcome_pass_settings", "welcome_pass_bias_roles", "greeting_settings", "member_count_activity", "calendar_settings", "scheduled_events", "calendar_candidates"];
  const before = tables.map((table) => db.prepare("SELECT * FROM " + table).all());
  migrate(db);
  migrate(db);
  assert.deepEqual(tables.map((table) => db.prepare("SELECT * FROM " + table).all()), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM radar_sources").get().n, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
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

test("canonical primary video identity correlates sources; generic names do not", () => {
  const first = source();
  store.ensureSources(first.guild_id, [{ key: "sony-info", accountId: "StrayKids", url: sony.url }]);
  const second = store.listSources(first.guild_id)[1];
  const value = item("one", { title: "Stray Kids Music Video", url: "https://www.youtube.com/watch?v=ABCDEFGHIJK", metadata: { links: ["https://youtu.be/ABCDEFGHIJK"] } });
  const a = ingest(first, value);
  const b = ingest(second, { ...value, id: "two", url: "https://youtu.be/ABCDEFGHIJK" });
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
  assert.ok(Date.parse(state.next_poll_at) >= Date.parse("2026-11-18T13:00:00.000Z"));
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
  const outcome = await discord.handoff(f.client, s.guild_id, discovery.id, "owner", details);
  const candidate = outcome.record;
  const again = await discord.handoff(f.client, s.guild_id, discovery.id, "owner", details);
  assert.equal(candidate.id, again.record.id);
  assert.equal(candidate.status, "open");
  assert.equal(candidate.proposed_event_at, "2026-12-01T11:00:00.000Z");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM scheduled_events WHERE guild_id=?").get(target.guild.id).n, 0);
  assert.equal(target.sent.length, 0);
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).calendar_candidate_id, candidate.id);
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, "Resolved");
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

function handoffFixture() {
  const s = source();
  const discovery = ingest(s).discovery;
  const f = fixture(s.guild_id);
  const target = fixture("target-" + s.guild_id);
  f.client.guilds.cache.set(target.guild.id, target.guild);
  store.setCalendarTarget(s.guild_id, target.guild.id);
  return { s, discovery, f, target };
}
function publishedEvent(guildId, url, date = "2026-12-02") {
  return Number(getDb().prepare(`INSERT INTO scheduled_events(guild_id,source_channel_id,destination_channel_id,title,link,
    event_date,event_timezone,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(guildId, "source", "calendar", "Canonical event", url, date, "Asia/Tokyo", "owner", "2026-11-18").lastInsertRowid);
}
test("handoff handles candidate:null and retains the existing published event's actual date", async () => {
  const { s, discovery, f, target } = handoffFixture();
  const id = publishedEvent(target.guild.id, store.supportingSources(discovery.id)[0].canonical_url);
  const outcome = await discord.handoff(f.client, s.guild_id, discovery.id, "owner", { date: "2026-12-20" });
  assert.equal(outcome.kind, "event");
  assert.equal(outcome.disposition, "existing_event");
  assert.equal(outcome.record.id, id);
  const saved = store.getDiscovery(s.guild_id, discovery.id);
  assert.equal(saved.calendar_candidate_id, null);
  assert.equal(saved.event_date, "2026-12-02");
  assert.equal(saved.event_timezone, "Asia/Tokyo");
  assert.equal(saved.review_state, "Resolved");
  assert.equal(calendar.listCalendarCandidates(target.guild.id).length, 0);
  assert.match(discord.payload(saved, store.supportingSources(discovery.id)).embeds[0].toJSON().fields.find((field) => field.name === "Calendar").value, /existing calendar event/);
});
test("handoff retains canonical existing candidate details instead of the submitted conflicting date", async () => {
  const { s, discovery, f, target } = handoffFixture();
  const { candidate } = calendar.createOrGetCalendarCandidate({ guildId: target.guild.id, title: discovery.title,
    sourceUrl: store.supportingSources(discovery.id)[0].canonical_url, proposedEventDate: "2026-12-01" });
  const outcome = await discord.handoff(f.client, s.guild_id, discovery.id, "owner", { date: "2026-12-20" });
  assert.equal(outcome.record.id, candidate.id);
  assert.equal(outcome.disposition, "existing_candidate");
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).event_date, "2026-12-01");
  assert.equal(calendar.getCalendarCandidate(target.guild.id, candidate.id).proposed_event_date, "2026-12-01");
});
test("concurrent/restarted handoff and changed target/details cannot rewrite the completed relationship", async () => {
  const { s, discovery, f, target } = handoffFixture();
  const outcomes = await Promise.all([
    discord.handoff(f.client, s.guild_id, discovery.id, "owner", { date: "2026-12-01" }),
    discord.handoff(f.client, s.guild_id, discovery.id, "owner", { date: "2026-12-20" }),
  ]);
  assert.equal(outcomes[0].record.id, outcomes[1].record.id);
  assert.equal(outcomes[0].disposition, "created_candidate");
  assert.equal(outcomes[1].replayed, true);
  closeDb();
  const replacement = fixture("replacement-calendar");
  f.client.guilds.cache.set(replacement.guild.id, replacement.guild);
  store.setCalendarTarget(s.guild_id, replacement.guild.id);
  const again = await discord.handoff(f.client, s.guild_id, discovery.id, "owner", { date: "2026-12-30" });
  assert.equal(again.guildId, target.guild.id);
  assert.equal(again.record.proposed_event_date, "2026-12-01");
  assert.equal(calendar.listCalendarCandidates(target.guild.id).length, 1);
  assert.equal(calendar.listCalendarCandidates(replacement.guild.id).length, 0);
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).event_date, "2026-12-01");
});
test("crash between calendar write and Radar save reuses the persisted target/input", async (t) => {
  const { s, discovery, f, target } = handoffFixture();
  const original = store.saveHandoff;
  const mock = t.mock.method(store, "saveHandoff", () => { throw new Error("simulated crash"); });
  await assert.rejects(discord.handoff(f.client, s.guild_id, discovery.id, "owner", { date: "2026-12-01" }), /simulated crash/);
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, "Needs Review");
  mock.mock.restore();
  assert.equal(store.saveHandoff, original);
  closeDb();
  const replacement = fixture("crash-replacement");
  f.client.guilds.cache.set(replacement.guild.id, replacement.guild);
  store.setCalendarTarget(s.guild_id, replacement.guild.id);
  const outcome = await discord.handoff(f.client, s.guild_id, discovery.id, "owner", { date: "2026-12-20" });
  assert.equal(outcome.guildId, target.guild.id);
  assert.equal(outcome.record.proposed_event_date, "2026-12-01");
  assert.equal(calendar.listCalendarCandidates(target.guild.id).length, 1);
  assert.equal(calendar.listCalendarCandidates(replacement.guild.id).length, 0);
});
test("stale/replayed modal and review buttons cannot reset a completed handoff", async () => {
  const { s, discovery, f, target } = handoffFixture();
  await discord.handoff(f.client, s.guild_id, discovery.id, "owner", { date: "2026-12-01" });
  let response;
  const interaction = {
    customId: "harmony-radar:handoff:" + discovery.id, guildId: s.guild_id, guild: f.guild,
    member: { permissions: { has: () => true } }, user: { id: "owner" }, channelId: "destination", client: f.client,
    isModalSubmit: () => true, deferReply: async () => {}, editReply: async (body) => { response = body; },
    fields: { getTextInputValue: (field) => field === "date" ? "2026-12-30" : "" },
  };
  await discord.handleRadarInteraction(interaction);
  assert.match(response, /calendar candidate/);
  assert.equal(calendar.listCalendarCandidates(target.guild.id).length, 1);
  store.setReviewState(s.guild_id, discovery.id, "Watching");
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, "Resolved");
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).event_date, "2026-12-01");
});
test("failed handoff does not resolve the discovery or fabricate missing dates", async () => {
  const { s, discovery, f } = handoffFixture();
  for (const details of [{}, { date: "2026-02-30" }, { date: "2026-12-01", time: "20:00" }]) {
    await assert.rejects(discord.handoff(f.client, s.guild_id, discovery.id, "owner", details));
  }
  const saved = store.getDiscovery(s.guild_id, discovery.id);
  assert.equal(saved.review_state, "Needs Review");
  assert.equal(saved.handoff_request, null);
  assert.equal(saved.handoff_result, null);
  assert.equal(saved.event_date, null);
});

test("incidental, promotional and uncertain YouTube links never correlate article discoveries", () => {
  const s = source("sony-info");
  const video = ingest(s, item("video", { title: "Music Video", url: "https://youtu.be/ABCDEFGHIJK" }));
  for (const title of ["Album packaging preview 公開", "Music Video announcement", "A linked example"]) {
    const article = ingest(s, item("article-" + title, { title, metadata: { links: ["https://youtu.be/ABCDEFGHIJK"] } }));
    assert.notEqual(article.discovery.id, video.discovery.id);
    assert.equal(article.discovery.correlation_key, null);
  }
});
test("packaging announcement linking an Ignored MV gets its own Needs Review discovery", () => {
  const s = source("sony-info");
  const video = ingest(s, item("mv", { title: "Music video", url: "https://youtu.be/ABCDEFGHIJK" }));
  store.setReviewState(s.guild_id, video.discovery.id, "Ignored");
  const packaging = ingest(s, item("packaging", { title: "Album packaging preview 公開", metadata: { links: ["https://youtu.be/ABCDEFGHIJK"] } }));
  assert.notEqual(video.discovery.id, packaging.discovery.id);
  assert.equal(packaging.discovery.review_state, "Needs Review");
  assert.equal(store.getDiscovery(s.guild_id, video.discovery.id).review_state, "Ignored");
});
test("changed primary video identity retires stale correlation and preserves old decisions/evidence", () => {
  const s = source();
  const first = ingest(s, item("same-source-item", { title: "Music video", url: "https://youtu.be/ABCDEFGHIJK" }));
  store.setReviewState(s.guild_id, first.discovery.id, "Ignored");
  const changed = ingest(s, item("same-source-item", { title: "Music video B", url: "https://youtu.be/LMNOPQRSTUV" }));
  assert.notEqual(first.discovery.id, changed.discovery.id);
  assert.equal(changed.discovery.correlation_key, "youtube:LMNOPQRSTUV");
  assert.equal(changed.discovery.review_state, "Needs Review");
  const old = store.getDiscovery(s.guild_id, first.discovery.id);
  assert.equal(old.correlation_key, null);
  assert.equal(old.review_state, "Ignored");
  assert.equal(store.supportingSources(old.id)[0].canonical_url, "https://youtu.be/ABCDEFGHIJK");
  assert.equal(store.supportingSources(old.id)[0].title, "Music video");
});
test("removing primary identity does not leave a correlation key or copy the old decision", () => {
  const s = source();
  const first = ingest(s, item("mutable", { title: "Music video", url: "https://youtu.be/ABCDEFGHIJK" }));
  store.setReviewState(s.guild_id, first.discovery.id, "Watching");
  const changed = ingest(s, item("mutable", { title: "Announcement", metadata: { links: ["https://youtu.be/ABCDEFGHIJK"] } }));
  assert.notEqual(first.discovery.id, changed.discovery.id);
  assert.equal(changed.discovery.correlation_key, null);
  assert.equal(changed.discovery.review_state, "Needs Review");
  assert.equal(store.getDiscovery(s.guild_id, first.discovery.id).correlation_key, null);
  assert.equal(store.getDiscovery(s.guild_id, first.discovery.id).review_state, "Watching");
  assert.equal(store.watchedItems(s.id).length, 0);
});
test("shared primary identity retains a key while another active observation still proves it", () => {
  const s = source();
  store.ensureSources(s.guild_id, [{ key: "other", accountId: "official", url: s.source_url }]);
  const other = store.listSources(s.guild_id)[1];
  const first = ingest(s, item("a", { title: "Music video", url: "https://youtu.be/ABCDEFGHIJK" }));
  assert.equal(ingest(other, item("b", { title: "Music video", url: "https://www.youtube.com/watch?v=ABCDEFGHIJK" })).discovery.id, first.discovery.id);
  ingest(s, item("a", { title: "Music video B", url: "https://youtu.be/LMNOPQRSTUV" }));
  assert.equal(store.getDiscovery(s.guild_id, first.discovery.id).correlation_key, "youtube:ABCDEFGHIJK");
});

const listingEntries = (entries) => entries.map(([id, date]) => '<a href="/notice/' + id + '"><span class="tit">Notice ' + id + '</span><span class="date">' + date + '</span></a>').join("");
const detailHtml = (text = "Details") => '<div class="boardView_cont"><div class="article-content">' + text + '</div></div>';
test("old watched JYPE notice is revisited directly; normal traversal never widens into intervening history", async () => {
  const s = source();
  const old = ingest(s, item("old-watched", { publishedAt: "2020-01-01" }));
  store.setReviewState(s.guild_id, old.discovery.id, "Watching");
  store.updateSource(s.id, { initialized_at: "2026-11-18T00:00:00Z", last_success_at: "2026-11-18T00:00:00Z", catchup_since: "2026-11-11T00:00:00Z" });
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.includes("PgIndex=1")) return http(listingEntries([["recent", "2026-11-18"]]));
    if (url.includes("PgIndex=2")) return http(listingEntries([["boundary", "2026-11-01"]]));
    assert.ok(url.endsWith("old-watched") || url.endsWith("recent"));
    return http(detailHtml("Updated watched detail"));
  };
  for (const time of ["12:00", "12:16"]) {
    await radar.pollSource(store.listSources(s.guild_id)[0], jype, { now: new Date("2026-11-18T" + time + ":00Z"), fetchImpl });
    closeDb();
  }
  assert.equal(requests.filter((url) => url.includes("old-watched")).length, 2);
  assert.equal(requests.length, 8);
  assert.equal(requests.some((url) => /PgIndex=[3-9]/.test(url)), false);
  assert.equal(store.getDiscovery(s.guild_id, old.discovery.id).review_state, "Watching");
  assert.match(store.getDiscovery(s.guild_id, old.discovery.id).summary, /Updated/);
});
test("JYPE budgets persist partial details and resume after restart without skipping backlog or new head", async () => {
  const s = source();
  let phase = 0;
  const requests = [];
  const entries = Array.from({ length: 40 }, (_, i) => ["item-" + i, "2026-11-18"]);
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.includes("PgIndex=1")) return http(listingEntries(phase ? [["new-head", "2026-11-18"], ...entries] : entries));
    if (url.includes("PgIndex=2")) return http(listingEntries([["old", "2026-11-01"]]));
    return http(detailHtml());
  };
  for (let cycle = 0; cycle < 7; cycle++) {
    const before = requests.length;
    await radar.pollSource(store.listSources(s.guild_id)[0], jype, {
      now: new Date(Date.parse("2026-11-18T12:00:00Z") + cycle * 16 * 60000), fetchImpl,
    });
    assert.ok(requests.length - before <= 12);
    if (cycle === 0) {
      assert.ok(store.listSources(s.guild_id)[0].traversal_state);
      assert.equal(store.listSources(s.guild_id)[0].initialized_at, null);
      assert.match(store.listSources(s.guild_id)[0].limitation, /resume/);
      phase = 1;
    }
    closeDb();
    if (store.listSources(s.guild_id)[0].initialized_at) break;
  }
  assert.equal(store.listDiscoveries(s.guild_id).length, 41);
  assert.equal(store.listSources(s.guild_id)[0].traversal_state, null);
  assert.ok(store.listSources(s.guild_id)[0].initialized_at);
  assert.equal(requests.filter((url) => url.endsWith("item-0")).length, 1);
});
test("Sony pagination resumes beyond the old cap with a bounded per-cycle budget", async () => {
  let offsetMax = 0;
  const fetchImpl = async (url) => {
    const offset = Number(url.match(/start\/(\d+)/)[1]);
    offsetMax = Math.max(offsetMax, offset);
    return http("callback(" + JSON.stringify({ total_count: 440, items: offset < 420
      ? Array.from({ length: 20 }, (_, i) => ({ id: offset + i + 1, title: "お知らせ", date: "2026.11.18" }))
      : [{ id: 999, title: "旧", date: "2026.11.01" }] }) + ")");
  };
  const s = { cursor: null };
  let total = 0;
  const knownIds = new Set();
  for (let cycle = 0; cycle < 12; cycle++) {
    const budget = workBudget({ requests: 4 });
    const result = await sony.fetchItems({ source: s, since: "2026-11-11T00:00:00Z", fetchImpl, budget, knownIds });
    total += result.items.length;
    result.items.forEach((item) => knownIds.add(item.id));
    s.traversal_state = result.continuation;
    if (!s.traversal_state) break;
  }
  assert.equal(total, 420);
  assert.equal(s.traversal_state, null);
  assert.equal(offsetMax, 420);
});
test("a budgeted/slow first source cannot block a healthy source or pending Discord delivery", async () => {
  const s = source("slow");
  ingest(s);
  const f = fixture(s.guild_id);
  let release;
  let healthy = false;
  const pending = new Promise((resolve) => { release = resolve; });
  const adapters = [
    { key: "slow", accountId: "official", url: s.source_url, fetchItems: async () => { await pending; return { items: [], continuation: '{"page":2}', limitation: "budget reached" }; } },
    { key: "healthy", accountId: "official", url: s.source_url, fetchItems: async () => { healthy = true; return { items: [item("healthy")] }; } },
  ];
  const job = radar.pollRadar(f.client, s.guild_id, { adapters });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(healthy, true);
  assert.equal(f.sent.length, 1);
  release();
  await job;
  assert.equal(f.sent.length, 2);
  assert.ok(store.listSources(s.guild_id)[0].traversal_state);
});
test("watched revisit failures do not discard healthy normal discovery and unsupported history is surfaced", async () => {
  const s = source("watch-test");
  const d = ingest(s).discovery;
  store.setReviewState(s.guild_id, d.id, "Watching");
  await radar.pollSource(s, { revisit: async () => { throw new Error("source_http_404"); }, fetchItems: async () => ({ items: [item("new")] }) });
  assert.equal(store.listDiscoveries(s.guild_id).length, 2);
  assert.match(store.listSources(s.guild_id)[0].limitation, /watched detail/);
  await radar.pollSource({ ...store.listSources(s.guild_id)[0], next_poll_at: null }, { fetchItems: async () => ({ items: [] }) });
  assert.match(store.listSources(s.guild_id)[0].limitation, /available listing/);
});
test("HTTP work budget bounds redirect requests and exhausted work makes no network request", async () => {
  let calls = 0;
  const budget = workBudget({ requests: 2 });
  await assert.rejects(requestText(jype.url, { budget, fetchImpl: async () => { calls++; return http(null, 302, { location: jype.url }); } }), /budget_exhausted/);
  assert.equal(calls, 2);
});

test("unchanged deleted card recovers on periodic existence check without requests on every pass", async () => {
  const s = source();
  const d = ingest(s).discovery;
  const f = fixture(s.guild_id);
  await discord.syncRadarChannel(f.client, s.guild_id);
  let fetches = 0;
  const original = f.destination.messages.fetch;
  f.destination.messages.fetch = async (query) => { fetches++; return original(query); };
  f.sent[0].deleted = true;
  await discord.syncRadarChannel(f.client, s.guild_id);
  assert.equal(fetches, 0);
  await discord.syncRadarChannel(f.client, s.guild_id, { now: new Date(Date.now() + 61 * 60000) });
  assert.equal(f.sent.length, 2);
  assert.notEqual(store.delivery(d.id, "destination").message_id, f.sent[0].id);
  assert.equal(store.getSettings(s.guild_id).delivery_error, null);
});
test("pending card recovery paginates and resumes history across restart without duplicate sends", async (t) => {
  const s = source();
  const d = ingest(s).discovery;
  const f = fixture(s.guild_id);
  const save = t.mock.method(store, "saveDelivery", () => { throw new Error("crash after send"); });
  await discord.syncRadarChannel(f.client, s.guild_id);
  save.mock.restore();
  const cardId = f.sent[0].id;
  for (let i = 0; i < 250; i++) await f.destination.send({ embeds: [], components: [] });
  const queries = [];
  const original = f.destination.messages.fetch;
  f.destination.messages.fetch = async (query) => { queries.push(query); return original(query); };
  await discord.syncRadarChannel(f.client, s.guild_id);
  assert.ok(store.delivery(d.id, "destination").recovery_before);
  assert.equal(queries.length, 2);
  assert.ok(queries[1].before);
  closeDb();
  await discord.syncRadarChannel(f.client, s.guild_id);
  assert.ok(queries[2].before);
  assert.equal(store.delivery(d.id, "destination").message_id, cardId);
  assert.equal(store.delivery(d.id, "destination").recovery_before, null);
  assert.equal(f.sent.length, 251);
});
test("deleted card replacement crash is recoverable and permission errors never trigger a blind replacement", async (t) => {
  const s = source();
  const d = ingest(s).discovery;
  const f = fixture(s.guild_id);
  await discord.syncRadarChannel(f.client, s.guild_id);
  f.sent[0].deleted = true;
  const save = t.mock.method(store, "saveDelivery", () => { throw new Error("crash"); });
  await discord.syncRadarChannel(f.client, s.guild_id, { now: new Date(Date.now() + 61 * 60000) });
  save.mock.restore();
  closeDb();
  await discord.syncRadarChannel(f.client, s.guild_id);
  assert.equal(f.sent.length, 2);
  assert.equal(store.delivery(d.id, "destination").message_id, f.sent[1].id);
  f.destination.messages.fetch = async () => { throw Object.assign(new Error("Missing access"), { code: 50013 }); };
  await discord.syncRadarChannel(f.client, s.guild_id, { now: new Date(Date.now() + 61 * 60000) });
  assert.equal(f.sent.length, 2);
  assert.match(store.getSettings(s.guild_id).delivery_error, /channel access/);
});
test("Retry-After greater than 24 hours is honored and blocks early subsequent polling", async () => {
  const s = source();
  const now = new Date("2026-11-18T12:00:00Z");
  const adapter = { fetchItems: async () => { throw Object.assign(new Error("source_http_429"), { retryAfterMs: 72 * 3600000 }); } };
  await radar.pollSource(s, adapter, { now });
  assert.ok(Date.parse(store.listSources(s.guild_id)[0].next_poll_at) >= Date.parse("2026-11-21T12:00:00.000Z"));
  const result = await radar.pollSource(store.listSources(s.guild_id)[0], { fetchItems: () => assert.fail("Not due") }, { now: new Date("2026-11-20T12:00:00Z") });
  assert.equal(result.skipped, true);
});
test("HTTP Retry-After numeric and HTTP-date values survive parsing without a 24-hour clamp", async () => {
  for (const delay of ["259200", new Date(Date.now() + 72 * 3600000).toUTCString()]) {
    await assert.rejects(requestText(jype.url, { fetchImpl: async () => http("limited", 429, { "retry-after": delay }) }), (error) => error.retryAfterMs > 71 * 3600000);
  }
});
test("unauthorized slash setup is rejected server-side before channel lookup, persistence or polling", async () => {
  const f = fixture("unauthorized-setup");
  let response;
  const interaction = {
    guild: f.guild, guildId: f.guild.id, member: { permissions: { has: () => false } }, user: { id: "ordinary" },
    options: { getSubcommand: () => assert.fail("Unauthorized actor must stop before setup"), getChannel: () => assert.fail("No channel lookup") },
    deferReply: async () => {}, editReply: async (body) => { response = body; },
  };
  await command.execute(interaction);
  assert.match(response, /Only server owners and authorized admins/);
  assert.equal(store.getSettings(f.guild.id), null);
  assert.equal(store.listSources(f.guild.id).length, 0);
  assert.equal(f.sent.length, 0);
});

test("resumed empty history followed by a send/save crash restarts recovery at the head", async (t) => {
  const s = source();
  const d = ingest(s).discovery;
  const f = fixture(s.guild_id);
  store.delivery(d.id, "destination");
  for (let i = 0; i < 250; i++) await f.destination.send({ embeds: [], components: [] });
  await discord.syncRadarChannel(f.client, s.guild_id);
  assert.ok(store.delivery(d.id, "destination").recovery_before);
  const save = t.mock.method(store, "saveDelivery", () => { throw new Error("crash after resumed send"); });
  await discord.syncRadarChannel(f.client, s.guild_id);
  save.mock.restore();
  assert.equal(f.sent.length, 251);
  assert.equal(store.delivery(d.id, "destination").recovery_before, null);
  closeDb();
  await discord.syncRadarChannel(f.client, s.guild_id);
  assert.equal(f.sent.length, 251);
  assert.equal(store.delivery(d.id, "destination").message_id, f.sent.at(-1).id);
});
test("periodic existence checks force a Discord request instead of trusting a cached message", async () => {
  const s = source();
  ingest(s);
  const f = fixture(s.guild_id);
  await discord.syncRadarChannel(f.client, s.guild_id);
  const original = f.destination.messages.fetch;
  let forced = false;
  f.destination.messages.fetch = async (query) => {
    if (query.message) { assert.equal(query.force, true); forced = true; }
    return original(query);
  };
  await discord.syncRadarChannel(f.client, s.guild_id, { now: new Date(Date.now() + 61 * 60000) });
  assert.equal(forced, true);
  assert.equal(f.sent.length, 1);
});
test("opening calendar modal does not resolve or create a candidate", async () => {
  const { s, discovery, f, target } = handoffFixture();
  let shown = false;
  await discord.handleRadarInteraction({
    customId: "harmony-radar:calendar:" + discovery.id, guildId: s.guild_id, guild: f.guild,
    member: { permissions: { has: () => true } }, user: { id: "owner" }, channelId: "destination", client: f.client,
    showModal: async () => { shown = true; },
  });
  assert.equal(shown, true);
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, "Needs Review");
  assert.equal(calendar.listCalendarCandidates(target.guild.id).length, 0);
});
test("Radar column upgrades preserve existing Radar records and work references", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  db.exec(`INSERT INTO radar_settings(guild_id,channel_id,updated_at) VALUES('legacy-radar','destination','2026-11-18');
    INSERT INTO radar_sources(guild_id,provider,account_id,source_url,authority,cursor) VALUES('legacy-radar','jype-notice','straykids','https://straykids.jype.com/notice','official','head');
    INSERT INTO radar_discoveries(guild_id,title,summary,review_state,created_at,updated_at) VALUES('legacy-radar','Existing discovery','Keep this','Ignored','2026-11-18','2026-11-18');
    INSERT INTO radar_deliveries(discovery_id,channel_id,message_id,token,started_at) VALUES(1,'destination','saved-message','token','2026-11-18');`);
  for (const [table, columns] of Object.entries({
    radar_sources: ["traversal_state", "watch_cursor"], radar_observations: ["correlation_key"],
    radar_support: ["active", "snapshot"], radar_discoveries: ["handoff_request", "handoff_result"],
    radar_deliveries: ["checked_at", "recovery_before"],
  })) for (const column of columns) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  migrate(db);
  migrate(db);
  assert.equal(db.prepare("SELECT cursor FROM radar_sources").get().cursor, "head");
  assert.equal(db.prepare("SELECT review_state FROM radar_discoveries").get().review_state, "Ignored");
  assert.equal(db.prepare("SELECT message_id FROM radar_deliveries").get().message_id, "saved-message");
  assert.equal(db.prepare("SELECT watch_cursor FROM radar_sources").get().watch_cursor, 0);
  assert.equal(db.prepare("SELECT recovery_before FROM radar_deliveries").get().recovery_before, null);
  db.close();
});

test("watched direct-detail rotation persists across restarts and reaches every old item", async () => {
  const s = source();
  for (let i = 0; i < 5; i++) {
    const d = ingest(s, item("watch-" + i, { publishedAt: "2020-01-01" })).discovery;
    store.setReviewState(s.guild_id, d.id, "Watching");
  }
  const revisits = [];
  const fetchImpl = async (url) => {
    if (url.includes("PgIndex")) return http(listingEntries([["old-boundary", "2020-01-01"]]));
    revisits.push(url.split("/").at(-1));
    return http(detailHtml());
  };
  for (let cycle = 0; cycle < 3; cycle++) {
    await radar.pollSource(store.listSources(s.guild_id)[0], jype, { fetchImpl,
      now: new Date(Date.parse("2026-11-18T12:00:00Z") + cycle * 16 * 60000) });
    closeDb();
  }
  assert.deepEqual(revisits, ["watch-0", "watch-1", "watch-2", "watch-3", "watch-4", "watch-0"]);
});
test("failed first source leaves a later healthy source and owner decisions intact", async () => {
  const s = source("bad-first");
  const d = ingest(s).discovery;
  store.setReviewState(s.guild_id, d.id, "Ignored");
  const results = await radar.pollRadar(null, s.guild_id, { adapters: [
    { key: "bad-first", accountId: "official", url: s.source_url, fetchItems: async () => { throw new Error("source_http_503"); } },
    { key: "good-second", accountId: "official", url: s.source_url, fetchItems: async () => ({ items: [item("healthy")] }) },
  ] });
  assert.equal(results.find((result) => result.source === "bad-first").ok, false);
  assert.equal(results.find((result) => result.source === "good-second").ok, true);
  assert.equal(store.listDiscoveries(s.guild_id).length, 2);
  assert.equal(store.getDiscovery(s.guild_id, d.id).review_state, "Ignored");
});
test("ignored article keeps its decision through alias changes, edits and extra supporting evidence", () => {
  const s = source("sony-info");
  const first = ingest(s, item("article", { aliases: ["https://example.com/article"] }));
  store.setReviewState(s.guild_id, first.discovery.id, "Ignored");
  closeDb();
  const edit = ingest(s, item("alias-id", { url: "https://example.com/article", title: "Edited announcement", metadata: { links: ["https://youtu.be/ABCDEFGHIJK"] } }));
  assert.equal(edit.discovery.id, first.discovery.id);
  assert.equal(edit.discovery.review_state, "Ignored");
  assert.equal(store.listDiscoveries(s.guild_id).length, 1);
});
test("authorized non-owner admin can configure Radar through slash setup", async (t) => {
  const f = fixture("non-owner-admin-setup");
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("youtube.com")) return http(atom([]));
    if (url.includes("sonymusic")) return http('callback({"items":[],"total_count":0})');
    return http(listingEntries([["boundary", "2020-01-01"]]));
  });
  const interaction = {
    guild: f.guild, guildId: f.guild.id, member: { permissions: { has: () => true } }, user: { id: "administrator" },
    client: f.client, options: { getSubcommand: () => "setup", getChannel: () => f.destination },
    deferReply: async () => {}, editReply: async () => {},
  };
  await command.execute(interaction);
  assert.equal(store.getSettings(f.guild.id).channel_id, "destination");
  assert.equal(store.listSources(f.guild.id).length, 3);
});
test("existence-check budget is fair across many cards and never hides newly discovered cards", async () => {
  const s = source();
  for (let i = 0; i < 85; i++) ingest(s, item("card-" + i));
  const f = fixture(s.guild_id);
  for (let cycle = 0; cycle < 5; cycle++) await discord.syncRadarChannel(f.client, s.guild_id);
  assert.equal(f.sent.length, 85);
  const now = Date.now();
  const future = new Date(now + 61 * 60000);
  let checks = 0;
  const original = f.destination.messages.fetch;
  f.destination.messages.fetch = async (query) => { if (query.message) checks++; return original(query); };
  for (let cycle = 0; cycle < 5; cycle++) {
    if (cycle === 1) ingest(s, item("new-priority"));
    await discord.syncRadarChannel(f.client, s.guild_id, { now: future });
    if (cycle === 1) assert.equal(f.sent.length, 86);
  }
  assert.equal(checks, 85);
  assert.equal(store.listDiscoveries(s.guild_id).filter((d) => Date.parse(store.delivery(d.id, "destination").checked_at) >= future.getTime()).length, 86);
});

test("malformed Retry-After values do not overflow the clock or cause immediate retries", async () => {
  for (const value of [NaN, Infinity, -1000]) {
    const s = source();
    await radar.pollSource(s, { fetchItems: async () => { throw Object.assign(new Error("source_http_503"), { retryAfterMs: value }); } }, { now: new Date("2026-11-18T12:00:00Z") });
    const next = Date.parse(store.listSources(s.guild_id)[0].next_poll_at);
    assert.ok(next >= Date.parse("2026-11-18T12:15:00Z"));
    assert.ok(next < Date.parse("2026-11-18T12:16:00Z"));
  }
});

test("a long resumed traversal cannot advance coverage past its starting head snapshot", async () => {
  const s = source();
  const first = "2026-11-18T12:00:00.000Z";
  const requests = [];
  const entries = Array.from({ length: 15 }, (_, i) => ["backlog-" + i, "2026-11-18"]);
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.includes("PgIndex=1")) return http(listingEntries(entries));
    if (url.includes("PgIndex=2")) return http(listingEntries([["old", "2026-11-01"]]));
    return http(detailHtml());
  };
  await radar.pollSource(s, jype, { now: new Date(first), fetchImpl });
  assert.ok(store.listSources(s.guild_id)[0].traversal_state);
  closeDb();
  await radar.pollSource(store.listSources(s.guild_id)[0], jype, { now: new Date("2026-11-22T12:00:00Z"), fetchImpl });
  assert.equal(store.listSources(s.guild_id)[0].traversal_state, null);
  assert.equal(store.listSources(s.guild_id)[0].last_success_at, first);
  let boundary;
  await radar.pollSource(store.listSources(s.guild_id)[0], { fetchItems: async ({ since }) => { boundary = since; return { items: [] }; } }, { now: new Date("2026-11-22T12:16:00Z") });
  assert.equal(boundary, "2026-11-16T12:00:00.000Z");
});

test("an exact former primary identity returning after an edit restores its own Ignored decision", () => {
  const s = source();
  const first = ingest(s, item("mutable-video", { title: "Music video A", url: "https://youtu.be/ABCDEFGHIJK" }));
  store.setReviewState(s.guild_id, first.discovery.id, "Ignored");
  const second = ingest(s, item("mutable-video", { title: "Music video B", url: "https://youtu.be/LMNOPQRSTUV" }));
  assert.equal(second.discovery.review_state, "Needs Review");
  const returned = ingest(s, item("mutable-video", { title: "Music video A", url: "https://youtu.be/ABCDEFGHIJK" }));
  assert.equal(returned.discovery.id, first.discovery.id);
  assert.equal(returned.discovery.review_state, "Ignored");
  assert.equal(returned.discovery.correlation_key, "youtube:ABCDEFGHIJK");
  assert.equal(store.getDiscovery(s.guild_id, second.discovery.id).correlation_key, null);
  assert.equal(store.listDiscoveries(s.guild_id).length, 2);
});
