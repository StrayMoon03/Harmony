const test = require("node:test");
process.env.HARMONY_RADAR_TRANSLATION_PROVIDER = "disabled";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-radar-presentation-"));
process.env.HARMONY_DB_PATH = path.join(temp, "isolated.sqlite");
const { getDb, closeDb, migrate } = require("../src/db/sqlite");
const store = require("../src/stores/radarStore");
const translationStore = require("../src/stores/radarTranslationStore");
const presentation = require("../src/services/radarPresentation");
const translation = require("../src/services/radarTranslationService");
const discord = require("../src/services/radarDiscord");
const radar = require("../src/services/radarService");
const { classifyObservation } = require("../src/services/radarClassification");
const sony = require("../src/services/radarSources/sonyInfo");
const jype = require("../src/services/radarSources/jypeNotice");
const youtube = require("../src/services/radarSources/youtubeUploads");
let sequence = 0;
function source(provider = "sony-info", guildId) {
  guildId ||= "presentation-" + ++sequence;
  store.saveSettings(guildId, "radar-channel");
  store.ensureSources(guildId, [{ key: provider, accountId: "official", url: sony.url }]);
  return store.listSources(guildId).find((s) => s.provider === provider);
}
function item(patch = {}) {
  return { id: "item", title: "New album release announced", summary: "The new album will be released worldwide. Complete details are available in the original announcement.",
    url: "https://www.sonymusic.co.jp/artist/StrayKids/info/123", publishedAt: "2026-11-18", metadata: { links: [], images: [] }, ...patch };
}
function ingest(s, value = item(), classification) {
  return store.ingest(s, value, classification || classifyObservation(s, value), "2026-11-19T04:37:56.872Z");
}
function cachedSource(d) { return presentation.primarySource(d, store.supportingSources(d.id)); }
function fixture(guildId) {
  const sent = [];
  const channel = { id: "radar-channel", isTextBased: () => true, messages: { fetch: async (query) => {
    if (query.message) {
      const existing = sent.find((m) => m.id === query.message && !m.deleted);
      if (!existing) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
      return existing;
    }
    return new Map(sent.filter((m) => !m.deleted).slice().reverse().slice(0, query.limit).map((m) => [m.id, m]));
  } }, send: async (body) => {
    const message = { id: String(sent.length + 100), body, author: { id: "harmony" }, createdTimestamp: Date.now(),
      get embeds() { return this.body.embeds.map((embed) => embed.toJSON()); }, edit: async (newBody) => { message.body = newBody; return message; } };
    sent.push(message);
    return message;
  } };
  const guild = { id: guildId, ownerId: "owner", channels: { cache: new Map([[channel.id, channel]]) } };
  return { sent, channel, client: { user: { id: "harmony" }, guilds: { cache: new Map([[guild.id, guild]]) } } };
}
const tick = () => new Promise(setImmediate);
function workerFor(result, options = {}) {
  let calls = 0;
  const service = translation.createTranslationService({
    provider: () => ({ id: "azure", available: true, translate: async (input, signal) => { calls++; return typeof result === "function" ? result(input, signal) : result; } }),
    detector: async () => "jpn", ...options,
  });
  return { ...service, calls: () => calls };
}
const translated = { title: "HAN announces a new solo song", summary: "The solo song will be released on November 20. More information is available in the original announcement.", language: "ja" };
test.after(async () => { await translation.whenIdle(); await tick(); closeDb(); fs.rmSync(temp, { recursive: true, force: true }); });

test("long Sony article is fully persisted but its Discord card is concise and links to the original", () => {
  const s = source();
  const article = 'HANの新曲が配信リリース決定！ 11月20日にリリースします。<p>Track List</p>' +
    '<p>01. Song title 02. Another track Application instructions eligibility legal terms.</p>'.repeat(200) + '<p>完全な原文の末尾</p>';
  const value = sony.parsePage("callback(" + JSON.stringify({ total_count: 1, items: [{ id: 123, title: "HAN 新曲リリース", date: "2026.11.18", article }] }) + ")").items[0];
  const result = ingest(s, value);
  assert.ok(result.observation.summary.length > 6000);
  assert.ok(result.observation.summary.endsWith("完全な原文の末尾"));
  const body = discord.payload(result.discovery, store.supportingSources(result.discovery.id));
  const embed = body.embeds[0].toJSON();
  assert.ok(embed.description.length < 520);
  assert.doesNotMatch(embed.description, /Track List|Application instructions|https?:\/\//);
  assert.equal(embed.url, value.url);
  assert.equal(body.components[0].toJSON().components.find((control) => control.style === 5).url, value.url);
  assert.deepEqual(body.components[0].toJSON().components.filter((control) => control.custom_id).map((control) => control.label), ["Ignore", "Watch for Details", "Add to Calendar", "Translate to English"]);
});
test("JYPE and YouTube observations retain complete normalized text beyond the former 6000-character cutoff", () => {
  const long = "Original source detail ".repeat(400) + "TAIL";
  const notice = jype.parseDetail('<div class="boardView_cont"><div class="article-content">' + long + '</div></div>', { id: "jype", title: "Announcement", url: jype.url });
  assert.ok(notice.summary.endsWith("TAIL"));
  const xml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"><yt:channelId>${youtube.accountId}</yt:channelId><entry><yt:channelId>${youtube.accountId}</yt:channelId><yt:videoId>ABCDEFGHIJK</yt:videoId><title>SKZ CODE</title><media:group><media:description>${long}</media:description></media:group></entry></feed>`;
  const video = youtube.parseFeed(xml)[0];
  assert.ok(video.summary.endsWith("TAIL"));
  for (const value of [notice, video]) assert.equal(ingest(source(), value).observation.summary, value.summary);
});
test("preview removes repeated raw URLs and track-list boilerplate without altering persisted links/content", () => {
  const s = source();
  const url = "https://example.com/evidence";
  const value = item({ summary: "A new album is announced. Release date: November 20. " + (url + " ").repeat(100) + "Track List 01. Song 02. Song" , metadata: { links: [url] } });
  const { observation, discovery } = ingest(s, value);
  const description = discord.payload(discovery, store.supportingSources(discovery.id)).embeds[0].toJSON().description;
  assert.doesNotMatch(description, /https?:\/\/|Track List/);
  assert.match(description, /November 20/);
  assert.ok(observation.summary.includes(url));
  assert.deepEqual(JSON.parse(observation.metadata).links, [url]);
});
test("confirmed timing is distinct from compacted publication/discovery metadata without raw ISO timestamps", () => {
  const s = source();
  const { discovery } = ingest(s);
  const input = { ...discovery, event_at: "2026-11-20T11:00:00.000Z", event_date: "2026-11-20" };
  const body = discord.payload(input, store.supportingSources(discovery.id));
  const timing = body.embeds[0].toJSON().fields.find((field) => field.name === "Important timing").value;
  assert.doesNotMatch(timing, /Published|Discovered|Nov 18/);
  assert.match(timing, /Confirmed calendar date: <t:\d+:f>/);
  assert.equal(store.supportingSources(discovery.id)[0].published_at, "2026-11-18");
  assert.doesNotMatch(JSON.stringify(body), /2026-11-19T04:37:56\.872Z|2026-11-20T11:00:00/);
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).created_at, "2026-11-19T04:37:56.872Z");
  assert.equal(presentation.formatDate("2026-02-30"), null);
});

