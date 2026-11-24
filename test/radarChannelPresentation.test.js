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
  if (provider === 'youtube-uploads') assert.match(e.description, /A new video from the official channel/);
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
    ['Event date: November 28, 2026 at 20:00 KST.', /Date: November 28, 2026/, /Time: 8:00 PM KST/],
    ['Event date: November 28, 2026.', /Date: November 28, 2026/, /Time: Not announced/],
    ['Event date: November 28, 2026 at 20:00.', /Date: November 28, 2026/, /Time: 8:00 PM \(time zone not announced\)/],
  ]) {
    const f = fixture('jype-notice', { title: 'Fan event', summary });
    const before = store.getDiscovery(f.source.guild_id, f.discovery.id);
    const e = validate(discord.payload(f.discovery, f.sources()));
    const timing = e.fields.find(field => field.name === '📅 Calendar details').value;
    assert.match(timing, date); assert.match(timing, time);
    assert.equal(e.fields.find(field => field.name === 'Published (source/content)').value, 'November 18, 2026');
    assert.deepEqual(store.getDiscovery(f.source.guild_id, f.discovery.id), before);
  }
});

test('publication stays publication, including a future publication timestamp', () => {
  const f = fixture('jype-notice', { title: 'Official update', summary: 'Further details will follow in the original announcement.', publishedAt: '2030-11-28T20:00:00.000Z' });
  const e = validate(discord.payload(f.discovery, f.sources()));
  assert.equal(e.fields.find(field => field.name === 'Published (source/content)').value, 'November 28, 2030');
  assert.match(e.fields.find(field => field.name === '📅 Calendar details').value, /Date: Not identified/);
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

const decisionNow = new Date('2026-11-24T12:00:00Z');
const calendarArea = embed => embed.fields.find(field => field.name === '📅 Calendar details').value;
const modalValues = modal => Object.fromEntries(modal.toJSON().components.map(row => [row.components[0].custom_id, row.components[0].value || '']));

for (const [title, summary] of [
  ['I.N "NO RETURN" | [Stray Kids : SKZ-PLAYER]', 'I.N shares his new SKZ-PLAYER video with fans. Watch the performance in the original source.'],
  ['新曲リリースのお知らせ', 'Stray Kids JAPAN 4th Mini Albumのリリースが決定しました。収録内容の詳細は後日発表します。'],
  ['스트레이 키즈 신곡 공개', '스트레이 키즈의 새로운 노래가 공개되었습니다. 자세한 내용은 공식 공지에서 확인하세요.'],
]) test('decision preview leads with actual source title and useful text: ' + title, t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No provider call on render'));
  const f = fixture('sony-info', { title, summary });
  const before = f.sources();
  const body = discord.payload(f.discovery, f.sources(), { now: decisionNow });
  const e = validate(body);
  assert.equal(e.title, presentation.cardText(title, 256));
  assert.ok(e.description.includes(presentation.cardText(presentation.preview(summary, title, 360), 360)));
  assert.doesNotMatch(e.description, /An announcement from|Translate to English for details/);
  assert.deepEqual(f.sources(), before);
});

test('known album release date and missing time are explicit, publication is secondary and date-only', () => {
  const f = fixture('sony-info', { title: 'Album release notice', summary: 'Album release: January 15, 2027.', publishedAt: '2026-11-17T04:00:00.000Z' });
  const body = discord.payload(f.discovery, f.sources(), { now: decisionNow });
  const e = validate(body), details = calendarArea(e);
  assert.match(details, /Date: January 15, 2027/); assert.match(details, /Time: Not announced/);
  assert.match(details, /Date means: Album release/); assert.match(details, /Status: Upcoming/);
  assert.deepEqual(e.fields.map(field => field.name), ['📅 Calendar details', 'Source', 'Published (source/content)']);
  assert.equal(e.fields[2].value, 'November 17, 2026');
  assert.deepEqual(modalValues(discord.calendarModal(f.discovery)), { date: '2027-01-15', time: '', timezone: '' });
  assert.ok(controls(body).some(button => button.label === 'Add to Calendar' && !button.disabled));
});

test('already-published YouTube content never promotes publication into a calendar date', () => {
  const f = fixture('youtube-uploads', { title: 'I.N NO RETURN', summary: 'Watch this new video on the official channel.', publishedAt: '2026-11-17T04:00:00.000Z' });
  const body = discord.payload(f.discovery, f.sources(), { now: decisionNow });
  const e = validate(body), details = calendarArea(e);
  assert.match(details, /Date: Not identified/); assert.match(details, /Time: Not announced/);
  assert.match(details, /Date means: Not determined/); assert.match(details, /Status: Already published/);
  assert.match(details, /Content is already published/);
  assert.equal(e.fields.find(field => field.name === 'Published (source/content)').value, 'November 17, 2026');
  assert.deepEqual(modalValues(discord.calendarModal(f.discovery)), { date: '', time: '', timezone: '' });
  assert.ok(controls(body).some(button => button.label === 'Add to Calendar' && !button.disabled));
});

test('canonical date does not acquire a guessed meaning from category alone', () => {
  const f = fixture('jype-notice', { title: 'Announcement', summary: 'Further details will follow.' });
  const d = { ...f.discovery, event_date: '2027-01-15', category: 'Event' };
  const e = validate(discord.payload(d, f.sources(), { now: decisionNow }));
  assert.match(calendarArea(e), /Date: January 15, 2027/);
  assert.match(calendarArea(e), /Date means: Not determined/);
  assert.match(calendarArea(e), /Status: Upcoming/);
});

test('date meaning uses its own source sentence and competing meanings stay unresolved', () => {
  const f = fixture('jype-notice', { title: 'Album and concert details', summary: 'Concert event date: December 20, 2026. Album release: January 15, 2027. Application deadline: November 20, 2026 at 23:59 KST.' });
  const details = calendarArea(validate(discord.payload(f.discovery, f.sources(), { now: decisionNow })));
  assert.match(details, /Date means: Concert/); assert.match(details, /Date means: Album release/);
  assert.match(details, /Date means: Application deadline/); assert.match(details, /Status: Deadline has passed/);
  // Multiple date choices remain the owner's decision, not a first-date prefill.
  assert.deepEqual(modalValues(discord.calendarModal(f.discovery)), { date: '', time: '', timezone: '' });
  const sameDay = fixture('sony-info', { title: 'Details', summary: 'Release: January 15, 2027. Event date: January 15, 2027.' });
  const d = { ...sameDay.discovery, event_date: '2027-01-15' };
  assert.match(calendarArea(validate(discord.payload(d, sameDay.sources(), { now: decisionNow }))), /Date means: Not determined/);
});

test('explicit translation changes only title/preview; its proposed dates cannot replace source timing', () => {
  const f = fixture('sony-info', { title: '新曲リリースのお知らせ', summary: '発売：2027年1月15日。', publishedAt: '2026-11-17' });
  const original = f.sources(), record = store.getDiscovery(f.source.guild_id, f.discovery.id);
  const translated = { status: 'ready', provider: 'azure', translated_title: 'New release announced', translated_summary: 'The album is announced. Release: February 2, 2027.' };
  const e = validate(discord.payload(f.discovery, f.sources(), { now: decisionNow, translation: translated }));
  assert.equal(e.title, 'New release announced'); assert.match(e.description, /The album is announced/);
  assert.match(calendarArea(e), /Date: January 15, 2027/); assert.doesNotMatch(calendarArea(e), /February 2/);
  assert.deepEqual(f.sources(), original); assert.deepEqual(store.getDiscovery(f.source.guild_id, f.discovery.id), record);
});

test('bare year, year-month and incomplete event_at cannot invent modal dates or times', () => {
  const f = fixture('jype-notice', { title: 'Details', summary: 'Date to be announced.', publishedAt: '2026-11-17T12:00:00Z' });
  for (const partial of ['2026', '2026-11', 'November 2026', '2026-02-30T12:00:00Z', '2026-11-28T20:00', '20:00', 2026]) {
    const d = { ...f.discovery, event_date: partial, event_at: partial, event_timezone: 'Asia/Seoul' };
    const modal = discord.calendarModal(d), values = modalValues(modal);
    assert.equal(values.date, '', String(partial)); assert.equal(values.time, '', String(partial));
    assert.equal(modal.toJSON().components[0].components[0].max_length, 10);
    const e = validate(discord.payload(d, f.sources(), { now: decisionNow }));
    assert.match(calendarArea(e), /Date: Not identified/);
  }
});

test('complete canonical dates and exact instants still prefill, unknown time and timezone remain blank', () => {
  const f = fixture('jype-notice', { title: 'Details', summary: 'Further information soon.' });
  assert.deepEqual(modalValues(discord.calendarModal({ ...f.discovery, event_date: '2027-01-15' })), { date: '2027-01-15', time: '', timezone: '' });
  const d = { ...f.discovery, event_date: '2027-01-15', event_at: '2027-01-15T11:00:00Z', event_timezone: 'Asia/Seoul' };
  assert.deepEqual(modalValues(discord.calendarModal(d)), { date: '2027-01-15', time: '20:00', timezone: 'Asia/Seoul' });
  assert.match(calendarArea(validate(discord.payload(d, f.sources(), { now: decisionNow }))), /Time: 8:00 PM KST/);
  assert.deepEqual(modalValues(discord.calendarModal({ ...d, event_at: '20:00', event_timezone: '' })), { date: '2027-01-15', time: '', timezone: '' });
});

test('source partial dates and publication dates leave unknown calendar timing explicit', () => {
  for (const summary of ['Release: 2026.', 'Release: 2026-11.', 'Release: November 2026.', 'Published November 17, 2026.', 'Details to follow.']) {
    const f = fixture('jype-notice', { title: 'Details', summary, publishedAt: '2026-11-17' });
    const e = validate(discord.payload(f.discovery, f.sources(), { now: decisionNow }));
    assert.match(calendarArea(e), /Date: Not identified/);
    assert.deepEqual(modalValues(discord.calendarModal(f.discovery)), { date: '', time: '', timezone: '' });
  }
});

test('past release and future concert statuses rely on source dates, not publication or category', () => {
  for (const [summary, status] of [
    ['Single release: November 17, 2026.', 'Already released'],
    ['Concert event date: December 20, 2026 at 20:00 KST.', 'Upcoming'],
    ['Application deadline: November 17, 2026 at 23:59 KST.', 'Deadline has passed'],
  ]) {
    const f = fixture('jype-notice', { title: 'Official details', summary, publishedAt: '2026-11-01' });
    assert.ok(calendarArea(validate(discord.payload(f.discovery, f.sources(), { now: decisionNow }))).includes('Status: ' + status));
  }
});

test('date-only boundary-day timing is not declared upcoming or past using a guessed timezone', () => {
  const f = fixture('sony-info', { title: 'Release notice', summary: 'Album release: November 24, 2026.' });
  const details = calendarArea(validate(discord.payload(f.discovery, f.sources(), { now: new Date('2026-11-24T01:00:00Z') })));
  assert.match(details, /Time: Not announced/);
  assert.doesNotMatch(details, /Status: Upcoming|Status: Already released/);
});
