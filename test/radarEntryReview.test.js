const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
process.env.HARMONY_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'radar-entry-')), 'test.sqlite');
process.env.HARMONY_RADAR_TRANSLATION_PROVIDER = 'disabled';
const store = require('../src/stores/radarStore');
const calendar = require('../src/stores/eventSchedulerStore');
const discord = require('../src/services/radarDiscord');
const scheduler = require('../src/services/eventSchedulerService');
const translation = require('../src/services/radarTranslationService');
const { getDb, closeDb } = require('../src/db/sqlite');
function fixture(patch = {}, provider = 'sony-info') {
  const guildId = randomUUID(), targetId = randomUUID(), messages = [];
  const member = { permissions: { has: () => true } };
  const channel = { id: 'radar', isTextBased: () => true, messages: { fetch: async query => query.message ? messages.find(m => m.id === query.message) : new Map() },
    send: async body => { const m = { id: String(messages.length + 1), author: { id: 'bot' }, body, edit: async body => { m.body = body; return m; } }; messages.push(m); return m; } };
  const guild = { id: guildId, ownerId: 'owner', members: { fetch: async () => member }, channels: { cache: new Map([['radar', channel]]) } };
  const target = { id: targetId, ownerId: 'owner', members: { fetch: async () => member }, channels: { cache: new Map(), fetch: async () => null } };
  const client = { user: { id: 'bot' }, guilds: { cache: new Map([[guildId, guild], [targetId, target]]) } };
  store.saveSettings(guildId, 'radar', targetId);
  store.ensureSources(guildId, [{ key: provider, accountId: 'official', url: 'https://www.sonymusic.co.jp/' }]);
  const source = store.listSources(guildId)[0];
  const item = { id: 'item', title: 'Stray Kids JAPAN 4th Mini Album SUIATSU リリース記念グッズ 通信販売スタート！',
    summary: '記念グッズの通信販売が始まります。' + '詳細情報を確認してください。'.repeat(150), url: 'https://www.sonymusic.co.jp/artist/StrayKids/info/123', publishedAt: '2026-11-20', metadata: { images: ['https://cdn.example.org/poster.jpg'] }, ...patch };
  const { discovery } = store.ingest(source, item, { category: 'Release', confidence: 'rule-based', eligibility: 'Potential', members: [], reason: 'Review', correlationKey: null });
  return { guild, target, client, discovery, source, item, messages };
}
const components = body => body.components.flatMap(row => row.toJSON().components);
const control = (body, action) => components(body).find(c => c.custom_id?.includes(':' + action + ':')).custom_id;
const fields = body => Object.fromEntries(body.embeds[1].toJSON().fields.map(f => [f.name, f.value]));
async function interact(f, customId, extra = {}) {
  const calls = [];
  const i = { customId, guildId: f.guild.id, guild: f.guild, client: f.client, channelId: extra.channelId || 'radar',
    user: { id: extra.actor || 'owner' }, member: { permissions: { has: () => !extra.deny } },
    isModalSubmit: () => !!extra.modal, values: extra.values,
    fields: { getTextInputValue: key => extra.fields?.[key] || '' },
    deferReply: async () => { i.deferred = true; }, deferUpdate: async () => { i.deferred = true; },
    editReply: async p => calls.push(p), update: async p => calls.push(p), reply: async p => calls.push(p),
    followUp: async p => calls.push(p), showModal: async p => { i.modal = p; } };
  await discord.handleRadarInteraction(i);
  for (const p of calls.filter(p => typeof p === 'object' && p.embeds)) {
    assert.ok(p.embeds.reduce((n, e) => n + e.length, 0) <= 6000);
    assert.ok(p.components.length <= 5);
    for (const row of p.components) assert.ok(row.toJSON().components.length <= 5);
    for (const c of components(p)) {
      assert.ok((c.custom_id || '').length <= 100);
      if (c.custom_id) assert.ok(c.custom_id.startsWith('harmony-radar:'), 'existing interactionCreate gateway must route every review action');
    }
  }
  return { body: calls.at(-1), calls, modal: i.modal };
}
async function open(f) { return (await interact(f, 'harmony-radar:calendar:' + f.discovery.id)).body; }
async function edit(f, body, values) {
  const modal = (await interact(f, control(body, 'edit'))).modal.toJSON();
  assert.equal(modal.components.length, 5);
  return (await interact(f, modal.custom_id, { modal: true, fields: values })).body;
}
const entry = { title: 'SUIATSU — Commemorative Merchandise Online Sales', date: '2026-11-20', time: '13:00', timezone: 'Asia/Tokyo', description: 'Online sales begin for SUIATSU release commemorative merchandise.' };
test.after(async () => { await translation.whenIdle(); closeDb(); });