const classifications = [
  ["Stray Kids POPUP STORE 開催決定", "Pop-up"],
  ["SKZOO ポップアップストアのお知らせ", "Pop-up"],
  ["스트레이 키즈 팝업스토어 오픈", "Pop-up"],
  ["HAN 新曲『Solo』配信リリース決定", "Release"],
  ["승민 신곡 음원 발매 안내", "Release"],
  ["Stray Kids JAPAN NEW ALBUM 発売決定", "Release"],
  ["新专辑发行公告", "Release"],
  ["Stray Kids Making Movie 公開", "New Content"],
  ["뮤직비디오 비하인드 영상 공개", "New Content"],
  ["ミュージックビデオ メイキング公開", "New Content"],
  ["SKZ CODE new episode", "New Content"],
  ["New album listening party announced", "Event"],
  ["リスニングパーティー開催決定", "Event"],
  ["Stray Kids VR LIVE 開催決定", "Event"],
  ["LISTENING PARTY 参加申込受付開始", "Ticketing"],
  ["VIP ticket applications open", "Ticketing"],
  ["公演のチケット先行受付開始", "Ticketing"],
  ["콘서트 예매 접수 안내", "Ticketing"],
  ["SKZOO グッズ予約販売のお知らせ", "Merch / Sale"],
  ["グッズの予約受付開始", "Merch / Sale"],
  ["Official merchandise preorder opens", "Merch / Sale"],
  ["準備中 — stay tuned", "Unknown"],
  ["公開しました", "Unknown"],
];
for (const [title, category] of classifications) test("classification: " + title + " → " + category, () => {
  assert.equal(classifyObservation({ provider: "sony-info" }, item({ title, summary: "" })).category, category);
});
test("incidental ticketing body/translated wording cannot override an ambiguous primary source title", () => {
  const classification = classifyObservation({ provider: "sony-info" }, item({ title: "準備中", summary: "Tickets and applications for an album preorder are mentioned in legal boilerplate.", translatedTitle: "Album released" }));
  assert.equal(classification.category, "Unknown");
  assert.equal(classification.confidence, "uncertain");
});
test("reclassification of unchanged observations preserves discovery identity and Ignore/Watching/Resolved relationships", async () => {
  for (const state of ["Ignored", "Watching", "Resolved"]) {
    const s = source();
    const value = item({ title: "リスニングパーティー開催決定" });
    const legacy = { category: "Unknown", confidence: "uncertain", members: [], eligibility: "Unknown", reason: "Unknown", correlationKey: null };
    const { discovery } = ingest(s, value, legacy);
    store.setReviewState(s.guild_id, discovery.id, state);
    getDb().prepare("UPDATE radar_discoveries SET calendar_guild_id=?,calendar_candidate_id=?,handoff_result=?,event_date=? WHERE id=?")
      .run("calendar-target", 456, state === "Resolved" ? '{"kind":"candidate","record":{"id":456}}' : null, "2026-12-01", discovery.id);
    const before = store.getDiscovery(s.guild_id, discovery.id);
    const supports = store.supportingSources(discovery.id);
    const f = fixture(s.guild_id);
    await discord.syncRadarChannel(f.client, s.guild_id);
    const after = store.getDiscovery(s.guild_id, discovery.id);
    assert.equal(after.category, "Event");
    for (const key of ["id", "review_state", "calendar_guild_id", "calendar_candidate_id", "handoff_result", "event_date", "correlation_key", "created_at"]) assert.equal(after[key], before[key], key);
    assert.deepEqual(store.supportingSources(discovery.id), supports);
    assert.equal(ingest(s, value).discovery.id, discovery.id);
    assert.equal(store.listDiscoveries(s.guild_id).length, 1);
    await discord.syncRadarChannel(f.client, s.guild_id);
    assert.equal(f.sent.length, 1);
  }
});

test("offline detection recognizes Japanese, Korean, Chinese, English and a non-CJK language", async () => {
  for (const [text, language] of [
    ["HANの新曲が配信リリース決定！アルバムの詳細を公開しました。", "jpn"],
    ["승민의 신곡 음원이 발매됩니다. 새로운 솔로곡을 확인해 주세요.", "kor"],
    ["新专辑即将发行，成员们为粉丝准备了全新歌曲。", "cmn"],
    ["Stray Kids announce a new album. The new music will be released worldwide next month.", "eng"],
    ["El nuevo álbum se publicará el próximo mes con canciones originales para todos los seguidores.", "spa"],
  ]) assert.equal(await translation.detectLanguage(text), language);
});
for (const [title, summary, language] of [
  ["HANの新曲が配信リリース決定！", "11月20日に新曲を配信します。", "ja"],
  ["승민의 신곡 발매 안내", "새로운 솔로곡이 11월20일에 발매됩니다.", "ko"],
  ["新专辑即将发行", "新歌将在十一月二十日发行。", "zh-Hans"],
]) test(language + " source gets English presentation while original source data remains unchanged", async () => {
  const s = source();
  const value = item({ title, summary });
  const result = ingest(s, value);
  const original = cachedSource(result.discovery);
  const worker = workerFor({ ...translated, language });
  worker.request(original);
  await worker.whenIdle();
  const cached = worker.current(original);
  assert.equal(cached.status, "ready");
  assert.equal(cached.original_language, language);
  assert.equal(cached.provider, "azure");
  const embed = discord.payload(result.discovery, [original], { translation: cached }).embeds[0].toJSON();
  assert.match(embed.title, /HAN announces/);
  assert.match(embed.description, /solo song/);
  assert.match(embed.description, /Machine translated to English/);
  assert.equal(embed.url, value.url);
  assert.equal(cachedSource(result.discovery).title, title);
  assert.equal(cachedSource(result.discovery).summary, summary);
  assert.equal(store.listDiscoveries(s.guild_id).length, 1);
});
test("English observation never invokes the external translator", async () => {
  const s = source();
  const { discovery } = ingest(s);
  const worker = workerFor(translated, { detector: translation.detectLanguage });
  worker.request(cachedSource(discovery));
  await worker.whenIdle();
  assert.equal(worker.calls(), 0);
  assert.equal(worker.current(cachedSource(discovery)).status, "skipped");
});
test("unchanged translations persist across restarts; material edits refresh without changing identity or decisions", async () => {
  for (const state of ["Ignored", "Watching", "Resolved"]) {
    const s = source();
    const original = item({ title: "HAN 新曲リリース", summary: "新しいソロ楽曲がリリースされます。" });
    const { discovery } = ingest(s, original);
    store.setReviewState(s.guild_id, discovery.id, state);
    const worker = workerFor(translated);
    worker.request(cachedSource(discovery));
    worker.request(cachedSource(discovery));
    await worker.whenIdle();
    assert.equal(worker.calls(), 1);
    closeDb();
    worker.request(cachedSource(discovery));
    await worker.whenIdle();
    assert.equal(worker.calls(), 1);
    const changed = ingest(s, { ...original, summary: "リリース日が11月21日に変更されました。" });
    assert.equal(changed.discovery.id, discovery.id);
    worker.request(cachedSource(changed.discovery));
    await worker.whenIdle();
    assert.equal(worker.calls(), 2);
    assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, state);
    assert.equal(store.listDiscoveries(s.guild_id).length, 1);
  }
});
test("boilerplate-only edits reuse bounded translation input without paying to translate it again", async () => {
  const s = source();
  const value = item({ title: "HAN 新曲リリース", summary: "新曲を11月20日にリリースします。 Track List 01. A" });
  const { discovery } = ingest(s, value);
  const worker = workerFor(translated);
  worker.request(cachedSource(discovery));
  await worker.whenIdle();
  ingest(s, { ...value, summary: "新曲を11月20日にリリースします。 Track List 01. A 02. Extra track and new legal boilerplate" });
  worker.request(cachedSource(discovery));
  await worker.whenIdle();
  assert.equal(worker.calls(), 1);
  assert.equal(worker.current(cachedSource(discovery)).status, "ready");
});
test("long provider output is bounded in Discord and translation input excludes enormous boilerplate", async () => {
  const s = source();
  const value = item({ title: "HAN 新曲リリース", summary: "新曲のリリースが決定しました。11月20日発売です。 Track List " + "歌詞と免責事項 ".repeat(3000) });
  const { discovery } = ingest(s, value);
  let submitted;
  const worker = workerFor((input) => { submitted = input; return { ...translated, summary: "The new song has been released. ".repeat(1000) }; });
  worker.request(cachedSource(discovery));
  await worker.whenIdle();
  assert.ok(submitted.title.length <= 500);
  assert.ok(submitted.summary.length <= 900);
  assert.doesNotMatch(submitted.summary, /Track List|免責/);
  const body = discord.payload(discovery, store.supportingSources(discovery.id), { translation: worker.current(cachedSource(discovery)) });
  assert.ok(body.embeds[0].toJSON().description.length < 520);
  assert.ok(body.embeds[0].length < 6000);
  assert.ok(cachedSource(discovery).summary.length > 6000);
});
test("translation status/errors cannot create cross-source correlation", async () => {
  const s = source();
  const other = source("jype-notice", s.guild_id);
  const a = ingest(s, item({ title: "HAN 新曲リリース" })).discovery;
  const b = ingest(other, item({ id: "other", title: "HAN 신곡 발매", url: "https://straykids.jype.com/notice/other" })).discovery;
  const worker = workerFor(translated);
  worker.request(cachedSource(a)); worker.request(cachedSource(b));
  await worker.whenIdle();
  assert.notEqual(a.id, b.id);
  assert.equal(store.getDiscovery(s.guild_id, a.id).correlation_key, null);
  assert.equal(store.getDiscovery(s.guild_id, b.id).correlation_key, null);
  assert.equal(store.listDiscoveries(s.guild_id).length, 2);
});

