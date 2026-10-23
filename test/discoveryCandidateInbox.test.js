const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const store = require('../src/stores/eventSchedulerStore');
const { managerPanelComponents, handleEventSchedulerInteraction, buildCalendarMessages } = require('../src/services/eventSchedulerService');
const { runDiscovery } = require('../src/services/calendarDiscoveryService');

function fixture() {
  const guildId = `inbox-${randomUUID()}`;
  const sent = [];
  const channel = { id: 'control', isTextBased: () => true,
    send: async payload => { sent.push(payload); return { id: 'notice' }; },
    messages: { fetch: async () => { throw Error('Old review message deleted'); } },
  };
  const guild = { id: guildId, channels: { cache: new Map([['control', channel]]), fetch: async () => channel } };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } };
  store.setReconciliationChannel(guildId, 'control');
  return { guildId, client, sent };
}
function candidate(f, title = 'First event', extra = {}) {
  return store.createOrGetCalendarCandidate({ guildId: f.guildId, title,
    sourceUrl: `https://straykids.jype.com/schedule?id=${randomUUID()}`, sourceType: 'discovery',
    sourceProvider: 'jype-straykids-schedule', discoveryKey: randomUUID(),
    sourceMetadata: JSON.stringify({ allDay: true, location: 'Seoul' }),
    proposedEventDate: '2026-12-01', ...extra,
  }).candidate;
}
async function interact(f, customId, extra = {}) {
  const calls = { reply: [], update: [], modal: [] };
  const i = { guildId: f.guildId, client: f.client, customId,
    user: { id: 'admin' }, memberPermissions: { has: () => true },
    isButton: () => !extra.modal && !extra.select,
    isModalSubmit: () => Boolean(extra.modal), isStringSelectMenu: () => Boolean(extra.select),
    fields: { getTextInputValue: key => extra.fields?.[key] || '' }, values: extra.values || [],
    reply: async payload => calls.reply.push(payload), update: async payload => calls.update.push(payload),
    showModal: async payload => calls.modal.push(payload),
  };
  if (extra.deny) i.memberPermissions = { has: () => false };
  await handleEventSchedulerInteraction(i);
  for (const payload of [...calls.reply, ...calls.update]) {
    if (!payload.components) continue;
    assert.ok(payload.components.length <= 5, 'Discord permits at most five action rows');
    for (const row of payload.components) {
      const json = row.toJSON();
      assert.ok(json.components.length <= 5);
      for (const component of json.components) {
        if (component.custom_id) assert.ok(component.custom_id.length <= 100);
      }
    }
  }
  return calls;
}
const buttons = payload => payload.components.flatMap(row => row.components.map(c => c.data));
const id = (payload, label) => buttons(payload).find(c => c.label === label).custom_id;
const open = f => interact(f, 'harmony-manager:stray_kids:candidate-inbox');

test('Review Discovered Events is restricted to the Stray Kids manager', () => {
  const skz = managerPanelComponents('stray_kids').flatMap(row => row.components);
  assert.ok(skz.some(b => b.data.label === '📋 Review Discovered Events'));
  assert.ok(!managerPanelComponents('community').flatMap(row => row.components).some(b => b.data.label === '📋 Review Discovered Events'));
  assert.ok(skz.every(b => b.data.custom_id.length <= 100));
});

