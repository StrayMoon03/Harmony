"use strict";
// Actual production builders with isolated fixtures; no Discord or production writes.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
process.env.HARMONY_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recipients-preview-')), 'fixture.sqlite');
const { Collection } = require('discord.js');
const events = require('../src/stores/eventSchedulerStore'), store = require('../src/stores/eventRoomLinkStore');
const manager = require('../src/services/eventRoomLinkManager');
(async () => {
  const guild = { id: 'fixture-server', ownerId: 'fixture-owner' };
  const roster = new Collection();
  const names = ['Alice', 'Barbara', 'Carol', 'Diane', 'Elaine', 'Fran', 'Grace', 'Helen', 'Irene', 'Janet', 'Karen', 'Linda', 'Mary', 'Nancy', 'Patricia', 'Rose', 'Sandra', 'Susan', 'Teresa', 'Valerie', 'Wendy', 'Yvonne', 'Zoe', 'Amy', 'Betty', 'Donna', 'Joan', 'Joyce'];
  names.forEach((name, n) => { const id = String(900000 + n); roster.set(id, { id, guild, displayName: name, user: { id, username: name.toLowerCase() + '_stay', bot: false } }); });
  guild.members = { fetch: async options => options ? roster.get(options.user) : roster };
  const event = events.createCalendarEvent({ guildId: guild.id, calendarChannelId: 'calendar', calendarType: 'community', title: 'Sunday Listening Party', eventDate: '2030-06-23', eventAt: '2030-06-23T23:00:00Z', eventTimezone: 'America/New_York', timezone: 'America/New_York', eventChannelId: 'fixture-room', createdBy: guild.ownerId });
  store.add(guild.id, event, ['900000', '900012', '900017'], guild.ownerId);
  const base = { guildId: guild.id, guild, channelId: 'private', user: { id: guild.ownerId }, memberPermissions: { has: () => false } };
  const session = manager.create(base, 'community'); session.event = event;
  const pages = { main: manager.page(session) };
  const interact = async (action, extra = {}) => {
    let payload;
    const i = { ...base, customId: `harmony-room-links:${session.token}:${action}`, deferUpdate: async () => { i.deferred = true; }, editReply: async p => { payload = p; }, update: async p => { payload = p; }, reply: async p => { payload = p; }, ...extra };
    await manager.handle(i); return payload;
  };
  pages.recipients = await interact('recipients');
  pages.search = await interact('recipients-query', { fields: { getTextInputValue: () => 'Mary' } });
  fs.writeFileSync(path.join(__dirname, '../docs/event-dm-recipients/payloads.json'), JSON.stringify(pages, null, 2) + '\n');
  require('../src/db/sqlite').closeDb();
})();