test("missing provider configuration falls back without external calls", async () => {
  const s = source();
  const { discovery } = ingest(s, item({ title: "HAN 新曲リリース" }));
  const worker = translation.createTranslationService({ provider: () => translation.azureProvider({}), detector: async () => "jpn" });
  worker.request(cachedSource(discovery));
  await worker.whenIdle();
  assert.equal(worker.current(cachedSource(discovery)).status, "unavailable");
  const embed = discord.payload(discovery, store.supportingSources(discovery.id), { translation: worker.current(cachedSource(discovery)) }).embeds[0].toJSON();
  assert.equal(embed.title, "Official announcement · Release");
  assert.match(embed.description, /Translation not configured/);
});
test("failed translation still delivers original-language cards and never persists raw provider errors", async (t) => {
  const s = source();
  const { discovery } = ingest(s, item({ title: "HAN 新曲リリース" }));
  const worker = workerFor(() => { throw new Error("upstream secret-cookie-value"); });
  t.mock.method(translation, "request", worker.request);
  t.mock.method(translation, "current", worker.current);
  const f = fixture(s.guild_id);
  await discord.syncRadarChannel(f.client, s.guild_id);
  await worker.request(cachedSource(discovery));
  await worker.whenIdle(); await tick(); await discord.syncRadarChannel(f.client, s.guild_id);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].embeds[0].title, "Official announcement · Release");
  assert.match(f.sent[0].embeds[0].description, /Translation failed\/unavailable/);
  assert.equal(worker.current(cachedSource(discovery)).error, "translator_failed");
  assert.equal(store.getSettings(s.guild_id).delivery_error, null);
});
test("a hung translator does not block polling, other sources or original delivery", async (t) => {
  const s = source();
  const worker = workerFor(() => new Promise(() => {}), { timeoutMs: 15, detector: async (text) => /新曲/.test(text) ? "jpn" : "eng" });
  t.mock.method(translation, "request", worker.request);
  t.mock.method(translation, "current", worker.current);
  const f = fixture(s.guild_id);
  const result = await radar.pollRadar(f.client, s.guild_id, { adapters: [
    { key: "sony-info", accountId: "official", url: sony.url, fetchItems: async () => ({ items: [item({ title: "HAN 新曲リリース" })] }) },
    { key: "healthy-source", accountId: "official", url: jype.url, fetchItems: async () => ({ items: [item({ id: "healthy", title: "English album release" })] }) },
  ] });
  assert.equal(result.filter((row) => row.ok).length, 2);
  assert.equal(f.sent.length, 2);
  assert.equal(store.listDiscoveries(s.guild_id).length, 2);
  await worker.whenIdle(); await tick(); await discord.syncRadarChannel(f.client, s.guild_id);
  assert.equal(f.sent.length, 2);
  const foreign = store.listDiscoveries(s.guild_id).find((row) => /新曲/.test(row.title));
  assert.equal(worker.calls(), 0);
  assert.equal(worker.current(cachedSource(foreign)), null);
});
test("translation completion edits the existing card, preserving Ignored state and delivery identity", async (t) => {
  const s = source();
  const { discovery } = ingest(s, item({ title: "HAN 新曲リリース" }));
  store.setReviewState(s.guild_id, discovery.id, "Ignored");
  let release;
  const providerResult = new Promise((resolve) => { release = resolve; });
  const worker = workerFor(() => providerResult);
  t.mock.method(translation, "request", worker.request);
  t.mock.method(translation, "current", worker.current);
  const f = fixture(s.guild_id);
  await discord.syncRadarChannel(f.client, s.guild_id);
  const before = store.delivery(discovery.id, "radar-channel").message_id;
  assert.equal(f.sent.length, 1);
  worker.request(cachedSource(discovery));
  release(translated);
  await worker.whenIdle(); await tick(); await discord.syncRadarChannel(f.client, s.guild_id);
  assert.equal(f.sent.length, 1);
  assert.equal(store.delivery(discovery.id, "radar-channel").message_id, before);
  assert.match(f.sent[0].embeds[0].title, /HAN announces/);
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, "Ignored");
});

test("Azure v3 uses English only, plain text, autodetection and header-only key/optional region", async () => {
  for (const region of [undefined, "eastus"]) {
    let request;
    const provider = translation.azureProvider({ HARMONY_RADAR_TRANSLATION_PROVIDER: "azure", AZURE_TRANSLATOR_KEY: "fake-test-key", AZURE_TRANSLATOR_REGION: region }, async (url, init) => {
      request = { url, ...init };
      return new Response(JSON.stringify([
        { detectedLanguage: { language: "ja" }, translations: [{ to: "en", text: translated.title }] },
        { detectedLanguage: { language: "en" }, translations: [{ to: "en", text: translated.summary }] },
      ]));
    });
    const controller = new AbortController();
    const result = await provider.translate({ title: "新曲", summary: "詳細" }, controller.signal);
    assert.equal(request.url, "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en&textType=plain");
    assert.equal(request.headers["Ocp-Apim-Subscription-Key"], "fake-test-key");
    assert.equal(request.headers["Ocp-Apim-Subscription-Region"], region);
    assert.equal(request.redirect, "error"); assert.equal(request.signal, controller.signal);
    assert.deepEqual(JSON.parse(request.body), [{ Text: "新曲" }, { Text: "詳細" }]);
    assert.equal(result.title, translated.title); assert.equal(result.language, "ja");
  }
  assert.equal(translation.azureProvider({ HARMONY_RADAR_TRANSLATION_PROVIDER: "azure" }).available, false);
  assert.equal(translation.azureProvider({ HARMONY_RADAR_TRANSLATION_PROVIDER: "google", GOOGLE_CLOUD_TRANSLATION_API_KEY: "unused" }).available, false);
});
test("Provider rate limits share a cooldown and failed content is not retried on every poll", async () => {
  const s = source();
  const discoveries = [ingest(s, item({ id: "a" })).discovery, ingest(s, item({ id: "b", url: "https://example.com/b" })).discovery];
  const worker = workerFor(() => { throw Object.assign(new Error("translator_http_429"), { retryAfterMs: 2 * 3600000 }); });
  worker.request(cachedSource(discoveries[0]));
  await worker.whenIdle();
  worker.request(cachedSource(discoveries[0]));
  worker.request(cachedSource(discoveries[1]));
  await worker.whenIdle();
  assert.equal(worker.calls(), 1);
  assert.ok(Date.parse(worker.current(cachedSource(discoveries[0])).next_retry_at) >= Date.now() + 119 * 60000);
});
test("translation cache migration is additive/idempotent and preserves original records and owner state", () => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  migrate(db);
  db.exec("DROP TABLE radar_translations; INSERT INTO radar_settings(guild_id,channel_id,updated_at) VALUES('existing','channel','2026-11-18'); INSERT INTO radar_discoveries(guild_id,title,summary,review_state,created_at,updated_at) VALUES('existing','原文','全文','Ignored','2026-11-18','2026-11-18');");
  const before = db.prepare("SELECT * FROM radar_discoveries").all();
  migrate(db); migrate(db);
  assert.deepEqual(db.prepare("SELECT * FROM radar_discoveries").all(), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM radar_translations").get().n, 0);
  assert.equal(db.prepare("SELECT channel_id FROM radar_settings").get().channel_id, "channel");
  db.close();
});

