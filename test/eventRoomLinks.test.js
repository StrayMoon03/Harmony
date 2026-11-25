const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
process.env.HARMONY_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "event-room-links-")), "isolated.sqlite");
const { Collection, ChannelType, MessagePayload, Client } = require("discord.js");
const db = require("../src/db/sqlite"), events = require("../src/stores/eventSchedulerStore");
const store = require("../src/stores/eventRoomLinkStore"), service = require("../src/services/eventRoomLinkService");
const manager = require("../src/services/eventRoomLinkManager");
const scheduler = require("../src/services/eventSchedulerService");
let seq = 1000;
const now = new Date("2030-06-18T13:00:00Z");
function fixture() {
  const guildId = String(++seq), userId = String(++seq), roomId = String(++seq);
  const eventId = events.createCalendarEvent({ guildId, calendarChannelId: "calendar", title: "Our listening party", calendarType: "community", eventDate: "2030-06-18", eventAt: "2030-06-18T23:00:00.000Z", eventEndAt: "2030-06-19T02:00:00.000Z", eventTimezone: "America/New_York", timezone: "America/New_York", eventChannelId: roomId, allDay: false, createdBy: "owner" });
  const messages = new Collection(), calls = { send: 0, fetch: 0, member: 0 };
  const f = { guildId, userId, roomId, eventId, calls, messages, sendError: null, allow: true, bot: false, left: false, historyError: false };
  const room = { id: roomId, guildId, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => f.allow }) };
  const guild = { id: guildId, ownerId: "owner", channels: { fetch: async id => { if (id !== roomId && id !== "corrected-room") throw Error("Unknown room"); return { ...room, id }; } }, roles: { fetch: async () => new Collection() } };
  const member = () => ({ id: userId, guild, user: { id: userId, bot: f.bot } });
  guild.members = { fetch: async () => { calls.member++; if (f.left) throw Object.assign(Error("Unknown Member"), { code: 10007 }); return member(); } };
  const dm = { id: "dm-" + userId, messages: { fetch: async options => {
    calls.fetch++; if (f.historyError) throw Error("History unavailable");
    return new Collection([...messages.values()].filter(m => !options.before || BigInt(m.id) < BigInt(options.before)).sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))).slice(0, options.limit).map(m => [m.id, m]));
  } }, send: async payload => {
    calls.send++;
    if (f.sendError && f.sendError !== "after") throw f.sendError;
    const msg = { id: String(++seq), author: { id: "bot" }, content: payload.content, components: payload.components.map(r => r.toJSON()) };
    messages.set(msg.id, msg); f.lastPayload = payload;
    if (f.sendError === "after") throw Error("Connection lost after send");
    return msg;
  } };
  f.client = { user: { id: "bot" }, guilds: { fetch: async g => { assert.equal(g, guildId); return guild; } }, users: { fetch: async u => { assert.equal(u, userId); return { id: u, createDM: async () => dm }; } } };
  f.guild = guild; f.room = room; f.dm = dm;
  f.event = () => events.getEvent(guildId, eventId);
  f.add = () => store.add(guildId, eventId, [userId], "owner", now);
  f.enqueue = (key = "click-" + guildId) => { f.add(); return store.enqueue(guildId, eventId, [userId], key, "manual", now.toISOString(), now)[0]; };
  return f;
}
test("one clear room button opens the channel rather than the event page, with invisible delivery identity and no mentions", async () => {
  const f = fixture(), id = f.enqueue();
  const result = await service.deliver(f.client, id, { now });
  assert.equal(result.sent, true);
  const p = f.lastPayload;
  assert.match(p.content, /Our listening party/);
  assert.deepEqual(p.allowedMentions, { parse: [] });
  const button = p.components[0].toJSON().components[0];
  assert.equal(button.url, `https://discord.com/channels/${f.guildId}/${f.roomId}`);
  assert.equal(button.label, "Open the Event Room");
  assert.equal(button.id, id);
  assert.equal(p.enforceNonce, true);
  const serialized = MessagePayload.create({ client: new Client({ intents: [] }) }, p).resolveBody();
  assert.equal(serialized.body.components[0].components[0].id, id);
  assert.equal(store.get(id).status, "sent");
  await service.deliver(f.client, id, { now });
  assert.equal(f.calls.send, 1);
});
test("day-of schedules use the event presentation time zone, including adopted UTC events, all-day dates and DST validation", () => {
  const f = fixture();
  assert.equal(service.timing(f.event(), "09:00").due.toISOString(), "2030-06-18T13:00:00.000Z");
  assert.equal(service.timing({ ...f.event(), event_at: "2030-06-19T01:00:00Z", event_timezone: "UTC", timezone: "UTC", discord_event_origin: "adopted" }, "09:00").day, "2030-06-18");
  assert.equal(service.timing({ ...f.event(), all_day: 1, event_date: "2030-06-20" }, "09:00").day, "2030-06-20");
  assert.throws(() => service.timing({ ...f.event(), all_day: 1, event_date: "2030-03-10" }, "02:30"), /valid time/);
});
test("scheduled delivery persists over restart, runs once on the event day and never changes RSVP or existing personal reminders", async () => {
  const f = fixture(); f.add();
  store.configure(f.guildId, f.eventId, { localTime: "09:00" }, "owner", now);
  store.schedule(f.guildId, f.eventId, true);
  service.reconcile(new Date("2030-06-17T13:00Z"));
  const id = store.deliveries(f.guildId, f.eventId)[0].id;
  assert.equal(store.due(new Date("2030-06-18T12:59Z")).some(r => r.id === id), false);
  db.closeDb();
  await service.deliver(f.client, id, { now });
  service.reconcile(now);
  assert.equal(store.get(id).status, "sent");
  assert.equal(store.due(now).some(r => r.id === id), false);
  assert.equal(f.calls.send, 1);
  assert.equal(db.getDb().prepare("SELECT COUNT(*) n FROM discord_event_reminder_schedules").get().n, 0);
});
test("repeated clicks and concurrent workers cannot duplicate a manually requested message", async () => {
  const f = fixture(), id = f.enqueue("same-click");
  assert.equal(f.enqueue("same-click"), id);
  await Promise.all([service.deliver(f.client, id, { now }), service.deliver(f.client, id, { now })]);
  assert.equal(f.calls.send, 1);
});
test("an unknown send outcome is recovered after restart beyond 100 DMs without another send", async () => {
  const f = fixture(), id = f.enqueue(); f.sendError = "after";
  await service.deliver(f.client, id, { now });
  assert.equal(store.get(id).status, "pending");
  const original = f.messages.first().id;
  for (let i = 0; i < 250; i++) { const messageId = String(++seq); f.messages.set(messageId, { id: messageId, author: { id: "member" }, components: [] }); }
  db.closeDb(); f.sendError = null;
  const result = await service.deliver(f.client, id, { now: new Date(now.getTime() + 301000) });
  assert.equal(result.recovered, true);
  assert.equal(store.get(id).message_id, original);
  assert.equal(f.calls.send, 1);
});
test("Discord rate limits survive restart and Retry cannot bypass them", async () => {
  const f = fixture(), id = f.enqueue();
  f.sendError = Object.assign(Error("429"), { status: 429, retry_after: 90 });
  await service.deliver(f.client, id, { now });
  db.closeDb(); f.sendError = null; store.retry(f.guildId, f.eventId);
  assert.equal((await service.deliver(f.client, id, { now })).skipped, true);
  await service.deliver(f.client, id, { now: new Date(now.getTime() + 91000) });
  assert.equal(f.calls.send, 2);
  assert.equal(store.get(id).status, "sent");
});
test("closed DMs report blocked rather than delivered, and repair can retry the same record", async () => {
  const f = fixture(), id = f.enqueue();
  f.sendError = Object.assign(Error("Cannot send messages"), { code: 50007 });
  await service.deliver(f.client, id, { now });
  assert.equal(store.get(id).status, "blocked");
  assert.equal(store.get(id).sent_at, null);
  assert.match(store.get(id).last_error, /DMs are unavailable/);
  f.sendError = null; store.retry(f.guildId, f.eventId);
  await service.deliver(f.client, id, { now });
  assert.equal(store.get(id).status, "sent");
});
test("members who left, bots and people without room access are not sent private room details", async () => {
  for (const reason of ["left", "bot", "allow"]) {
    const f = fixture(), id = f.enqueue(); f[reason] = reason !== "allow";
    await service.deliver(f.client, id, { now });
    assert.equal(f.calls.send, 0);
    assert.equal(store.get(id).status, "blocked");
  }
});
test("cancelled, removed and finished events never send queued messages", async () => {
  for (const mode of ["cancel", "remove", "finished"]) {
    const f = fixture(), id = f.enqueue();
    if (mode === "cancel") events.cancelEvent(f.guildId, f.eventId, "owner");
    if (mode === "remove") store.remove(f.guildId, f.eventId, [f.userId]);
    await service.deliver(f.client, id, { now: mode === "finished" ? new Date("2030-06-20T13:00Z") : now });
    assert.equal(f.calls.send, 0);
    assert.equal(store.get(id).status, "cancelled");
  }
});
test("unsent schedules follow an event reschedule and room change; sent schedules are not rearmed", async () => {
  const f = fixture(); f.add(); store.schedule(f.guildId, f.eventId, true); service.reconcile(now);
  const id = store.deliveries(f.guildId, f.eventId)[0].id;
  events.updateEvent(f.guildId, f.eventId, { event_date: "2030-06-19", event_at: "2030-06-19T23:00:00Z", event_end_at: "2030-06-20T02:00:00Z", event_channel_id: "corrected-room" });
  service.reconcile(now);
  assert.equal(store.get(id).due_at, "2030-06-19T13:00:00.000Z");
  assert.equal((await service.deliver(f.client, id, { now })).skipped, true);
  await service.deliver(f.client, id, { now: new Date("2030-06-19T13:00Z") });
  assert.match(f.lastPayload.components[0].toJSON().components[0].url, /corrected-room$/);
  events.updateEvent(f.guildId, f.eventId, { event_at: "2030-06-20T23:00:00Z", event_end_at: "2030-06-21T02:00:00Z" });
  service.reconcile(new Date("2030-06-20T13:00Z"));
  assert.equal(store.get(id).status, "sent");
  assert.equal(f.calls.send, 1);
});
test("missing event room never falls back to a calendar announcement channel", async () => {
  const f = fixture(); events.updateEvent(f.guildId, f.eventId, { event_channel_id: null });
  await assert.rejects(service.resolveRoom(f.client, f.event()), /Choose the event room/);
  assert.equal(f.calls.send, 0);
});
test("stopping scheduled messages preserves members for Send Now", async () => {
  const f = fixture(); f.add(); store.schedule(f.guildId, f.eventId, true); service.reconcile(now);
  const scheduled = store.deliveries(f.guildId, f.eventId)[0].id;
  store.schedule(f.guildId, f.eventId, false);
  assert.equal(store.get(scheduled).status, "cancelled");
  assert.equal(store.members(f.guildId, f.eventId).length, 1);
  await service.deliver(f.client, f.enqueue(), { now });
  assert.equal(f.calls.send, 1);
});
function ui(f) {
  const base = { guildId: f.guildId, channelId: "private-manager", guild: f.guild, user: { id: "owner" }, memberPermissions: { has: () => false }, client: f.client };
  const s = manager.create(base, "community"); s.event = f.eventId;
  const interaction = (action, extra = {}) => {
    const i = { ...base, customId: `harmony-room-links:${s.token}:${action}`, values: [], ...extra,
      reply: async p => { i.response = p; }, update: async p => { i.response = p; }, editReply: async p => { i.response = p; }, showModal: async p => { i.modal = p; }, deferUpdate: async () => { i.deferred = true; },
    }; return i;
  };
  return { s, i: interaction };
}
test("private manager selects members without RSVP, schedules event-day messages, and sends room links now", async () => {
  const f = fixture(), { s, i } = ui(f);
  const open = i("home", { customId: `harmony-room-links:event:${f.eventId}` });
  await scheduler.handleEventSchedulerInteraction(open);
  assert.equal(open.response.flags, 64);
  const add = i("add", { values: [f.userId] }); await manager.handle(add);
  assert.equal(store.members(f.guildId, f.eventId).length, 1);
  assert.equal(f.calls.send, 0);
  const schedule = i("schedule"); await manager.handle(schedule);
  assert.equal(schedule.modal.toJSON().components.length, 1);
  const save = i("schedule-save", { fields: { getTextInputValue: () => "10:15" } }); await manager.handle(save);
  assert.equal(store.members(f.guildId, f.eventId)[0].scheduled, 1);
  assert.equal(store.settings(f.guildId, f.eventId).local_time, "10:15");
  assert.equal(f.calls.send, 0);
  const snapshot = manager.page(s), sendId = snapshot.components[3].toJSON().components[0].custom_id;
  const send = i("send", { customId: sendId }); await manager.handle(send);
  assert.equal(f.calls.send, 1);
  assert.match(send.response.content, /Confirmed delivered: 1/);
  await manager.handle(i("send", { customId: sendId }));
  assert.equal(f.calls.send, 1);
  assert.equal(events.getEvent(f.guildId, f.eventId).event_channel_id, f.roomId);
});
test("staff authorization, cross-server access, session ownership and expiration are enforced before delivery or enrollment", async () => {
  const f = fixture(), { s, i } = ui(f);
  for (const extra of [{ user: { id: "intruder" } }, { guildId: "other" }, { channelId: "wrong" }, { user: { id: "staff" }, memberPermissions: { has: () => true } }]) {
    const blocked = i("add", { values: [f.userId], ...extra }); await manager.handle(blocked);
    assert.match(blocked.response.content, /Only|expired|someone else/);
  }
  s.expires = 0;
  const expired = i("add", { values: [f.userId] }); await manager.handle(expired);
  assert.match(expired.response.content, /expired/);
  assert.equal(store.members(f.guildId, f.eventId).length, 0);
  assert.equal(f.calls.send, 0);
  const other = fixture();
  const foreign = i("open", { customId: `harmony-room-links:event:${other.eventId}` }); await manager.handle(foreign);
  assert.match(foreign.response.content, /no longer available/);
});
test("authorized event staff can open this feature without broadening other Schedule Manager admin controls", async () => {
  const f = fixture(), { i } = ui(f);
  const staff = i("open", { user: { id: "staff" }, memberPermissions: { has: flag => flag === require("discord.js").PermissionFlagsBits.ManageEvents }, customId: "harmony-room-links:open:community" });
  await scheduler.handleEventSchedulerInteraction(staff);
  assert.equal(staff.response.flags, 64);
  assert.match(staff.response.content, /SEND EVENT ROOM LINKS/);
});
test("manager room correction, removal and scheduling do not alter the calendar event or private reminder preferences", async () => {
  const f = fixture(), { i } = ui(f); f.add();
  const before = f.event();
  await manager.handle(i("room", { values: ["corrected-room"] }));
  assert.equal(store.settings(f.guildId, f.eventId).room_id, "corrected-room");
  await manager.handle(i("schedule"));
  await manager.handle(i("schedule-save", { fields: { getTextInputValue: () => "09:30" } }));
  await manager.handle(i("stop"));
  assert.equal(store.members(f.guildId, f.eventId)[0].scheduled, 0);
  await manager.handle(i("remove", { values: [f.userId] }));
  assert.equal(store.members(f.guildId, f.eventId).length, 0);
  assert.deepEqual(f.event(), before);
});
test("the room link manager supports paginated events and fits Discord's component and modal limits", async () => {
  const f = fixture(), { s } = ui(f);
  for (let n = 0; n < 28; n++) events.createCalendarEvent({ guildId: f.guildId, calendarChannelId: "calendar", title: "Party " + n, calendarType: "community", eventDate: "2030-07-01", eventTimezone: "America/New_York", timezone: "America/New_York", allDay: true, createdBy: "owner" });
  const first = manager.list(s); assert.equal(s.offered.length, 25);
  s.page++; manager.list(s); assert.equal(s.offered.length, 4);
  for (const payload of [first, manager.page(s)]) {
    assert.ok(payload.components.length <= 5);
    for (const row of payload.components) {
      const json = row.toJSON(); assert.ok(json.components.length <= 5);
      for (const c of json.components) if (c.options) assert.ok(c.options.length <= 25);
    }
  }
  for (const type of ["community", "stray_kids"]) {
    const controls = scheduler.managerPanelComponents(type, f.guildId).flatMap(row => row.toJSON().components);
    assert.ok(controls.some(c => c.label === "Send Room Links"));
    assert.ok(scheduler.managerPanelComponents(type, f.guildId).every(row => row.toJSON().components.length <= 5));
  }
});
test("a prepared but unsent scheduled message honors a later reschedule instead of sending on the old day", async () => {
  const f = fixture(); f.add(); store.schedule(f.guildId, f.eventId, true); service.reconcile(now);
  const id = store.deliveries(f.guildId, f.eventId)[0].id;
  f.sendError = Error("Request did not reach Discord"); await service.deliver(f.client, id, { now });
  events.updateEvent(f.guildId, f.eventId, { event_at: "2030-06-20T23:00:00Z", event_date: "2030-06-20", event_end_at: "2030-06-21T02:00:00Z" });
  f.sendError = null;
  const result = await service.deliver(f.client, id, { now: new Date(now.getTime() + 301000) });
  assert.equal(result.deferred, true);
  assert.equal(f.calls.send, 1);
  assert.equal(store.get(id).due_at, "2030-06-20T13:00:00.000Z");
});
test("unavailable recovery history never authorizes another DM", async () => {
  const f = fixture(), id = f.enqueue(); f.sendError = "after";
  await service.deliver(f.client, id, { now });
  f.sendError = null; f.historyError = true;
  await service.deliver(f.client, id, { now: new Date(now.getTime() + 301000) });
  assert.equal(f.calls.send, 1);
  assert.notEqual(store.get(id).status, "sent");
});
test("stale sending leases recover after restart, while active leases exclude another worker", async () => {
  const f = fixture(), id = f.enqueue();
  const token = store.claim(id, now);
  assert.ok(token);
  assert.equal((await service.deliver(f.client, id, { now })).skipped, true);
  db.closeDb();
  await service.deliver(f.client, id, { now: new Date(now.getTime() + 901000) });
  assert.equal(store.get(id).status, "sent");
  assert.equal(f.calls.send, 1);
});
test("additive room-link migrations are idempotent and do not rewrite existing calendar or reminder data", () => {
  const { DatabaseSync } = require("node:sqlite"), { migrateEventRoomLinks } = require("../src/db/eventRoomLinkSchema");
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE sentinel(id TEXT PRIMARY KEY,value TEXT); INSERT INTO sentinel VALUES('calendar','unchanged');");
  migrateEventRoomLinks(database); migrateEventRoomLinks(database);
  assert.equal(database.prepare("SELECT value FROM sentinel").get().value, "unchanged");
  assert.equal(database.prepare("SELECT COUNT(*) n FROM event_room_link_members").get().n, 0);
  database.close();
});
test("confirming the event's current room does not freeze a stale override, and a prior explicit override can be cleared", async () => {
  const f = fixture(), { i } = ui(f);
  store.configure(f.guildId, f.eventId, { roomId: "corrected-room" }, "owner");
  await manager.handle(i("room", { values: [f.roomId] }));
  assert.equal(store.settings(f.guildId, f.eventId).room_id, null);
  events.updateEvent(f.guildId, f.eventId, { event_channel_id: "corrected-room" });
  const result = await service.resolveRoom(f.client, f.event(), store.settings(f.guildId, f.eventId).room_id);
  assert.equal(result.room.id, "corrected-room");
});
test("busy private status pages stay below Discord content limits while preserving action controls", () => {
  const f = fixture(), { s } = ui(f);
  const ids = Array.from({ length: 25 }, (_, n) => "long-member-" + n);
  store.add(f.guildId, f.eventId, ids, "owner");
  const jobs = store.enqueue(f.guildId, f.eventId, ids, "many-failures", "manual", now.toISOString(), now);
  for (const id of jobs.slice(0, 4)) {
    const token = store.claim(id, now);
    store.update(id, token, { status: "blocked", last_error: "Long delivery error ".repeat(25) });
    store.release(id, token);
  }
  const view = manager.page(s);
  assert.ok(view.content.length <= 1900);
  assert.equal(view.components.length, 5);
});
test("a crash after Discord accepts a DM but before its success checkpoint recovers the original message", async () => {
  const f = fixture(), id = f.enqueue(), update = store.update;
  let interrupted = false;
  store.update = (row, token, fields) => {
    if (!interrupted && fields.status === "sent") { interrupted = true; throw Error("Interrupted checkpoint"); }
    return update(row, token, fields);
  };
  try { await service.deliver(f.client, id, { now }); } finally { store.update = update; }
  db.closeDb();
  const result = await service.deliver(f.client, id, { now: new Date(now.getTime() + 301000) });
  assert.equal(result.recovered, true);
  assert.equal(f.calls.send, 1);
  assert.equal(store.get(id).status, "sent");
});
test("saving a schedule targets the reviewed members, not someone added while the time form was open", async () => {
  const f = fixture(), { i } = ui(f); f.add();
  await manager.handle(i("schedule"));
  store.add(f.guildId, f.eventId, ["later-member"], "another-admin");
  await manager.handle(i("schedule-save", { fields: { getTextInputValue: () => "09:00" } }));
  assert.equal(store.members(f.guildId, f.eventId).find(m => m.user_id === f.userId).scheduled, 1);
  assert.equal(store.members(f.guildId, f.eventId).find(m => m.user_id === "later-member").scheduled, 0);
});
test("an event rescheduled to a different day while the schedule form is open requires review again", async () => {
  const f = fixture(), { i } = ui(f); f.add();
  await manager.handle(i("schedule"));
  events.updateEvent(f.guildId, f.eventId, { event_at: "2030-06-20T23:00:00Z", event_date: "2030-06-20" });
  const save = i("schedule-save", { fields: { getTextInputValue: () => "09:00" } });
  await manager.handle(save);
  assert.match(save.response.content, /settings changed/);
  assert.equal(store.members(f.guildId, f.eventId)[0].scheduled, 0);
});