test('one private browser reopens persisted candidates with deleted notices and navigates in place', async () => {
  const f = fixture(); const first = candidate(f); candidate(f, 'Second event');
  store.saveCalendarCandidateNotice(f.guildId, first.id, 'deleted-message');
  candidate(f, 'Human submission', { sourceType: 'member_submission', sourceProvider: null, discoveryKey: null });
  const dismissed = candidate(f, 'Already ignored');
  store.decideCalendarCandidate(f.guildId, dismissed.id, 'dismissed', 'admin');
  const opened = await open(f);
  assert.equal(opened.reply.length, 1); assert.equal(opened.reply[0].flags, 64);
  const p = opened.reply[0];
  assert.match(p.content, /📋 \*\*DISCOVERED EVENTS\*\*/); assert.match(p.content, /2 events awaiting review/);
  assert.match(p.content, new RegExp(`Event #${first.id}`)); assert.match(p.content, /1 of 2 — First event/);
  assert.match(p.content, /Seoul/); assert.doesNotMatch(p.content, /https?:\/\//);
  assert.equal(buttons(p).find(b => b.label === '◀ Previous').disabled, true);
  const next = await interact(f, id(p, 'Next ▶'));
  assert.equal(next.reply.length, 0); assert.equal(next.update.length, 1);
  assert.match(next.update[0].content, /2 of 2 — Second event/);
  assert.equal(buttons(next.update[0]).find(b => b.label === 'Next ▶').disabled, true);
  const previous = await interact(f, id(next.update[0], '◀ Previous'));
  assert.match(previous.update[0].content, /1 of 2 — First event/);
  const review = await interact(f, id(previous.update[0], 'Review'));
  assert.equal(review.reply.length, 0); assert.equal(review.update.length, 1);
  assert.match(review.update[0].content, /Potential Stray Kids event/);
  assert.match(review.update[0].content, /All-day: Yes/);
  assert.doesNotMatch(review.update[0].content, /"allDay"/);
  const back = await interact(f, id(review.update[0], 'Back to Discovered Events'));
  assert.match(back.update[0].content, /1 of 2/);
  const closed = await interact(f, id(back.update[0], 'Close'));
  assert.deepEqual(closed.update[0].components, []);
  assert.equal(f.sent.length, 0);
});

test('empty inbox and stale selection recover without reposting or reopening candidates', async () => {
  const f = fixture(); const empty = (await open(f)).reply[0];
  assert.match(empty.content, /0 events awaiting review/);
  const c = candidate(f); const page = (await open(f)).reply[0];
  store.decideCalendarCandidate(f.guildId, c.id, 'dismissed', 'other-admin');
  const stale = await interact(f, id(page, 'Review'));
  assert.match(stale.update[0].content, /0 events awaiting review/);
  assert.equal(store.getCalendarCandidate(f.guildId, c.id).status, 'dismissed');
  assert.equal(f.sent.length, 0);
});

test('inbox and candidate actions retain admin checks and guild isolation', async () => {
  const f = fixture(); const c = candidate(f);
  const denied = await interact(f, 'harmony-manager:stray_kids:candidate-inbox', { deny: true });
  assert.match(denied.reply[0].content, /Only server admins/);
  const other = fixture();
  const isolated = await interact(other, `harmony-manager:candidate:review:${c.id}:inbox:0`);
  assert.match(isolated.update[0].content, /0 events awaiting review/);
});

test('Ignore updates detailed browser and Back reloads pending records', async () => {
  const f = fixture(); const c = candidate(f); candidate(f, 'Remaining event');
  const review = await interact(f, `harmony-manager:candidate:review:${c.id}:inbox:0`);
  const ignored = await interact(f, id(review.update[0], 'Dismiss'));
  assert.match(ignored.update[0].content, new RegExp(`Event #${c.id} \\u2022 Dismissed`));
  assert.equal(store.getCalendarCandidate(f.guildId, c.id).status, 'dismissed');
  const back = await interact(f, id(ignored.update[0], 'Back to Discovered Events'));
  assert.match(back.update[0].content, /1 events awaiting review/); assert.match(back.update[0].content, /Remaining event/);
  assert.equal(store.listEvents(f.guildId).length, 0);
});

test('Add uses timezone selection and preserves blank/named all-day timezone behavior', async () => {
  for (const timezone of ['', 'Asia/Seoul']) {
    const f = fixture(); const c = candidate(f);
    const review = (await interact(f, `harmony-manager:candidate:review:${c.id}:inbox:0`)).update[0];
    const add = await interact(f, id(review, 'Add to Calendar'));
    const menu = buttons(add.update[0]).find(component => component.type === 3 || component.type === undefined && component.custom_id?.includes('addtimezone'));
    const options = add.update[0].components.flatMap(row => row.components).find(component => component.data.type === 3).toJSON().options;
    assert.ok(options.some(option => option.value === 'Asia/Tokyo'));
    assert.equal(options.some(option => option.value === 'none'), true);
    const selected = await interact(f, menu.custom_id, { select: true, values: [timezone || 'none'] });
    const modal = selected.modal[0].toJSON();
    assert.equal(modal.components.flatMap(row => row.components).some(field => field.custom_id === 'event-timezone'), false);
    const added = await interact(f, modal.custom_id, { modal: true,
      fields: { title: c.title, 'event-date': '2026-12-01' },
    });
    assert.equal(added.reply.length, 0); assert.match(added.update[0].content, /Added/);
    const decided = store.getCalendarCandidate(f.guildId, c.id);
    assert.equal(decided.status, 'added');
    const event = store.getEvent(f.guildId, decided.calendar_event_id);
    assert.equal(event.event_at, null); assert.equal(event.event_timezone, timezone || null);
    assert.match(added.update[0].content, new RegExp(`Event #${c.id} \\u2022 Added`));
    const back = await interact(f, id(added.update[0], 'Back to Discovered Events'));
    assert.match(back.update[0].content, /0 events awaiting review/);
  }
});

test('timed discovered events require a selected valid timezone and persist Asia/Tokyo', async () => {
  const f = fixture();
  const c = candidate(f, 'Tokyo show', {
    sourceMetadata: JSON.stringify({ allDay: false }),
    proposedEventAt: '2026-11-07T08:00:00.000Z', proposedEventTimezone: 'Asia/Tokyo',
  });
  const review = (await interact(f, `harmony-manager:candidate:review:${c.id}:inbox:0`)).update[0];
  const add = await interact(f, id(review, 'Add to Calendar'));
  const menu = buttons(add.update[0]).find(component => component.type === 3 || component.type === undefined && component.custom_id?.includes('addtimezone'));
  const options = add.update[0].components.flatMap(row => row.components).find(component => component.data.type === 3).toJSON().options;
  assert.ok(options.find(option => option.value === 'Asia/Tokyo').default);
  assert.equal(options.some(option => option.value === 'none'), false);
  const selected = await interact(f, menu.custom_id, { select: true, values: ['Asia/Tokyo'] });
  const modal = selected.modal[0].toJSON();
  const invalid = await interact(f, modal.custom_id.replace(':tz:Asia%2FTokyo', ':tz:none'), { modal: true,
    fields: { title: c.title, 'event-date': '2026-11-07', 'event-time': '17:00' },
  });
  assert.match(invalid.reply[0].content, /selected timezone/);
  assert.equal(store.getCalendarCandidate(f.guildId, c.id).status, 'open');
  const valid = await interact(f, modal.custom_id, { modal: true,
    fields: { title: c.title, 'event-date': '2026-11-07', 'event-time': '17:00' },
  });
  assert.match(valid.update[0].content, new RegExp(`Event #${c.id} \\u2022 Added`));
  const decided = store.getCalendarCandidate(f.guildId, c.id);
  const event = store.getEvent(f.guildId, decided.calendar_event_id);
  assert.equal(event.event_timezone, 'Asia/Tokyo');
  assert.equal(event.timezone, 'Asia/Tokyo');
  assert.equal(event.event_at, '2026-11-07T08:00:00.000Z');
  const preview = buildCalendarMessages('stray_kids', '2026-11', [event])[0].embeds[0].description;
  const timestamp = Number(preview.match(/<t:(\d+):t>/)[1]);
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(timestamp * 1000)), '3:00 AM EST');
});