test("translation-cache failure cannot prevent original Discord delivery", async (t) => {
  const s = source();
  ingest(s, item({ title: "HAN 新曲リリース" }));
  t.mock.method(translationStore, "get", () => { throw new Error("cache unavailable"); });
  const f = fixture(s.guild_id);
  await discord.syncRadarChannel(f.client, s.guild_id);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].embeds[0].title, "Official announcement · Release");
  assert.equal(store.getSettings(s.guild_id).delivery_error, null);
});
test("pending enrichment is labeled pending and failure is labeled unavailable", () => {
  const s = source();
  const { discovery } = ingest(s, item({ title: "HAN 新曲リリース" }));
  for (const [status, expected] of [["pending", /Translation pending/], ["failed", /Translation failed\/unavailable/]]) {
    assert.match(discord.payload(discovery, store.supportingSources(discovery.id), { translation: { status, lease_until: new Date(Date.now() + 60000).toISOString() } }).embeds[0].toJSON().description, expected);
  }
});

test("one slow non-English translation cannot block a different non-English translation", async () => {
  const s = source();
  const slow = ingest(s, item({ id: "slow", title: "Slow 新曲リリース", url: "https://example.com/slow" })).discovery;
  const fast = ingest(s, item({ id: "fast", title: "Fast 新曲リリース", url: "https://example.com/fast" })).discovery;
  const worker = workerFor((input) => input.title.startsWith("Slow") ? new Promise(() => {}) : translated, { timeoutMs: 30 });
  worker.request(cachedSource(slow)); worker.request(cachedSource(fast));
  await tick(); await tick();
  assert.equal(worker.current(cachedSource(fast)).status, "ready");
  await worker.whenIdle();
  assert.equal(worker.current(cachedSource(slow)).error, "translator_timeout");
});
test("external request budget is bounded and resumes after the minute without repeating successful content", async () => {
  const s = source();
  const rows = Array.from({ length: 21 }, (_, i) => ingest(s, item({ id: "budget-" + i, title: "新曲 " + i, url: "https://example.com/budget/" + i })).discovery);
  let now = Date.now();
  const worker = workerFor(translated, { clock: () => now });
  for (const row of rows) worker.request(cachedSource(row));
  await worker.whenIdle();
  assert.equal(worker.calls(), 20);
  const deferred = rows.find((row) => worker.current(cachedSource(row)).status === "failed");
  assert.ok(deferred);
  now += 60001;
  for (const row of rows) worker.request(cachedSource(row));
  await worker.whenIdle();
  assert.equal(worker.calls(), 21);
  assert.equal(worker.current(cachedSource(deferred)).status, "ready");
});
test("incomplete provider output falls back instead of labeling an empty result translated", async () => {
  const s = source();
  const { discovery } = ingest(s, item({ title: "新曲リリース" }));
  const worker = workerFor({ title: "", summary: "" });
  worker.request(cachedSource(discovery)); await worker.whenIdle();
  assert.equal(worker.current(cachedSource(discovery)).status, "failed");
  assert.equal(worker.current(cachedSource(discovery)).error, "translator_invalid_response");
});

test("full observation retention does not expand the existing discovery/calendar-note payload bound", () => {
  const s = source();
  const value = item({ summary: "Full original content. ".repeat(1000) });
  const result = ingest(s, value);
  assert.ok(result.observation.summary.length > 6000);
  assert.equal(result.discovery.summary.length, 6000);
  const changed = ingest(s, { ...value, summary: value.summary + "Another confirmed detail." });
  assert.ok(changed.observation.summary.endsWith("Another confirmed detail."));
  assert.equal(changed.discovery.summary.length, 6000);
  assert.equal(changed.discovery.id, result.discovery.id);
});

test("a newly constructed worker reuses persisted translations after restart", async () => {
  const s = source();
  const { discovery } = ingest(s, item({ title: "HAN 新曲リリース" }));
  const first = workerFor(translated);
  first.request(cachedSource(discovery)); await first.whenIdle();
  closeDb();
  const restarted = workerFor(() => assert.fail("Completed translation must be read from SQLite"));
  restarted.request(cachedSource(discovery)); await restarted.whenIdle();
  assert.equal(restarted.calls(), 0);
  assert.equal(restarted.current(cachedSource(discovery)).status, "ready");
});
test("pending translation leases prevent duplicate requests and expired work recovers after restart", async () => {
  const s = source();
  const { discovery } = ingest(s, item({ title: "HAN 新曲リリース" }));
  const now = Date.now();
  const original = cachedSource(discovery);
  assert.equal(translationStore.claim(original, "azure", now, 1000), true);
  closeDb();
  let clock = now + 500;
  const restarted = workerFor(translated, { clock: () => clock });
  restarted.request(cachedSource(discovery)); await restarted.whenIdle();
  assert.equal(restarted.calls(), 0);
  clock = now + 1001;
  restarted.request(cachedSource(discovery)); await restarted.whenIdle();
  assert.equal(restarted.calls(), 1);
  assert.equal(restarted.current(cachedSource(discovery)).status, "ready");
});
test("a late translation of old content cannot become the current presentation after a source edit", async () => {
  const s = source();
  const value = item({ title: "HAN 新曲リリース", summary: "新曲を11月20日に配信します。" });
  const { discovery } = ingest(s, value);
  const original = cachedSource(discovery);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const worker = workerFor(() => pending);
  worker.request(original); await tick();
  const changed = ingest(s, { ...value, title: "HAN 新曲の配信日変更", summary: "新しい配信日は11月21日です。" });
  release(translated); await worker.whenIdle();
  assert.equal(changed.discovery.id, discovery.id);
  assert.equal(worker.current(cachedSource(changed.discovery)), null);
  assert.equal(worker.current(original).status, "ready");
  assert.doesNotMatch(discord.payload(changed.discovery, store.supportingSources(discovery.id)).embeds[0].toJSON().title, /HAN announces/);
  assert.equal(cachedSource(changed.discovery).title, "HAN 新曲の配信日変更");
});

test("image-only announcements translate their title without inventing a body or discarding the image", async () => {
  const s = source();
  const value = item({ title: "新曲のお知らせ", summary: "", metadata: { images: ["https://example.com/poster.jpg"] } });
  const { discovery } = ingest(s, value);
  const worker = workerFor({ title: "New song announcement", summary: "", language: "ja" });
  worker.request(cachedSource(discovery)); await worker.whenIdle();
  const body = discord.payload(discovery, store.supportingSources(discovery.id), { translation: worker.current(cachedSource(discovery)) });
  const embed = body.embeds[0].toJSON();
  assert.equal(embed.title, "New song announcement");
  assert.equal(embed.image.url, "https://example.com/poster.jpg");
  assert.match(embed.description, /Open the original announcement/);
  assert.equal(cachedSource(discovery).summary, "");
});