test('private review shows stored source, bounded longer preview, image, publisher and separate publication without requests or candidates', async t => {
  const f = fixture(); t.mock.method(globalThis, 'fetch', () => assert.fail('No provider/fetch on opening review'));
  const before = store.supportingSources(f.discovery.id);
  const body = await open(f), context = body.embeds[0].toJSON();
  assert.equal(context.title, f.item.title);
  assert.ok(context.description.length > 360 && context.description.length < 1600);
  assert.equal(context.image.url, f.item.metadata.images[0]);
  assert.equal(context.fields[0].value, 'Sony Music Japan'); assert.equal(context.fields[1].value, 'November 20, 2026');
  assert.equal(fields(body).Date, 'Needs entry'); assert.equal(fields(body).Time, 'Date only (no time)');
  assert.equal(fields(body).Type, 'Shopping / Pop-Up');
  assert.deepEqual(store.supportingSources(f.discovery.id), before);
  assert.equal(calendar.listCalendarCandidates(f.target.id).length, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM scheduled_events').get().n, 0);
});

test('YouTube review derives only a trusted thumbnail and labels published content without prefilling its publication date', async () => {
  const f = fixture({ title: 'I.N NO RETURN', summary: 'The video is available on the official channel.', url: 'https://www.youtube.com/watch?v=ABCDEFGHIJK', metadata: {} }, 'youtube-uploads');
  const body = await open(f), context = body.embeds[0].toJSON();
  assert.equal(context.image.url, 'https://i.ytimg.com/vi/ABCDEFGHIJK/hqdefault.jpg');
  assert.match(context.footer.text, /Already published/); assert.equal(fields(body).Date, 'Needs entry');
  const missing = fixture({ metadata: { images: ['javascript:bad', 'https://localhost/image'] } });
  assert.equal((await open(missing)).embeds[0].toJSON().image, undefined);
});

test('complete prefill is allowed, partial dates and unknown timezone/time stay blank', async () => {
  const f = fixture({ title: 'Release', summary: 'Release: January 15, 2027 at 20:00 KST.' });
  const body = await open(f);
  assert.equal(fields(body).Date, '2027-01-15'); assert.equal(fields(body).Time, '20:00'); assert.equal(fields(body).Timezone, 'Asia/Seoul');
  for (const summary of ['Release: 2026.', 'Release: 2026-11.', 'Details soon.', 'Release: January 15, 2027 at 20:00.']) {
    const unknown = fixture({ title: 'Release', summary });
    const b = await open(unknown); assert.equal(fields(b).Time, 'Date only (no time)'); assert.equal(fields(b).Timezone, 'Not set');
    if (!summary.includes('January')) assert.equal(fields(b).Date, 'Needs entry');
  }
});

test('owner edits every field, type uses scheduler options, and refresh/reopening/source changes preserve the private draft', async () => {
  const f = fixture(); let body = await open(f);
  body = await edit(f, body, entry);
  for (const [field, name] of [['title', 'Title'], ['date', 'Date'], ['time', 'Time'], ['timezone', 'Timezone'], ['description', 'Description / notes']]) assert.equal(fields(body)[name], entry[field]);
  const options = components(body).find(c => c.type === 3).options;
  assert.deepEqual(options.map(o => o.value), scheduler.CALENDAR_CATEGORIES);
  body = (await interact(f, control(body, 'type'), { values: ['shopping'] })).body;
  const original = fields(body);
  body = (await interact(f, control(body, 'refresh'))).body; assert.deepEqual(fields(body), original);
  store.ingest(f.source, { ...f.item, title: 'Changed source title', summary: 'Changed source text' }, { category: 'Unknown', confidence: 'uncertain', eligibility: 'Unknown', members: [], reason: 'Review' });
  assert.deepEqual(fields(await open(f)), original);
});

test('explicit cached/coalesced translation updates same review without overwriting manually entered calendar values', async t => {
  const f = fixture(); let requests = 0;
  const worker = translation.createTranslationService({ provider: () => ({ id: 'azure', available: true, translate: async () => { requests++; return { title: 'Merchandise sales announced', summary: 'The announcement describes online merchandise sales.', language: 'ja' }; } }), detector: async () => 'jpn' });
  for (const name of ['request', 'current', 'useful']) t.mock.method(translation, name, worker[name]);
  let body = await open(f); assert.equal(requests, 0); body = await edit(f, body, entry);
  const values = fields(body), id = control(body, 'translate');
  const results = await Promise.all([interact(f, id), interact(f, id)]);
  assert.equal(requests, 1);
  for (const r of results) { assert.equal(r.body.embeds[0].toJSON().title, 'Merchandise sales announced'); assert.deepEqual(fields(r.body), values); }
  await interact(f, id); assert.equal(requests, 1);
  assert.equal(calendar.listCalendarCandidates(f.target.id).length, 0);
});

test('send enters existing review with exact owner title/notes/category/timing, requires approval, and replay cannot rewrite or duplicate it', async () => {
  const f = fixture(); let body = await edit(f, await open(f), entry);
  const sendId = control(body, 'send');
  body = (await interact(f, sendId)).body;
  assert.equal(body.embeds[1].toJSON().title, 'Sent to Calendar Review');
  let rows = calendar.listCalendarCandidates(f.target.id); assert.equal(rows.length, 1);
  const c = rows[0]; assert.equal(c.title, entry.title); assert.equal(c.submitted_note, entry.description);
  assert.equal(c.proposed_event_at, '2026-11-20T04:00:00.000Z'); assert.equal(c.proposed_event_timezone, 'Asia/Tokyo');
  assert.equal(JSON.parse(c.source_metadata).calendarCategory, 'shopping'); assert.equal(c.status, 'open');
  assert.match(scheduler.candidateReviewPayload(c, []).content, /Type: Shopping \/ Pop-Up/);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM scheduled_events WHERE guild_id=?').get(f.target.id).n, 0);
  await interact(f, sendId); assert.equal(calendar.listCalendarCandidates(f.target.id).length, 1);
  assert.deepEqual(calendar.getCalendarCandidate(f.target.id, c.id), c);
  assert.equal(store.supportingSources(f.discovery.id)[0].title, f.item.title);
  assert.equal(store.getDiscovery(f.guild.id, f.discovery.id).title, f.item.title);
  // Existing explicit Schedule Manager approval remains the only publication.
  await scheduler.handleEventSchedulerInteraction({ customId: `harmony-manager:candidate:addmodal:${c.id}:tz:Asia%2FTokyo`, guildId: f.target.id, client: f.client,
    memberPermissions: { has: () => true }, user: { id: 'owner' }, isButton: () => false, isModalSubmit: () => true,
    fields: { getTextInputValue: key => ({ title: entry.title, 'event-date': entry.date, 'event-time': entry.time, description: entry.description })[key] || '' }, reply: async () => {} });
  const decided = calendar.getCalendarCandidate(f.target.id, c.id), event = calendar.getEvent(f.target.id, decided.calendar_event_id);
  assert.equal(event.category, 'shopping'); assert.equal(event.event_at, c.proposed_event_at);
});

test('missing date and timezone prevent final send, while a date-only entry remains date-only', async () => {
  const f = fixture(); let body = await open(f);
  assert.match((await interact(f, control(body, 'send'))).body.content, /complete calendar date/);
  body = await edit(f, body, { ...entry, timezone: '' });
  assert.match((await interact(f, control(body, 'send'))).body.content, /requires a timezone/);
  body = await edit(f, body, { ...entry, time: '', timezone: '' });
  await interact(f, control(body, 'send'));
  const c = calendar.listCalendarCandidates(f.target.id)[0];
  assert.equal(c.proposed_event_at, null); assert.equal(c.proposed_event_timezone, null); assert.equal(JSON.parse(c.source_metadata).allDay, true);
});

test('actor, permissions, channel, modal revision and expiration are checked server-side; cancel creates nothing', async t => {
  const f = fixture(); const body = await open(f), editId = control(body, 'edit');
  assert.match((await interact(f, editId, { actor: 'other' })).body.content, /access changed/);
  assert.match((await interact(f, editId, { actor: 'other', deny: true })).body.content, /access changed/);
  assert.match((await interact(f, editId, { channelId: 'wrong' })).body.content, /access changed/);
  const modal = (await interact(f, editId)).modal.toJSON();
  const changed = (await interact(f, control(body, 'type'), { values: ['other'] })).body;
  assert.match((await interact(f, modal.custom_id, { modal: true, fields: entry })).body.content, /entry changed/);
  const nonOwner = fixture(); const admin = (await interact(nonOwner, 'harmony-radar:calendar:' + nonOwner.discovery.id, { actor: 'admin' })).body;
  assert.ok(!components(admin).some(c => c.custom_id?.includes(':translate:')));
  await interact(f, control(changed, 'cancel')); assert.equal(calendar.listCalendarCandidates(f.target.id).length, 0);
  const exp = fixture(); const b = await open(exp), now = Date.now(); t.mock.method(Date, 'now', () => now + 31 * 60000);
  assert.match((await interact(exp, control(b, 'send'))).body.content, /expired/);
});

test('an independently completed handoff shows actual canonical values rather than rewriting or claiming a stale draft', async () => {
  const f = fixture(); const body = await edit(f, await open(f), entry);
  const outcome = await discord.handoff(f.client, f.guild.id, f.discovery.id, 'owner', { ...entry, title: 'Canonical existing entry', date: '2026-12-01', description: 'Previously confirmed notes', time: '', timezone: '', category: 'other' });
  const before = calendar.getCalendarCandidate(f.target.id, outcome.record.id);
  const sent = (await interact(f, control(body, 'send'))).body;
  assert.equal(fields(sent).Title, 'Canonical existing entry'); assert.equal(fields(sent).Date, '2026-12-01');
  assert.equal(fields(sent)['Description / notes'], 'Previously confirmed notes');
  assert.deepEqual(calendar.getCalendarCandidate(f.target.id, before.id), before);
  assert.equal(calendar.listCalendarCandidates(f.target.id).length, 1);
});

test('failed/ambiguous handoff preserves a frozen retry through existing durable handoff state', async t => {
  const f = fixture(); let body = await edit(f, await open(f), entry);
  const save = t.mock.method(store, 'saveHandoff', () => { throw new Error('Ack persistence failure'); });
  const failed = await interact(f, control(body, 'send')); body = failed.body; save.mock.restore();
  assert.match(body.embeds[1].toJSON().footer.text, /Ack persistence failure/);
  assert.ok(components(body).find(c => c.custom_id?.includes(':edit:')).disabled);
  assert.equal(calendar.listCalendarCandidates(f.target.id).length, 1);
  const retry = await interact(f, control(body, 'send'));
  assert.equal(retry.body.embeds[1].toJSON().title, 'Sent to Calendar Review');
  assert.equal(calendar.listCalendarCandidates(f.target.id).length, 1);
});

test('revoked admin access and forged translation control are rejected for the same private draft', async () => {
  const f = fixture(); const body = (await interact(f, 'harmony-radar:calendar:' + f.discovery.id, { actor: 'admin' })).body;
  assert.match((await interact(f, control(body, 'refresh'), { actor: 'admin', deny: true })).body.content, /access changed/);
  const fakeTranslate = control(body, 'refresh').replace(':refresh:', ':translate:');
  assert.match((await interact(f, fakeTranslate, { actor: 'admin' })).body.content, /Only the Harmony server owner/);
  assert.equal(calendar.listCalendarCandidates(f.target.id).length, 0);
});

test('Radar inbox is a compact inbox rather than a calendar form, with existing source/actions intact', () => {
  const f = fixture(); const body = discord.payload(f.discovery, store.supportingSources(f.discovery.id));
  const embed = body.embeds[0].toJSON();
  assert.equal(embed.title, f.item.title); assert.ok(embed.description.length < 520);
  assert.equal(embed.image, undefined);
  assert.equal(embed.fields.find(field => field.name === 'Calendar timing').value, 'Needs review');
  assert.ok(components(body).some(c => c.label === 'Review / Add to Calendar'));
  assert.ok(components(body).some(c => c.label === 'Ignore')); assert.ok(components(body).some(c => c.label === 'Watch for Details'));
  assert.ok(components(body).some(c => c.label === 'Original Source' && c.url === f.item.url));
  assert.doesNotMatch(JSON.stringify(embed), /Date means:|Time: Not announced|Status: No calendar|SKZ Radar #|source_metadata/);
});

test('review translation failure leaves the draft editable and preserves owner values without a candidate', async t => {
  const f = fixture(); let body = await edit(f, await open(f), entry); const before = fields(body);
  t.mock.method(translation, 'request', async () => ({ status: 'failed', error: 'translator_free_quota_exhausted' }));
  body = (await interact(f, control(body, 'translate'))).body;
  assert.match(body.embeds[1].toJSON().footer.text, /Free translation allowance exhausted/);
  assert.deepEqual(fields(body), before);
  assert.equal(components(body).find(c => c.custom_id?.includes(':edit:')).disabled, false);
  assert.equal(calendar.listCalendarCandidates(f.target.id).length, 0);
});
