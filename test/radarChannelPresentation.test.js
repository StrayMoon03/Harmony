const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
process.env.HARMONY_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'radar-channel-')), 'isolated.sqlite');
process.env.HARMONY_RADAR_TRANSLATION_PROVIDER = 'disabled';
const { getDb, closeDb } = require('../src/db/sqlite');
const store = require('../src/stores/radarStore');
const discord = require('../src/services/radarDiscord');
const presentation = require('../src/services/radarPresentation');
const translation = require('../src/services/radarTranslationService');
const { classifyObservation } = require('../src/services/radarClassification');

function fixture(provider = 'youtube-uploads', patch = {}) {
  const guildId = randomUUID();
  store.saveSettings(guildId, 'radar');
  store.ensureSources(guildId, [{ key: provider, accountId: 'official', url: 'https://example.org/' }]);
  const source = store.listSources(guildId)[0];
  const item = { id: 'item', title: '[SKZ VLOG] Seungmin · Mini\'s minilog 9',
    summary: 'A new video from the official channel for fans to watch.',
    url: 'https://www.youtube.com/watch?v=ABCDEFGHIJK', publishedAt: '2026-11-18', metadata: { images: [], links: [] }, ...patch };
  const result = store.ingest(source, item, classifyObservation(source, item));
  return { source, item, ...result, sources: () => store.supportingSources(result.discovery.id) };
}
const controls = body => body.components.flatMap(row => row.toJSON().components);
function validate(body) {
  assert.ok((body.content || '').length <= 2000);
  assert.ok(body.components.length <= 5);
  for (const row of body.components) assert.ok(row.toJSON().components.length <= 5);
  for (const button of controls(body)) {
    assert.ok((button.custom_id || '').length <= 100);
    assert.ok((button.url || '').length <= 512);
  }
  const embed = body.embeds[0].toJSON();
  assert.ok(embed.title.length <= 256); assert.ok(embed.description.length <= 4096);
  assert.ok(embed.fields.length <= 25);
  for (const field of embed.fields) { assert.ok(field.name.length <= 256); assert.ok(field.value.length <= 1024); }
  assert.ok(body.embeds[0].length < 1600, 'normal cards remain substantially below the 6,000-character aggregate limit');
  return embed;
}
test.after(async () => { await translation.whenIdle(); closeDb(); });