test("Azure plain text preserves literal characters without HTML interpretation", async () => {
  const title = 'HAN\'s "Song" & <Live>';
  const provider = translation.azureProvider({ HARMONY_RADAR_TRANSLATION_PROVIDER: "azure", AZURE_TRANSLATOR_KEY: "fake" }, async () => new Response(JSON.stringify([
    { detectedLanguage: { language: "ja" }, translations: [{ to: "en", text: title }] },
  ])));
  const result = await provider.translate({ title: "新曲", summary: "" }, new AbortController().signal);
  assert.equal(result.title, title); assert.equal(result.summary, "");
});
test("valid legacy Azure translations survive the switch without relabeling, requests or row changes", async () => {
  const s = source();
  const { discovery } = ingest(s, item({ title: "HAN 新曲リリース" }));
  store.setReviewState(s.guild_id, discovery.id, "Watching");
  const original = cachedSource(discovery);
  assert.equal(translationStore.claim(original, "azure", Date.now(), 1000), true);
  translationStore.save(original, "azure", { status: "ready", ...translated });
  const before = getDb().prepare("SELECT * FROM radar_translations WHERE observation_id=?").all(original.id);
  closeDb();
  const worker = workerFor(() => assert.fail("No request for hash-matched cached translation"));
  worker.request(cachedSource(discovery)); await worker.whenIdle();
  assert.equal(worker.calls(), 0);
  const current = worker.current(cachedSource(discovery));
  assert.equal(current.provider, "azure");
  assert.equal(current.status, "ready");
  assert.match(discord.payload(discovery, [original], { translation: current }).embeds[0].toJSON().description, /Azure Translator/);
  assert.deepEqual(getDb().prepare("SELECT * FROM radar_translations WHERE observation_id=?").all(original.id), before);
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, "Watching");
});
test("changed source cannot use stale Azure cache and receives a separate Azure result with the same discovery", async () => {
  const s = source();
  const value = item({ title: "HAN 新曲リリース", summary: "11月20日リリースです。" });
  const { discovery } = ingest(s, value);
  store.setReviewState(s.guild_id, discovery.id, "Ignored");
  const original = cachedSource(discovery);
  translationStore.claim(original, "azure", Date.now(), 1000);
  translationStore.save(original, "azure", { status: "ready", ...translated });
  const oldRow = translationStore.get(original, "azure");
  const changed = ingest(s, { ...value, summary: "11月21日に変更です。" });
  const worker = workerFor({ ...translated, summary: "The release date is now November 21." });
  assert.equal(worker.current(cachedSource(changed.discovery)), null);
  worker.request(cachedSource(changed.discovery)); await worker.whenIdle();
  assert.equal(worker.calls(), 1);
  assert.equal(worker.current(cachedSource(changed.discovery)).provider, "azure");
  assert.equal(changed.discovery.id, discovery.id);
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, "Ignored");
  assert.deepEqual(translationStore.get(original, "azure"), oldRow);
  assert.match(discord.payload(changed.discovery, [cachedSource(changed.discovery)], { translation: worker.current(cachedSource(changed.discovery)) }).embeds[0].toJSON().description, /Azure Translator/);
});
test("failed legacy Google entries do not block Azure and completed Azure cache takes precedence", async () => {
  const s = source(); const { discovery } = ingest(s, item({ title: "HAN 新曲リリース" })); const original = cachedSource(discovery);
  translationStore.claim(original, "google", Date.now(), 1000);
  translationStore.save(original, "google", { status: "failed", error: "translator_http_403", retryAt: Date.now() + 86400000 });
  const worker = workerFor(translated); await worker.request(original);
  assert.equal(worker.calls(), 1); assert.equal(worker.current(original).provider, "azure");
  translationStore.save(original, "google", { status: "ready", ...translated, title: "Old Google title" });
  assert.equal(worker.current(original).provider, "azure");
  assert.equal(worker.current(original).translated_title, translated.title);
});
test("Azure errors retain existing sanitized HTTP/backoff contract without persisting response secrets", async () => {
  const s = source();
  const { discovery } = ingest(s, item({ title: "新曲リリース" }));
  const provider = translation.azureProvider({ HARMONY_RADAR_TRANSLATION_PROVIDER: "azure", AZURE_TRANSLATOR_KEY: "fake-secret-key" }, async () => new Response('private provider diagnostic fake-secret-key', { status: 429, headers: { "retry-after": "172800" } }));
  const worker = translation.createTranslationService({ provider: () => provider, detector: async () => "jpn" });
  worker.request(cachedSource(discovery)); await worker.whenIdle();
  const result = worker.current(cachedSource(discovery));
  assert.equal(result.error, "translator_http_429");
  assert.ok(Date.parse(result.next_retry_at) >= Date.now() + 47 * 3600000);
  assert.doesNotMatch(JSON.stringify(result), /fake-secret-key|private provider diagnostic/);
});
test("Azure malformed/oversized responses fail safely instead of generating a false translated result", async () => {
  for (const body of ['[{"translations":{}}]', '{}', '{"data":{"translations":[]}}', '{"data":{"translations":[{"translatedText":""}]}}', 'x'.repeat(32769)]) {
    const provider = translation.azureProvider({ HARMONY_RADAR_TRANSLATION_PROVIDER: "azure", AZURE_TRANSLATOR_KEY: "fake" }, async () => new Response(body));
    await assert.rejects(provider.translate({ title: "新曲", summary: "" }, new AbortController().signal), /translator_(invalid_response|response_too_large)/);
  }
});