function calendarEvent(f, title, link) {
  return store.createCalendarEvent({ guildId: f.guildId, title, link,
    calendarType: 'stray_kids', category: 'other', allDay: true,
    timezone: 'Asia/Seoul', eventTimezone: 'Asia/Seoul', eventDate: '2026-12-01', createdBy: 'admin',
  });
}
test('Link Existing uses current review matching and preserves inbox context', async () => {
  for (const multiple of [false, true]) {
    const f = fixture(); const c = candidate(f, 'Matching event');
    const eventId = calendarEvent(f, c.title, c.source_url);
    if (multiple) calendarEvent(f, c.title, 'https://official.example/other');
    const review = (await interact(f, `harmony-manager:candidate:review:${c.id}:inbox:0`)).update[0];
    let linked = await interact(f, id(review, 'Link Existing'));
    if (multiple) {
      const menu = buttons(linked.update[0]).find(b => b.type === 3 || b.custom_id?.includes('linkselect'));
      assert.ok(menu.custom_id.endsWith(':inbox:0'));
      assert.ok(id(linked.update[0], 'Back to Discovered Events'));
      linked = await interact(f, menu.custom_id, { select: true, values: [String(eventId)] });
    }
    assert.match(linked.update[0].content, /Linked/);
    assert.ok(id(linked.update[0], 'Back to Discovered Events'));
    assert.equal(store.getCalendarCandidate(f.guildId, c.id).status, 'linked');
    assert.equal(store.getCalendarCandidate(f.guildId, c.id).calendar_event_id, eventId);
  }
});

test('multiple newly discovered and already-known records never create per-candidate messages', async () => {
  const f = fixture();
  const records = [1, 2, 3].map(n => ({ id: `inbox-${n}`, title: `Discovered ${n}`, category: 'SHOW', isAllDay: true, scheduledDate: '2026-12-01' }));
  const options = { now: new Date('2026-11-01T00:00:00Z'), fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ schedules: records }) }) };
  const first = await runDiscovery(f.client, options);
  assert.equal(first.results[0].newCount, 3); assert.equal(f.sent.length, 0);
  const repeat = await runDiscovery(f.client, options);
  assert.equal(repeat.results[0].newCount, 0); assert.equal(repeat.results[0].duplicate, 3);
  assert.equal(f.sent.length, 0);
  assert.equal(store.listCalendarCandidates(f.guildId).length, 3);
  assert.match((await open(f)).reply[0].content, /3 events awaiting review/);
});
