"use strict";
// Offline integration evidence: real store, scheduler, renderer; mock Discord only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
process.env.HARMONY_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'midnight-evidence-')), 'fixture.sqlite');
const { Collection, ChannelType } = require('discord.js');
const tour = require('../src/services/concertTourCalendar'), store = require('../src/stores/concertCountdownStore');
const service = require('../src/services/concertCountdownService'), rooms = require('../src/stores/adminRoomStore');
const manager = require('../src/services/concertCountdownManager');
const out = path.join(__dirname, '../docs/countdown-midnight-fix');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const evidence = [];
  for (const key of ['toronto', 'vancouver']) {
    const g = `offline-${key}`, c = key === 'toronto' ? '1001' : '1002', l = tour.scopedManifest(key).locations[0];
    const review = tour.audit(g, tour.scopedManifest(key));
    const imported = tour.importConfirmed(g, tour.scopedManifest(key), review.fingerprint, 'fixture-owner');
    store.save(g, c, { guildId: g, city: l.city, country: l.country, venue: l.venue, timezone: l.timezone, eventIds: imported.eventIds });
    const roles = new Collection([[g, { id: g }]]), guild = { id: g };
    guild.roles = { cache: roles, fetch: async () => roles };
    guild.members = { fetchMe: async () => ({ id: 'bot', guild, roles: { cache: roles } }) };
    let message, edits = 0, sends = 0, pins = 0, stage = 'before';
    const accept = p => { fs.writeFileSync(path.join(out, `${key}-${stage}.png`), p.files[0].attachment); return p; };
    const channel = { id: c, guildId: g, type: ChannelType.GuildText, name: key, overwritesFor: () => ({ roles: [] }), permissionsFor: () => ({ has: () => true }),
      messages: { fetch: async o => o.message ? message : new Collection(), fetchPins: async () => ({ items: message?.pinned ? [{ message, pinnedAt: new Date() }] : [], hasMore: false }) },
      send: async p => { sends++; accept(p); message = { id: `saved-${key}`, channelId: c, author: { id: 'bot' }, content: '', attachments: new Collection([['file', { name: p.files[0].name }]]), pinned: false,
        edit: async p => { edits++; accept(p); return message; }, pin: async () => { pins++; message.pinned = true; } }; return message; },
    };
    guild.channels = { fetch: async () => channel };
    const client = { user: { id: 'bot' }, guilds: { cache: new Map([[g, guild]]) } };
    // The night before the earliest selected concert: two days becomes tomorrow.
    const targetDay = new Date(Date.parse(l.dates[0].date + 'T12:00Z') - 86400000).toISOString().slice(0, 10);
    const { nextMidnight, localDate } = require('../src/services/concertCountdownModel');
    const probe = new Date(targetDay + 'T00:00:00Z');
    const midnight = nextMidnight(probe, l.timezone), before = new Date(midnight - 1);
    await service.refresh(client, g, c, { publish: true, now: before });
    store.update(g, c, { enabled: 1 }); const saved = store.get(g, c);
    stage = 'after'; const result = await service.runUpdates(client, { now: midnight });
    const after = store.get(g, c);
    for (const field of ['config', 'message_id', 'published_at', 'enabled', 'revision', 'photo', 'photo_type']) require('node:assert/strict').deepEqual(after[field], saved[field]);
    evidence.push({ city: l.city, timezone: l.timezone, before: { utc: before.toISOString(), localDate: localDate(before, l.timezone), days: service.model(saved, before).panels.map(p => p.days) }, after: { utc: midnight.toISOString(), localDate: localDate(midnight, l.timezone), days: service.model(after, midnight).panels.map(p => p.days), lastSuccess: after.last_success }, result, messageId: after.message_id, sends, edits, pins, pinned: message.pinned, nextUpdate: service.nextUpdate(after, midnight).toISOString() });
    store.update(g, c, { enabled: 0 }); // Isolate the next fixture server.
  }
  const base = { guildId: 'offline-picker', channelId: 'private', user: { id: 'fixture-owner' } };
  const session = manager.createSession(base);
  fs.writeFileSync(path.join(out, 'picker-payload.json'), JSON.stringify(manager.concertPicker(session), null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'midnight-evidence.json'), JSON.stringify({ mode: 'Offline integration, not live Discord', node: process.version, tzdata: process.versions.tz, evidence }, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  require('../src/db/sqlite').closeDb();
})().catch(e => { console.error(e); process.exitCode = 1; });