test("YouTube preview suppresses hashtags, streaming URLs, social prompts and a repeated title before translation", () => {
  const value = { title: "SKZ CODE episode 99", summary: "SKZ CODE episode 99 #StrayKids #SKZ #StrayKids New episode premieres on November 23. Subscribe to our channel! Follow us on Instagram https://instagram.com/example Listen now https://example.com/music" };
  const input = presentation.translationInput(value);
  assert.equal(input.title, value.title);
  assert.match(input.summary, /New episode premieres on November 23/);
  assert.doesNotMatch(input.summary, /#|https?:|Subscribe|Follow|Listen now|SKZ CODE/);
  assert.ok(value.summary.includes("#StrayKids"));
});
test("generic titles classify from retained Japanese/Korean lead context and explicit Sony category", () => {
  for (const [provider, summary, metadata, expected] of [
    ["jype-notice", "스트레이 키즈 팝업스토어가 오픈합니다.", {}, "Pop-up"],
    ["sony-info", "HANの新曲が配信リリース決定！", {}, "Release"],
    ["sony-info", "Stray Kids listening party announced for November 25.", {}, "Event"],
    ["sony-info", "Applications open November 21 for the concert.", {}, "Ticketing"],
    ["sony-info", "詳細は近日公開。", { sourceCategory: "Release" }, "Release"],
    ["jype-notice", "詳細は近日公開。", {}, "Unknown"],
  ]) {
    const result = classifyObservation({ provider }, { title: "Details", summary, metadata, url: "https://example.com/info" });
    assert.equal(result.category, expected);
    assert.equal(result.correlationKey, null);
    assert.notEqual(result.confidence, "high");
  }
});
test("body content does not override a specific primary subject or use discarded legal/track context", () => {
  assert.equal(classifyObservation({ provider: "sony-info" }, item({ title: "Album release", summary: "Watch the making movie and apply for tickets now." })).category, "Release");
  for (const summary of ["Details soon. Track List 01. Music Video", "Details soon. Application instructions Tickets now available."]) {
    assert.equal(classifyObservation({ provider: "sony-info" }, item({ title: "Details", summary })).category, "Unknown");
  }
});
test("source/category and English announcement lead while review metadata stays compact", () => {
  const s = source();
  const { discovery } = ingest(s, item({ title: "HAN 新曲リリース", summary: "新曲を11月20日に発売します。" }));
  const embed = discord.payload(discovery, store.supportingSources(discovery.id), { translation: { status: "ready", provider: "azure", translated_title: "HAN announces a new song", translated_summary: "Release date: November 20. Track List 01. Song" } }).embeds[0].toJSON();
  assert.equal(embed.author.name, "Sony Japan Info • Release");
  assert.equal(embed.title, "HAN announces a new song");
  assert.doesNotMatch(embed.description, /新曲|Track List|https?:/);
  assert.match(embed.fields.find(f => f.name === "Important timing").value, /Release: November 20/);
  assert.match(embed.fields.find(f => f.name === "Official Source").value, /https:\/\/www.sonymusic/);
  assert.deepEqual(embed.fields.map(f => f.name), ["Important timing", "Official Source", "Review / Calendar"]);
  assert.equal(embed.footer.text, "SKZ Radar #" + discovery.id);
});
test("foreign fallback is compact and distinguishes not configured, pending and failure", () => {
  for (const [cache, configured, expected] of [
    [null, false, "Translation not configured"],
    [{ status: "unavailable", provider: "azure-missing-key" }, true, "Translation not configured"],
    [{ status: "pending", provider: "azure", lease_until: new Date(Date.now() + 60000).toISOString() }, true, "Translation pending"],
    [{ status: "failed", provider: "azure" }, true, "Translation failed/unavailable"],
  ]) {
    const view = presentation.cardView({ category: "Release" }, { title: "新曲リリース", summary: "日本語の長い記事。".repeat(1000) }, cache, { translationConfigured: configured });
    assert.equal(view.language, expected);
    assert.equal(view.title, "Official announcement · Release");
    assert.ok(view.summary.length < 100);
    assert.doesNotMatch(view.summary, /日本語/);
  }
});
test("candidate timing preserves event/release/application/deadline meaning without guessing dates", () => {
  for (const [text, expected] of [
    ["Event date: November 25, 2026 at 19:00 JST.", "Event: November 25, 2026 at 19:00 JST"],
    ["Release date: 2026-11-25.", "Release: 2026-11-25"],
    ["Applications open November 20. Applications close November 24.", "Application opens: November 20|Application deadline: November 24"],
    ["Deadline: November 24 at 18:00 KST.", "Deadline: November 24 at 18:00 KST"],
    ["11月24日発売決定。", "Release: 11月24日"],
    ["11월 24일 발매.", "Release: 11월 24일"],
    ["Published November 20. More details soon.", ""],
    ["Event next month; time to be confirmed.", ""],
    ["Applications close November 20 for the event November 25.", ""],
    ["Published November 20 for the release November 25.", ""],
    ["Release track 1/2 preview.", ""],
    ["Album release\n2026.11.18\nDetails forthcoming.", ""],
  ]) assert.equal(presentation.candidateTiming(text).join("|"), expected);
});
test("informational body timing never writes calendar truth or changes identity, support, decisions or delivery", async () => {
  for (const state of ["Ignored", "Watching", "Resolved"]) {
    const s = source("jype-notice");
    const value = item({ title: "Details", summary: "Listening party event date: November 25, 2026 at 19:00 JST." });
    const { discovery } = ingest(s, value, { category: "Unknown", confidence: "uncertain", members: [], eligibility: "Unknown", reason: "Owner confirmation required", correlationKey: null });
    store.setReviewState(s.guild_id, discovery.id, state);
    const before = store.getDiscovery(s.guild_id, discovery.id);
    const full = cachedSource(before);
    const f = fixture(s.guild_id);
    await discord.syncRadarChannel(f.client, s.guild_id);
    const reference = store.delivery(discovery.id, "radar-channel");
    await discord.syncRadarChannel(f.client, s.guild_id);
    const after = store.getDiscovery(s.guild_id, discovery.id);
    assert.equal(after.category, "Event");
    for (const key of ["id", "review_state", "event_at", "event_date", "calendar_candidate_id", "handoff_result", "correlation_key"]) assert.equal(after[key], before[key], key);
    assert.deepEqual(cachedSource(after), full);
    assert.equal(f.sent.length, 1);
    assert.equal(store.delivery(discovery.id, "radar-channel").message_id, reference.message_id);
    assert.match(f.sent[0].embeds[0].fields.find(field => field.name === "Important timing").value, /informational/);
  }
});

test("classification scans bounded cleaned source context beyond presentation-selected sentences", () => {
  const neutral = "Details are being prepared. Further information will follow. " + "Please check this page for updates. ".repeat(35);
  for (const [provider, evidence, expected] of [
    ["sony-info", "HANの新曲が配信リリース決定！", "Release"],
    ["jype-notice", "스트레이 키즈 팝업스토어가 오픈합니다.", "Pop-up"],
    ["sony-info", "A listening party is announced.", "Event"],
  ]) {
    const value = item({ title: "Details", summary: neutral + evidence });
    assert.ok(value.summary.indexOf(evidence) > 900);
    assert.ok(!presentation.preview(value.summary, value.title, 900).includes(evidence));
    assert.equal(classifyObservation({ provider }, value).category, expected);
  }
});
test("late track/legal/application boilerplate cannot supply classification evidence", () => {
  const neutral = "Details are being prepared. Further information will follow. Please check back for updates. ";
  for (const tail of [
    "Track List 01. Music Video 02. New album release.",
    "Terms and conditions: Concert ticket applications open now.",
    "Application instructions: Apply now for concert tickets.",
    "注意事項 コンサートのチケット先行受付開始。",
  ]) {
    const value = item({ title: "Details", summary: neutral + tail });
    assert.equal(classifyObservation({ provider: "sony-info" }, value).category, "Unknown");
  }
});
test("classification context is bounded independently of Discord preview limits", () => {
  const value = item({ title: "Details", summary: "Details forthcoming. ".repeat(1100) + "New album release announced." });
  assert.equal(classifyObservation({ provider: "sony-info" }, value).category, "Unknown");
});

function ownerInteraction(f, discovery, action = "translate", userId = "owner", admin = true) {
  const guild = f.client.guilds.cache.get(discovery.guild_id);
  return { customId: `harmony-radar:${action}:${discovery.id}`, guildId: guild.id, guild, client: f.client,
    channelId: "radar-channel", user: { id: userId }, member: { permissions: { has: () => admin } },
    replies: [], isModalSubmit: () => false,
    deferReply: async function () { this.deferred = true; }, deferUpdate: async function () { this.deferred = true; },
    editReply: async function (body) { this.replies.push(body); }, followUp: async function (body) { this.replies.push(body); },
    reply: async function (body) { this.replies.push(body); }, showModal: async function (body) { this.modal = body; },
  };
}
function useWorker(t, worker) {
  for (const name of ["request", "current", "useful"]) t.mock.method(translation, name, worker[name]);
}
test("owner click translates once, edits the same message and preserves original/state/calendar relationships", async (t) => {
  const s = source(); const { discovery } = ingest(s, item({ title: "新曲リリース", summary: "新曲を11月20日にリリースします。" }));
  store.setReviewState(s.guild_id, discovery.id, "Watching");
  const worker = workerFor(translated); useWorker(t, worker);
  const f = fixture(s.guild_id); await discord.syncRadarChannel(f.client, s.guild_id);
  const before = store.getDiscovery(s.guild_id, discovery.id), original = cachedSource(before);
  const messageId = store.delivery(discovery.id, "radar-channel").message_id;
  assert.equal(worker.calls(), 0);
  const buttons = f.sent[0].body.components[0].toJSON().components;
  assert.equal(buttons.length, 5); assert.ok(buttons.some(button => button.label === "Translate to English"));
  const click = ownerInteraction(f, discovery);
  await discord.handleRadarInteraction(click);
  assert.match(click.replies.at(-1), /English translation ready/);
  assert.equal(worker.calls(), 1); assert.equal(f.sent.length, 1);
  assert.equal(store.delivery(discovery.id, "radar-channel").message_id, messageId);
  assert.match(f.sent[0].embeds[0].title, /HAN announces/);
  assert.ok(!f.sent[0].body.components[0].toJSON().components.some(button => /translate/.test(button.custom_id)));
  assert.deepEqual(cachedSource(discovery), original);
  assert.deepEqual(store.getDiscovery(s.guild_id, discovery.id), before);
  await discord.handleRadarInteraction(ownerInteraction(f, discovery)); // stale cached button
  assert.equal(worker.calls(), 1);
  await discord.handleRadarInteraction(ownerInteraction(f, discovery, "ignore"));
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, "Ignored");
  await discord.handleRadarInteraction(ownerInteraction(f, discovery, "watch"));
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, "Watching");
  const calendarClick = ownerInteraction(f, discovery, "calendar");
  await discord.handleRadarInteraction(calendarClick);
  assert.match(calendarClick.replies.at(-1).content, /calendar-target/);
  assert.equal(worker.calls(), 1);
});
test("non-owner administrators and unauthorized users cannot request translation; wrong channel rejected", async (t) => {
  const s = source(); const { discovery } = ingest(s, item({ title: "신곡 발매" }));
  const worker = workerFor(translated); useWorker(t, worker); const f = fixture(s.guild_id);
  for (const [id, admin] of [["other-admin", true], ["outsider", false]]) {
    const click = ownerInteraction(f, discovery, "translate", id, admin);
    await discord.handleRadarInteraction(click);
    assert.equal(worker.calls(), 0); assert.ok(click.replies.length);
  }
  const wrong = ownerInteraction(f, discovery); wrong.channelId = "other-room";
  await discord.handleRadarInteraction(wrong); assert.equal(worker.calls(), 0);
});
test("concurrent owner clicks coalesce and report in-progress while no duplicate card is sent", async (t) => {
  const s = source(); const { discovery } = ingest(s, item({ title: "신곡 발매" }));
  let release; const deferred = new Promise(resolve => { release = resolve; });
  const worker = workerFor(() => deferred); useWorker(t, worker); const f = fixture(s.guild_id);
  await discord.syncRadarChannel(f.client, s.guild_id);
  const first = discord.handleRadarInteraction(ownerInteraction(f, discovery));
  const second = discord.handleRadarInteraction(ownerInteraction(f, discovery));
  await tick(); await tick();
  assert.equal(worker.calls(), 1);
  const button = f.sent[0].body.components[0].toJSON().components.find(b => b.custom_id?.includes(":translate:"));
  assert.equal(button.label, "Translating…"); assert.equal(button.disabled, true);
  release(translated); await Promise.all([first, second]);
  assert.equal(worker.calls(), 1); assert.equal(f.sent.length, 1);
});
test("automatic discovery/poll/startup/restart/refresh and expired leases never request translation", async (t) => {
  const s = source(); const worker = workerFor(translated); useWorker(t, worker);
  const f = fixture(s.guild_id);
  await radar.pollRadar(f.client, s.guild_id, { adapters: [{ key: "sony-info", accountId: "official", url: sony.url,
    fetchItems: async () => ({ items: [item({ title: "新曲リリース" })] }) }] });
  const d = store.listDiscoveries(s.guild_id)[0];
  translationStore.claim(cachedSource(d), "azure", Date.now() - 10000, 1);
  closeDb();
  await discord.syncRadarChannel(f.client, s.guild_id);
  await discord.syncRadarChannel(f.client, s.guild_id);
  let startup;
  t.mock.method(store, "listSettings", () => [{ guild_id: s.guild_id }]);
  let externalCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { externalCalls++; throw new Error("No external request allowed"); });
  t.mock.method(store, "ensureSources", () => {});
  // Exercise the real startup path without source HTTP: sources are in backoff.
  getDb().prepare("UPDATE radar_sources SET next_poll_at=? WHERE guild_id=?").run("2099-01-01T00:00:00Z", s.guild_id);
  const originalList = store.listSources;
  t.mock.method(store, "listSources", (...args) => originalList(...args).filter(row => row.provider === "sony-info"));
  startup = radar.startRadar(f.client);
  await tick(); await tick(); clearInterval(startup);
  await worker.whenIdle();
  assert.equal(worker.calls(), 0); assert.equal(f.sent.length, 1); assert.equal(externalCalls, 0);
});
test("source edit during owner translation cannot publish stale English", async (t) => {
  const s = source(); const value = item({ title: "新曲リリース", summary: "新しい発表です。" });
  const { discovery } = ingest(s, value); let release;
  const worker = workerFor(() => new Promise(resolve => { release = resolve; })); useWorker(t, worker);
  const f = fixture(s.guild_id); await discord.syncRadarChannel(f.client, s.guild_id);
  const click = ownerInteraction(f, discovery); const work = discord.handleRadarInteraction(click);
  await tick(); await tick();
  ingest(s, { ...value, summary: "発表内容が更新されました。" });
  release(translated); await work;
  assert.match(click.replies.at(-1), /Source changed/);
  assert.doesNotMatch(f.sent[0].embeds[0].title, /HAN announces/);
  assert.equal(worker.current(cachedSource(discovery)), null);
});
test("Azure free-quota exhaustion is distinct, persists across restart and never auto-retries or falls back", async (t) => {
  let calls = 0;
  const provider = translation.azureProvider({ HARMONY_RADAR_TRANSLATION_PROVIDER: "azure", AZURE_TRANSLATOR_KEY: "fake" }, async () => {
    calls++; return new Response(JSON.stringify({ error: { code: 403001, message: "private quota diagnostic" } }), { status: 403 });
  });
  const s = source(); const { discovery } = ingest(s, item({ title: "신곡 발매" }));
  let now = Date.now();
  const worker = translation.createTranslationService({ provider: () => provider, detector: async () => "kor", clock: () => now });
  useWorker(t, worker); const f = fixture(s.guild_id); const click = ownerInteraction(f, discovery);
  await discord.handleRadarInteraction(click);
  assert.equal(calls, 1); assert.match(click.replies.at(-1), /Free translation allowance exhausted/);
  assert.match(f.sent[0].embeds[0].description, /Free translation allowance exhausted/);
  assert.doesNotMatch(JSON.stringify(worker.current(cachedSource(discovery))), /private quota/);
  await discord.handleRadarInteraction(ownerInteraction(f, discovery)); assert.equal(calls, 1);
  now += 7200000; closeDb();
  const restarted = translation.createTranslationService({ provider: () => provider, clock: () => now });
  useWorker(t, restarted);
  await discord.syncRadarChannel(f.client, s.guild_id); await restarted.whenIdle();
  assert.equal(calls, 1); // Expired backoff is not authorization for another request.
});
test("explicit provider failure leaves card/source/owner decision intact and English sources need no button", async (t) => {
  const s = source(); const { discovery } = ingest(s, item({ title: "신곡 발매" }));
  store.setReviewState(s.guild_id, discovery.id, "Ignored"); const original = cachedSource(discovery);
  const worker = workerFor(() => { throw new Error("secret diagnostic"); }); useWorker(t, worker);
  const f = fixture(s.guild_id); const click = ownerInteraction(f, discovery);
  await discord.handleRadarInteraction(click);
  assert.match(click.replies.at(-1), /Translation unavailable/); assert.doesNotMatch(click.replies.at(-1), /secret diagnostic/);
  assert.deepEqual(cachedSource(discovery), original);
  assert.equal(store.getDiscovery(s.guild_id, discovery.id).review_state, "Ignored");
  assert.equal(f.sent.length, 1);
  const english = ingest(s, item({ id: "english", url: "https://example.com/english", title: "New English announcement", summary: "The new album will be released worldwide next month." }));
  assert.equal(await translation.createTranslationService().useful(cachedSource(english.discovery)), false);
});
test("valid Google cache is reused under Azure without a Google or Azure request", async () => {
  const s = source(); const { discovery } = ingest(s, item({ title: "新曲リリース" })); const original = cachedSource(discovery);
  translationStore.claim(original, "google", Date.now(), 1000);
  translationStore.save(original, "google", { status: "ready", ...translated });
  const worker = translation.createTranslationService({ provider: () => ({ id: "azure", available: true, translate: () => assert.fail("No provider fallback or cache miss") }) });
  const result = await worker.request(original);
  assert.equal(result.status, "ready"); assert.equal(result.provider, "google");
});
test("bounded translation includes late timing evidence and translated timing never becomes calendar truth", async (t) => {
  const s = source();
  const { discovery } = ingest(s, item({ title: "新曲リリース", summary: "詳細".repeat(1000) + "。11月24日発売決定。" }));
  let input;
  const worker = workerFor(value => { input = value; return { title: "New song release", summary: "Details will follow. Release: November 24.", language: "ja" }; });
  useWorker(t, worker); const f = fixture(s.guild_id);
  const before = store.getDiscovery(s.guild_id, discovery.id);
  await discord.handleRadarInteraction(ownerInteraction(f, discovery));
  assert.ok(input.summary.length <= 900); assert.match(input.summary, /Release: 11月24日/);
  assert.match(f.sent[0].embeds[0].fields.find(field => field.name === "Important timing").value, /Release: November 24/);
  const after = store.getDiscovery(s.guild_id, discovery.id);
  for (const key of ["event_at", "event_date", "calendar_candidate_id", "handoff_result"]) assert.equal(after[key], before[key]);
});

