"use strict";
// Offline review: actual model + topic formatter; no network or production data.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
process.env.HARMONY_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'topic-preview-')), 'fixture.sqlite');
const { buildCountdown } = require('../src/services/concertCountdownModel');
const topics = require('../src/services/concertCountdownTopic');
const config = { guildId: 'offline', city: 'Chicago', venue: 'Soldier Field', timezone: 'America/Chicago', eventIds: [1, 2] };
const event = (id, date) => ({ id, guild_id: 'offline', calendar_type: 'stray_kids', category: 'concert', all_day: 1, event_date: date });
const events = [event(1, '2027-06-18'), event(2, '2027-06-19')];
const cases = [
  ['single', { ...config, eventIds: [1] }, events, '2026-11-25T12:00Z'],
  ['multiple', config, events, '2026-11-25T12:00Z'],
  ['concert-day', config, events, '2027-06-18T05:00Z'],
  ['mixed-states', config, events, '2027-06-19T05:00Z'],
  ['completed', config, events, '2027-06-20T05:00Z'],
  ['twelve-dates', { ...config, eventIds: Array.from({ length: 12 }, (_, i) => i + 1) }, Array.from({ length: 12 }, (_, i) => event(i + 1, '2027-06-' + String(i + 18).padStart(2, '0'))), '2026-11-25T12:00Z'],
];
const previews = cases.map(([name, c, selected, utc]) => {
  const model = buildCountdown(c, selected, new Date(utc));
  const line = topics.format(model), existing = 'Chicago concert chat • Share travel plans and ticket tips.\nPlease keep personal ticket details private.';
  return { name, utc, localDate: model.today, dates: model.panels.map(p => p.date), countdown: line, original: existing, topic: topics.compose(existing, [], line) };
});
const out = path.join(__dirname, '../docs/concert-topic-countdown'); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'previews.json'), JSON.stringify(previews, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'previews.md'), '# Actual channel-topic text\n\nOffline model/formatter output, with preserved example room information.\n\n' + previews.map(p => `## ${p.name}\n\n\`\`\`text\n${p.topic}\n\`\`\`\n`).join('\n'));
console.log('Created six topic previews using production model/formatter code.');