for (const [provider, label, patch, translated] of [
  ['youtube-uploads', 'Official Stray Kids YouTube', {}, null],
  ['jype-notice', 'JYPE Notice', { title: 'Stray Kids fan meeting notice', summary: 'Stray Kids announced a fan meeting. Further official details will follow.', url: 'https://straykids.jype.com/Default/NoticeView?AnSeq=123' }, null],
  ['sony-info', 'Sony Music Japan', { title: '新曲リリースのお知らせ', summary: 'ストレイキッズの新曲リリースを発表しました。', url: 'https://www.sonymusic.co.jp/artist/StrayKids/info/123' }, { status: 'ready', provider: 'azure', translated_title: 'New Stray Kids release announced', translated_summary: 'Sony Music Japan announced a new Stray Kids release.' }],
]) test(provider + ' renders an announcement-first card with publisher, explanation and original link', () => {
  const f = fixture(provider, patch);
  const body = discord.payload(f.discovery, f.sources(), { translation: translated });
  const e = validate(body);
  assert.equal(e.author.name, '🔎 RADAR'); assert.match(e.description, /What this is/);
  assert.equal(e.fields.find(field => field.name === 'Source').value, label);
  assert.equal(controls(body).find(button => button.label === 'Original Source').url, f.item.url);
  assert.ok(controls(body).some(button => button.label === 'Add to Calendar' && !button.disabled));
  const visible = JSON.stringify(e);
  assert.doesNotMatch(visible, /confidence|correlation_key|Needs Review|Review \/ Calendar|SKZ Radar #|supporting sources|source_provider/);
  assert.ok(!visible.includes(provider));
  if (provider === 'youtube-uploads') assert.match(e.description, /Seungmin — Mini's minilog 9 \(SKZ VLOG\)/);
});

test('enormous source, evidence, image and markdown stay persisted but cannot inflate Discord output', () => {
  const f = fixture('sony-info', { title: '*'.repeat(1000), summary: 'The release is now available for fans.\n' + '#SKZ https://example.org/promotion\n'.repeat(12000),
    metadata: { images: ['https://example.org/giant-poster.jpg'], links: ['https://example.org/evidence'], evidence: 'x'.repeat(10000) } });
  const before = { source: f.sources(), discovery: store.getDiscovery(f.source.guild_id, f.discovery.id),
    support: getDb().prepare('SELECT * FROM radar_support WHERE discovery_id=?').all(f.discovery.id) };
  const e = validate(discord.payload(f.discovery, f.sources()));
  assert.equal(e.image, undefined); assert.doesNotMatch(e.description, /https?:|#SKZ/);
  assert.deepEqual(f.sources(), before.source);
  assert.deepEqual(store.getDiscovery(f.source.guild_id, f.discovery.id), before.discovery);
  assert.deepEqual(getDb().prepare('SELECT * FROM radar_support WHERE discovery_id=?').all(f.discovery.id), before.support);
  assert.ok(f.sources()[0].summary.length > 100000);
  assert.deepEqual(JSON.parse(f.sources()[0].metadata), f.item.metadata);
});

test('official event timing is readable, retains meaning and does not invent time or timezone', () => {
  for (const [summary, date, time] of [
    ['Event date: November 28, 2026 at 20:00 KST.', /Event Date: Nov 28, 2026/, /Time: 8:00 PM KST/],
    ['Event date: November 28, 2026.', /Event Date: Nov 28, 2026/, /Time: Not announced/],
    ['Event date: November 28, 2026 at 20:00.', /Event Date: Nov 28, 2026/, /Time: 8:00 PM \(time zone not announced\)/],
  ]) {
    const f = fixture('jype-notice', { title: 'Fan event', summary });
    const before = store.getDiscovery(f.source.guild_id, f.discovery.id);
    const e = validate(discord.payload(f.discovery, f.sources()));
    const timing = e.fields.find(field => field.name === 'Important timing').value;
    assert.match(timing, date); assert.match(timing, time);
    assert.ok(!e.fields.some(field => field.name === 'Published'));
    assert.deepEqual(store.getDiscovery(f.source.guild_id, f.discovery.id), before);
  }
});

test('publication stays publication, including a future publication timestamp', () => {
  const f = fixture('jype-notice', { title: 'Official update', summary: 'Further details will follow in the original announcement.', publishedAt: '2030-11-28T20:00:00.000Z' });
  const e = validate(discord.payload(f.discovery, f.sources()));
  assert.match(e.fields.find(field => field.name === 'Published').value, /^<t:\d+:f>$/);
  assert.ok(!e.fields.some(field => field.name === 'Important timing'));
  const modal = discord.calendarModal(f.discovery).toJSON();
  assert.ok(modal.components.every(row => !row.components[0].value));
  assert.equal(store.getDiscovery(f.source.guild_id, f.discovery.id).event_date, null);
});

test('English has no translation action, foreign content has one, and rendering cannot invoke a provider', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Rendering must not call an external provider'));
  for (const [patch, expected] of [
    [{ title: 'The new video is available for fans', summary: 'This is the official announcement with details for fans.' }, false],
    [{ title: '新曲のお知らせ', summary: '新曲の情報が公開されました。' }, true],
  ]) {
    const f = fixture('sony-info', patch);
    const source = presentation.primarySource(f.discovery, f.sources());
    const body = discord.payload(f.discovery, f.sources(), { translationUseful: await translation.useful(source) });
    validate(body);
    assert.equal(controls(body).some(button => button.label === 'Translate to English'), expected);
  }
});

test('missing image text has a conservative explanation and safe source action', () => {
  const f = fixture('jype-notice', { title: 'Official update', summary: '', metadata: { images: ['https://example.org/poster.jpg'] } });
  const e = validate(discord.payload(f.discovery, f.sources()));
  assert.match(e.description, /An announcement from JYPE Notice/);
  assert.doesNotMatch(e.description, /fan event|release|concert/i);
  assert.equal(e.image, undefined);
});

test('invalid or oversized source URLs cannot make the Discord payload invalid', () => {
  const f = fixture();
  for (const canonical_url of ['javascript:alert(1)', 'https://user:secret@example.org/', 'https://example.org/' + 'x'.repeat(600)]) {
    const e = validate(discord.payload(f.discovery, [{ ...f.sources()[0], canonical_url }]));
    assert.equal(e.url, undefined);
  }
});