test("Google configuration and credentials can never activate new translation requests", async (t) => {
  let externalCalls = 0;
  const provider = translation.azureProvider({ HARMONY_RADAR_TRANSLATION_PROVIDER: "google", GOOGLE_CLOUD_TRANSLATION_API_KEY: "unused", AZURE_TRANSLATOR_KEY: "unused" }, async () => { externalCalls++; assert.fail("No provider request allowed"); });
  const worker = translation.createTranslationService({ provider: () => provider, detector: async () => "kor" });
  const s = source(); const { discovery } = ingest(s, item({ title: "신곡 발매" }));
  assert.equal((await worker.request(cachedSource(discovery))).status, "unavailable");
  assert.equal(externalCalls, 0);
});

test("owner-requested card update is not starved by the existing twenty-card delivery budget", async (t) => {
  const s = source(); const others = [];
  for (let i = 0; i < 41; i++) others.push(item({ id: "busy-" + i, url: "https://example.com/busy/" + i, title: "Album release " + i, summary: "Original details are available in the announcement." }));
  for (const value of others) ingest(s, value);
  const { discovery } = ingest(s, item({ id: "target", url: "https://example.com/target", title: "신곡 발매" }));
  const worker = workerFor(translated); useWorker(t, worker); const f = fixture(s.guild_id);
  for (let i = 0; i < 3; i++) await discord.syncRadarChannel(f.client, s.guild_id);
  const messageId = store.delivery(discovery.id, "radar-channel").message_id;
  assert.ok(messageId); assert.equal(f.sent.length, 42);
  for (const value of others) ingest(s, { ...value, summary: "Updated announcement detail now available." });
  await discord.handleRadarInteraction(ownerInteraction(f, discovery));
  assert.equal(store.delivery(discovery.id, "radar-channel").message_id, messageId);
  assert.match(f.sent.find(message => message.id === messageId).embeds[0].title, /HAN announces/);
  assert.equal(f.sent.length, 42); assert.equal(worker.calls(), 1);
});

