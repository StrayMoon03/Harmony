const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
process.env.HARMONY_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-preview-')), 'test.sqlite');
process.env.HARMONY_RADAR_TRANSLATION_PROVIDER = 'disabled';
const { getDb } = require('../src/db/sqlite');
const store = require('../src/stores/eventSchedulerStore');
const radar = require('../src/stores/radarStore');
const scheduler = require('../src/services/eventSchedulerService');
const presentation = require('../src/services/calendarReviewPresentation');
const translator = require('../src/services/radarTranslationService');
const cache = require('../src/stores/radarTranslationStore');

function fixture(extra = {}) {
  const guildId = 'preview-' + randomUUID();
  const edits = [];
  const channel = { isTextBased: () => true, messages: { fetch: async () => ({ edit: async p => edits.push(p) }) } };
  const guild = { id: guildId, channels: { cache: new Map([['manager', channel]]), fetch: async () => channel } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  store.saveManagerPanel(guildId, 'stray_kids', 'manager', 'panel');
  const candidate = store.createOrGetCalendarCandidate({ guildId, title: "[SKZ VLOG] Seungmin · Mini's minilog 9",
    sourceUrl: 'https://www.youtube.com/watch?v=' + randomUUID().replaceAll('-', '').slice(0, 11),
    proposedEventDate: '2026-11-13', sourceType: 'radar_handoff', sourceProvider: 'skz-radar', discoveryKey: randomUUID(),
    sourceProvenance: [{ provider: 'youtube-uploads', sourceName: 'youtube-uploads', sourceUrl: 'https://www.youtube.com/' }],
    sourceMetadata: '{"allDay":true}', submittedNote: 'Seungmin shares this video with fans from the official channel.', ...extra }).candidate;
  return { guildId, client, candidate, edits };
}
async function interact(f, action, extra = {}) {
  const calls = { reply: [], update: [], edit: [], modal: [], deferred: 0 };
  const i = { guildId: f.guildId, client: f.client, user: { id: 'admin' }, memberPermissions: { has: () => !extra.deny },
    customId: extra.id || `harmony-manager:candidate:${action}:${f.candidate.id}:inbox:0`,
    isButton: () => !extra.modal && !extra.select, isModalSubmit: () => !!extra.modal, isStringSelectMenu: () => !!extra.select,
    fields: { getTextInputValue: key => extra.fields?.[key] || '' }, values: extra.values || [],
    reply: async p => calls.reply.push(p), update: async p => calls.update.push(p), editReply: async p => calls.edit.push(p),
    deferUpdate: async () => { calls.deferred++; i.deferred = true; }, showModal: async p => calls.modal.push(p) };
  await scheduler.handleEventSchedulerInteraction(i);
  for (const p of [...calls.reply, ...calls.update, ...calls.edit]) {
    assert.ok((p.content || '').length <= 2000, 'Discord 50035 content overflow must not recur');
    assert.ok((p.components || []).length <= 5);
    for (const row of p.components || []) for (const c of row.toJSON().components) assert.ok((c.custom_id || '').length <= 100);
  }
  return calls;
}
const controls = p => p.components.flatMap(r => r.toJSON().components);
const count = f => scheduler.managerPanelComponents('stray_kids', f.guildId)[1].toJSON().components.find(c => c.custom_id.endsWith('candidate-inbox')).label;
async function approve(f, time = '', timezone = 'none') {
  const review = (await interact(f, 'review')).update[0];
  const add = await interact(f, 'add', { id: controls(review).find(c => c.label === 'Add to Calendar').custom_id });
  const select = add.update[0].components[0].toJSON().components[0];
  const modal = (await interact(f, 'addtimezone', { id: select.custom_id, select: true, values: [timezone] })).modal[0].toJSON();
  return { calls: await interact(f, 'addmodal', { id: modal.custom_id, modal: true, fields: { title: f.candidate.title, 'event-date': f.candidate.proposed_event_date, 'event-time': time, description: 'Owner-confirmed details' } }), modal };
}

test('production-sized YouTube description renders a bounded preview and approves through the real inbox path', async () => {
  const note = 'Seungmin shares this video with fans from the official channel.\n' + '#StrayKids #SKZ '.repeat(200) + '\nhttps://stream.example/album\n' + 'Subscribe to our channel!\n'.repeat(100);
  const f = fixture({ submittedNote: note });
  const review = (await interact(f, 'review')).update[0];
  assert.match(review.content, /CALENDAR PREVIEW/);
  assert.match(review.content, /November 13, 2026/);
  assert.match(review.content, /Time: All Day/);
  assert.match(review.content, /Type: YouTube \/ Content/);
  assert.match(review.content, /Source: Official Stray Kids YouTube/);
  assert.doesNotMatch(review.content, /source_provider|discovery_key|skz-radar|retrievedAt|#StrayKids|stream.example/);
  assert.ok(controls(review).some(c => c.label === 'Original Source' && c.url === f.candidate.source_url));
  await approve(f);
  const candidate = store.getCalendarCandidate(f.guildId, f.candidate.id);
  assert.equal(candidate.status, 'added');
  const event = store.getEvent(f.guildId, candidate.calendar_event_id);
  assert.equal(event.event_date, '2026-11-13'); assert.equal(event.event_at, null); assert.equal(event.all_day, 1);
  assert.equal(candidate.submitted_note, f.candidate.submitted_note); assert.equal(candidate.source_provenance, f.candidate.source_provenance);
  assert.equal(count(f), '📋 Review Discovered Events');
  assert.equal(f.edits.at(-1).components[1].toJSON().components.find(c => c.custom_id.endsWith('candidate-inbox')).label, count(f));
  await interact(f, 'addmodal', { id: `harmony-manager:candidate:addmodal:${candidate.id}:tz:none:inbox:0`, modal: true,
    fields: { title: 'Replay must not create another event', 'event-date': '2026-11-13' } });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM scheduled_events WHERE guild_id=?').get(f.guildId).n, 1);
});

test('timed approval preserves the exact candidate title, local time and uncommon canonical timezone', async () => {
  const f = fixture({ title: 'Official concert', proposedEventDate: '2026-12-20', proposedEventAt: '2026-12-20T15:45:00.000Z', proposedEventTimezone: 'Europe/Paris', sourceMetadata: '{"allDay":false}' });
  const review = (await interact(f, 'review')).update[0];
  assert.match(review.content, /\*\*Official concert\*\*/); assert.match(review.content, /Date: December 20, 2026/);
  assert.match(review.content, /Time: 16:45 \(Europe\/Paris\)/);
  await approve(f, '16:45', 'Europe/Paris');
  const decided = store.getCalendarCandidate(f.guildId, f.candidate.id);
  const event = store.getEvent(f.guildId, decided.calendar_event_id);
  assert.equal(event.title, f.candidate.title); assert.equal(event.event_at, f.candidate.proposed_event_at); assert.equal(event.event_timezone, 'Europe/Paris'); assert.equal(event.all_day, 0);
});

test('dismissal and approval remove only resolved candidates from the visibly refreshed pending count', async () => {
  const f = fixture();
  const other = store.createOrGetCalendarCandidate({ guildId: f.guildId, title: 'Still needs review', sourceUrl: 'https://example.org/' + randomUUID(), sourceProvider: 'jype-notice', discoveryKey: randomUUID() }).candidate;
  assert.match(count(f), /\(2\)/);
  await interact(f, 'dismiss');
  assert.equal(store.getCalendarCandidate(f.guildId, f.candidate.id).status, 'dismissed');
  assert.match(count(f), /\(1\)/);
  assert.equal(store.getCalendarCandidate(f.guildId, other.id).status, 'open');
  assert.match(f.edits.at(-1).components[1].toJSON().components.find(c => c.custom_id.endsWith('candidate-inbox')).label, /\(1\)/);
});

test('opening non-English review has zero provider calls and no translation storage writes', async () => {
  const f = fixture({ title: '新曲リリース', submittedNote: '新曲の発売についてのお知らせです。' });
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM radar_observations').get().n;
  const old = translator.request; translator.request = () => assert.fail('Opening review must not request translation');
  try {
    const p = (await interact(f, 'review')).update[0];
    assert.ok(controls(p).some(c => c.label === 'Translate to English'));
    assert.ok(controls(p).some(c => c.label === 'Original Source'));
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM radar_observations').get().n, before);
  } finally { translator.request = old; }
});

async function usingTranslator(run) {
  let calls = 0;
  const service = translator.createTranslationService({ provider: () => ({ id: 'azure', available: true, translate: async () => { calls++; return { title: 'New song release', summary: 'The new song is available to fans on the official channel.', language: 'ja' }; } }), detector: async () => 'jpn' });
  const original = { request: translator.request, current: translator.current };
  Object.assign(translator, { request: service.request, current: service.current });
  try { await run(() => calls, service); } finally { await service.whenIdle(); Object.assign(translator, original); }
}

test('a completed matching Radar translation is reused in calendar review without a provider request', async () => {
  const f = fixture({ title: '新曲リリース', submittedNote: '新曲の発売についてのお知らせです。' });
  const rg = 'radar-' + randomUUID();
  radar.ensureSources(rg, [{ key: 'sony-info', accountId: 'StrayKids', url: 'https://www.sonymusic.co.jp/' }]);
  const source = radar.listSources(rg)[0];
  const observation = radar.ingest(source, { id: randomUUID(), url: f.candidate.source_url, title: f.candidate.title, summary: f.candidate.submitted_note }, { category: 'Release', confidence: 'rule-based', eligibility: 'Potential', reason: 'Owner review' }).observation;
  cache.claim(observation, 'azure', Date.now(), 1000);
  cache.save(observation, 'azure', { status: 'ready', title: 'New song release', summary: 'The new song is available for fans.', language: 'ja' });
  await usingTranslator(async calls => {
    const before = store.getCalendarCandidate(f.guildId, f.candidate.id);
    const p = (await interact(f, 'review')).update[0];
    assert.match(p.content, /New song release/); assert.doesNotMatch(p.content, /Translate to English/);
    await interact(f, 'translate'); // A stale translate button still reuses cache.
    assert.equal(calls(), 0); assert.deepEqual(store.getCalendarCandidate(f.guildId, f.candidate.id), before);
    assert.equal(presentation.translationSource(f.candidate).id, observation.id);
  });
});

test('explicit concurrent translation edits the same review, coalesces, and never changes calendar/Radar state', async () => {
  const f = fixture({ title: '新曲リリース', submittedNote: '新曲の発売についてのお知らせです。' });
  const before = store.getCalendarCandidate(f.guildId, f.candidate.id);
  const radarBefore = getDb().prepare('SELECT * FROM radar_discoveries').all();
  await usingTranslator(async calls => {
    const results = await Promise.all([interact(f, 'translate'), interact(f, 'translate')]);
    assert.equal(calls(), 1);
    for (const r of results) { assert.equal(r.deferred, 1); assert.equal(r.reply.length, 0); assert.match(r.edit.at(-1).content, /New song release/); }
    assert.deepEqual(store.getCalendarCandidate(f.guildId, f.candidate.id), before);
    assert.deepEqual(getDb().prepare('SELECT * FROM radar_discoveries').all(), radarBefore);
    const source = presentation.translationSource(f.candidate);
    assert.equal(source.title, before.title); assert.equal(source.summary, before.submitted_note);
    const changed = { ...before, submitted_note: before.submitted_note + ' 新しい情報' };
    assert.equal(presentation.currentTranslation(changed), null);
  });
});

test('unauthorized translation and clearly English review never call the translator', async () => {
  const f = fixture();
  const old = translator.request; translator.request = () => assert.fail('No translation allowed');
  try {
    const p = (await interact(f, 'review')).update[0];
    assert.ok(!controls(p).some(c => c.label === 'Translate to English'));
    const denied = await interact(f, 'translate', { deny: true }); assert.match(denied.reply[0].content, /Only server admins/);
    const english = await interact(f, 'translate'); assert.match(english.edit.at(-1).content, /already appears to be English/);
  } finally { translator.request = old; }
});

test('cached Radar translation remains reusable for the exact candidate snapshot after the source observation changes', async () => {
  const f = fixture({ title: '新曲リリース', submittedNote: '新曲の発売についてのお知らせです。' });
  const source = presentation.translationSource(f.candidate, true);
  cache.claim(source, 'azure', Date.now(), 1000);
  cache.save(source, 'azure', { status: 'ready', title: 'Original song release', summary: 'Original release announcement.', language: 'ja' });
  getDb().prepare('UPDATE radar_observations SET summary=? WHERE id=?').run('A materially edited source', source.id);
  const old = translator.request; translator.request = () => assert.fail('Matching cached snapshot must not spend another request');
  try {
    const result = await interact(f, 'translate');
    assert.match(result.edit.at(-1).content, /Original song release/);
    assert.equal(presentation.currentTranslation({ ...f.candidate, submitted_note: 'Different candidate input' }), null);
  } finally { translator.request = old; }
});

test('provider failure is compact, preserves original/source and canonical timing, and never creates a Radar discovery', async () => {
  const f = fixture({ title: '新曲リリース', submittedNote: '新曲についてのお知らせです。' });
  const before = store.getCalendarCandidate(f.guildId, f.candidate.id);
  const countBefore = getDb().prepare('SELECT COUNT(*) AS n FROM radar_discoveries').get().n;
  const original = translator.request;
  translator.request = async () => ({ status: 'failed', error: 'translator_free_quota_exhausted' });
  try {
    const result = await interact(f, 'translate');
    assert.match(result.edit.at(-1).content, /Free translation allowance exhausted/);
    assert.ok(controls(result.edit.at(-1)).some(c => c.label === 'Original Source'));
    assert.deepEqual(store.getCalendarCandidate(f.guildId, f.candidate.id), before);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM radar_discoveries').get().n, countBefore);
  } finally { translator.request = original; }
});

test('markdown-heavy source content cannot overflow Discord limits or dominate the preview', async () => {
  const f = fixture({ title: '*'.repeat(800), submittedNote: '_'.repeat(20000), sourceProvenance: [{ sourceName: '*'.repeat(1000) }] });
  const result = await interact(f, 'review');
  assert.ok(result.update[0].content.length <= 2000);
  assert.ok(controls(result.update[0]).some(c => c.label === 'Add to Calendar'));
});

test('linking an existing canonical event resolves review and refreshes the count without adding an event', async () => {
  const f = fixture();
  const eventId = store.createCalendarEvent({ guildId: f.guildId, title: f.candidate.title, link: f.candidate.source_url,
    eventDate: f.candidate.proposed_event_date, calendarType: 'stray_kids', allDay: true, createdBy: 'admin' });
  await interact(f, 'link');
  const candidate = store.getCalendarCandidate(f.guildId, f.candidate.id);
  assert.equal(candidate.status, 'linked'); assert.equal(candidate.calendar_event_id, eventId);
  assert.equal(count(f), '📋 Review Discovered Events');
  assert.ok(f.edits.length);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM scheduled_events WHERE guild_id=?').get(f.guildId).n, 1);
});

test('a real Radar-sized 6,000-character handoff reuses its full-observation translation and lease identity', async () => {
  const body = '新曲の発売についてのお知らせです。 ' + '追加情報です。 '.repeat(1200);
  const f = fixture({ title: '新曲リリース', submittedNote: body.slice(0, 6000).trim() });
  const rg = 'full-article-' + randomUUID();
  radar.ensureSources(rg, [{ key: 'sony-info', accountId: 'StrayKids', url: 'https://www.sonymusic.co.jp/' }]);
  const source = radar.listSources(rg)[0];
  const observation = radar.ingest(source, { id: randomUUID(), url: f.candidate.source_url, title: f.candidate.title, summary: body }, null).observation;
  assert.notEqual(observation.summary, f.candidate.submitted_note);
  assert.equal(presentation.translationSource(f.candidate).id, observation.id, 'reuse the observation and its existing queue/lease');
  cache.claim(observation, 'azure', Date.now(), 1000);
  cache.save(observation, 'azure', { status: 'ready', title: 'New song release', summary: 'Official new song announcement.', language: 'ja' });
  await usingTranslator(async calls => {
    const result = await interact(f, 'translate');
    assert.equal(calls(), 0);
    assert.match(result.edit.at(-1).content, /New song release/);
  });
  // Late timing changes the actual translation input. It must not inherit a
  // cache just because the opening preview/title/source happen to match.
  getDb().prepare('UPDATE radar_observations SET summary=? WHERE id=?').run(body + '\nRelease: December 20, 2026.', observation.id);
  assert.equal(presentation.translationSource(f.candidate), null);
});

test('approval removes only its own actionable count and does not alter the Radar review queue', async () => {
  const f = fixture();
  store.createOrGetCalendarCandidate({ guildId: f.guildId, title: 'Another unresolved announcement', sourceUrl: 'https://example.org/' + randomUUID(), sourceProvider: 'sony-info', discoveryKey: randomUUID() });
  const before = getDb().prepare('SELECT * FROM radar_discoveries').all();
  assert.match(count(f), /\(2\)/);
  await approve(f);
  assert.match(count(f), /\(1\)/);
  assert.deepEqual(getDb().prepare('SELECT * FROM radar_discoveries').all(), before);
});

test('long-title preview matches the exact title prefilled by the existing approval modal', async () => {
  const title = 'An official Stray Kids announcement '.repeat(8);
  const f = fixture({ title });
  const preview = (await interact(f, 'review')).update[0];
  const { modal } = await approve(f);
  const prefilled = modal.components.find(row => row.components[0].custom_id === 'title').components[0].value;
  assert.equal(prefilled, title.slice(0, 120));
  const { escapeMarkdown } = require('discord.js');
  assert.ok(preview.content.includes('**' + escapeMarkdown(prefilled).trim() + '**'));
  assert.equal(store.getCalendarCandidate(f.guildId, f.candidate.id).title, title.trim(), 'stored provenance/title is never rewritten for display');
});