test("legacy English-skip detection cannot trap a mixed Japanese title behind an untranslated button", async () => {
  const s = source(); const { discovery } = ingest(s, item({ title: "HAN 新曲", summary: "Details will be published in a future announcement for all of our listeners." }));
  const original = cachedSource(discovery);
  translationStore.claim(original, "azure", Date.now(), 1000);
  translationStore.save(original, "azure", { status: "skipped", language: "en" });
  const worker = workerFor(translated, { detector: async () => "eng" });
  assert.equal(await worker.useful(original), true);
  assert.equal(worker.current(original), null);
  assert.equal((await worker.request(original)).status, "ready");
  assert.equal(worker.calls(), 1);
});

test("short Latin-language input remains uncertain and offers owner-triggered translation", async () => {
  const s = source(); const { discovery } = ingest(s, item({ title: "Aviso", summary: "", metadata: {} }));
  const original = cachedSource(discovery);
  assert.equal(await translation.detectLanguage("Aviso"), "und");
  assert.equal(await translation.useful(original), true);
  const body = discord.payload(discovery, [original], { translationUseful: await translation.useful(original) });
  assert.ok(body.components[0].toJSON().components.some(button => button.label === "Translate to English"));
  assert.equal(translation.current(original), null);
});

test("informational timing distinguishes an event's application deadline from release/event dates", () => {
  const text = "Album release: November 25, 2026. Applications for this event must be submitted by November 15 at 23:59. Event date: December 20, 2026. Event date: January 30, 2027.";
  assert.deepEqual(presentation.candidateTiming(text), [
    "Release: November 25, 2026", "Application deadline: November 15 at 23:59", "Event: December 20, 2026",
  ]);
  assert.deepEqual(presentation.candidateTiming("Registration for the event is accepted until November 15 at 23:59."), ["Registration deadline: November 15 at 23:59"]);
  assert.deepEqual(presentation.candidateTiming("Orders for the concert must be placed by November 15 at 23:59."), ["Order deadline: November 15 at 23:59"]);
});
test("ambiguous event mentions and competing timing meanings are omitted", () => {
  for (const text of ["The eventual announcement on November 15.", "This event has information for November 15.", "Applications close November 15 for the event on December 20.", "Album release and event: November 25.", "Please apply for the event on November 15."]) {
    assert.deepEqual(presentation.candidateTiming(text), [], text);
  }
});

test("clear deadline wording retains its subject in English, Japanese and Korean", () => {
  for (const [text, expected] of [
    ["Application deadline: November 15 at 23:59.", "Application deadline: November 15 at 23:59"],
    ["Registration closes November 15 at 23:59.", "Registration deadline: November 15 at 23:59"],
    ["Order deadline: November 15 at 23:59.", "Order deadline: November 15 at 23:59"],
    ["公演の応募期限は11月15日23:59です。", "Application deadline: 11月15日23:59"],
    ["공연 신청 마감: 11월 15일 23:59.", "Application deadline: 11월 15일 23:59"],
    ["Event: December 20, 2026.", "Event: December 20, 2026"],
    ["Event date: January 30, 2027.", "Event: January 30, 2027"],
  ]) assert.deepEqual(presentation.candidateTiming(text), [expected]);
  for (const text of ["This event closes November 15.", "Release by November 25.", "Published November 15 for the event."]) assert.deepEqual(presentation.candidateTiming(text), []);
});
test("timing correction leaves existing translation request/cache identity byte-stable", () => {
  const value = { title: "Details", summary: "Details ".repeat(200) + ". Applications for this event must be submitted by November 15 at 23:59." };
  // Golden input digest captured from deployed PR #315 before this correction.
  const { createHash } = require("node:crypto");
  assert.equal(createHash("sha256").update(JSON.stringify(presentation.translationInput(value))).digest("hex"), "08ec0e95d2361594726505d5b07878102859d570d64dfd0e057583f39f00f23b");
  const input = presentation.translationInput(value);
  assert.match(input.summary, /\nEvent: November 15 at 23:59$/);
  // Legacy synthesized evidence is not proof that this is the event's date.
  const view = presentation.cardView({ category: "Event" }, value, { status: "ready", provider: "azure", input_summary: input.summary,
    translated_title: "Details", translated_summary: "Details will follow.\nEvent: November 15 at 23:59." });
  assert.deepEqual(view.timing, []);
  assert.equal(view.title, "Details"); assert.match(view.summary, /will follow/);
});
test("cached translated card fixes labels without modifying originals, decisions, cache, delivery or calendar truth", async (t) => {
  const s = source(); const value = item({ title: "アルバムとイベントのお知らせ", summary: "元の発表内容は保持されます。" });
  const { discovery } = ingest(s, value); store.setReviewState(s.guild_id, discovery.id, "Watching");
  const original = cachedSource(discovery);
  translationStore.claim(original, "azure", Date.now(), 1000);
  translationStore.save(original, "azure", { status: "ready", language: "ja", title: "Album and event details", summary: "Album release: November 25, 2026. Applications for the event must be submitted by November 15 at 23:59. Event date: December 20, 2026." });
  const before = store.getDiscovery(s.guild_id, discovery.id);
  const cached = translationStore.get(original, "azure");
  const worker = translation.createTranslationService({ provider: () => ({ id: "azure", available: true, translate: () => assert.fail("No translation request during re-render") }) });
  useWorker(t, worker); const f = fixture(s.guild_id);
  await discord.syncRadarChannel(f.client, s.guild_id);
  const messageId = store.delivery(discovery.id, "radar-channel").message_id;
  await discord.syncRadarChannel(f.client, s.guild_id);
  const embed = f.sent[0].embeds[0];
  const timing = embed.fields.find(field => field.name === "Important timing").value;
  assert.match(timing, /Application deadline: November 15 at 23:59/);
  assert.match(timing, /Release: November 25, 2026/);
  assert.match(timing, /Event: December 20, 2026/);
  assert.doesNotMatch(timing, /Event: November 15/);
  assert.equal(embed.title, cached.translated_title);
  assert.equal(embed.description, presentation.cardText(presentation.preview(cached.translated_summary, cached.translated_title), presentation.SUMMARY_LIMIT) + "\n\n*Machine translated to English · Azure Translator*");
  assert.deepEqual(translationStore.get(original, "azure"), cached);
  assert.deepEqual(cachedSource(discovery), original);
  assert.deepEqual(store.getDiscovery(s.guild_id, discovery.id), before);
  assert.equal(store.delivery(discovery.id, "radar-channel").message_id, messageId);
  assert.equal(f.sent.length, 1);
});

test("legacy appended Event evidence remains displayable when original source corroborates its meaning", () => {
  const source = { title: "Details", summary: "Details ".repeat(200) + ". Event date: December 20, 2026." };
  const input = presentation.translationInput(source);
  assert.match(input.summary, /\nEvent: December 20, 2026$/);
  const view = presentation.cardView({ category: "Event" }, source, { status: "ready", provider: "azure", input_summary: input.summary,
    translated_title: "Details", translated_summary: "Details will follow.\nEvent: December 20, 2026." });
  assert.deepEqual(view.timing, ["Event: December 20, 2026"]);
});

test("owner timing addendum retains release/content date precision and opening/deadline semantics", () => {
  for (const [text, expected] of [
    ["Album release: November 25, 2026.", "Release: November 25, 2026"],
    ["Video premieres November 25, 2026.", "Content release: November 25, 2026"],
    ["Preorders open November 15 at 23:59.", "Preorder opens: November 15 at 23:59"],
    ["Ticket sales start November 15 at 23:59.", "Ticket sales open: November 15 at 23:59"],
    ["Applications open November 15.", "Application opens: November 15"],
  ]) assert.deepEqual(presentation.candidateTiming(text), [expected]);
  assert.doesNotMatch(presentation.candidateTiming("Album release: November 25, 2026.").join(""), /00:00|12:00|UTC|JST/);
});
