const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/stores/eventSchedulerStore");
const calendarCandidateCommand = require("../src/commands/calendarCandidate");
const { handleEventSchedulerInteraction } = require("../src/services/eventSchedulerService");

function permissions() { return { has: () => true }; }

function setupGuild(guildId) {
  const sent = [];
  const channel = {
    id: `reconciliation-${guildId}`,
    guild: null,
    isTextBased: () => true,
    send: async (payload) => { const message = { id: `notice-${sent.length + 1}`, ...payload, edit: async (next) => Object.assign(message, next) }; sent.push(message); return message; },
    messages: { fetch: async (id) => sent.find((message) => message.id === id) || null },
  };
  const guild = { id: guildId, channels: { cache: new Map([[channel.id, channel]]), fetch: async (id) => channel.id === id ? channel : null }, members: { me: {} } };
  channel.guild = guild;
  const client = { guilds: { cache: new Map([[guildId, guild]]), fetch: async () => guild } };
  store.setReconciliationChannel(guildId, channel.id);
  return { guild, client, channel, sent };
}

function managerInteraction(guildId, client, customId, overrides = {}) {
  const interaction = {
    guildId,
    client,
    user: { id: `admin-${guildId}` },
    memberPermissions: permissions(),
    customId,
    isButton: () => overrides.kind === "button",
    isStringSelectMenu: () => overrides.kind === "select",
    isModalSubmit: () => overrides.kind === "modal",
    values: overrides.values || [],
    fields: { getTextInputValue: (id) => (overrides.fields || {})[id] || "" },
    reply: async (payload) => { interaction.replyPayload = payload; },
    update: async (payload) => { interaction.updatePayload = payload; },
    showModal: async (payload) => { interaction.modal = payload; },
    replied: false,
    deferred: false,
  };
  return interaction;
}

test("candidate submission normalizes and deduplicates source links without creating a calendar event", async () => {
  const guildId = `candidate-submit-${Date.now()}`;
  const { client, sent } = setupGuild(guildId);
  const first = { guildId, sourceUrl: "https://Example.com/event/?utm_source=discord#details", sourceType: "member_submission", submitterId: "member-1", submittedNote: "Please check this." };
  const created = await require("../src/services/eventSchedulerService").submitCalendarCandidate(client, first);
  assert.equal(created.duplicate, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /possible Stray Kids calendar event/);
  assert.equal(store.listEvents(guildId).length, 0);
  const repeated = await require("../src/services/eventSchedulerService").submitCalendarCandidate(client, { ...first, sourceUrl: "https://example.com/event/" });
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.duplicateReason, "same-source");
  assert.equal(sent.length, 1);
});

test("candidate deduplication recognizes an already-approved canonical source", () => {
  const guildId = `candidate-approved-${Date.now()}`;
  store.createCalendarEvent({ guildId, calendarChannelId: null, title: "Already approved", link: "https://official.example/approved?utm_campaign=old", timezone: "America/New_York", eventDate: "2026-12-02", eventTimezone: "America/New_York", calendarType: "stray_kids", category: "other", allDay: true, createdBy: "admin" });
  const duplicate = store.createOrGetCalendarCandidate({ guildId, sourceUrl: "https://OFFICIAL.example/approved/" });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.duplicateReason, "already-calendar");
});

test("member and admin use the same simple candidate submission command", async () => {
  const guildId = `candidate-command-${Date.now()}`;
  const { client, sent } = setupGuild(guildId);
  let response;
  const interaction = {
    guildId,
    client,
    user: { id: "member" },
    options: { getString: (name) => name === "link" ? "https://official.example/skz-event" : "context" },
    deferReply: async () => {},
    editReply: async (content) => { response = content; },
  };
  await calendarCandidateCommand.execute(interaction);
  assert.match(response, /sent the possible event/);
  assert.equal(sent.length, 1);
  let adminResponse;
  await calendarCandidateCommand.execute({
    ...interaction,
    user: { id: "admin" },
    memberPermissions: { has: () => true },
    options: { getString: (name) => name === "link" ? "https://official.example/admin-event" : "admin context" },
    editReply: async (content) => { adminResponse = content; },
  });
  assert.match(adminResponse, /sent the possible event/);
  assert.equal(sent.length, 2);
  assert.equal(store.listCalendarCandidates(guildId).find((item) => item.submitter_id === "admin").source_type, "admin_submission");
});

test("candidate review Add to Calendar creates the canonical event only after explicit approval", async () => {
  const guildId = `candidate-add-${Date.now()}`;
  const { client } = setupGuild(guildId);
  const created = store.createOrGetCalendarCandidate({ guildId, sourceUrl: "https://official.example/add", sourceType: "member_submission", submitterId: "member" });
  const candidateId = created.candidate.id;
  assert.equal(store.listEvents(guildId).length, 0);
  const review = managerInteraction(guildId, client, `harmony-manager:candidate:review:${candidateId}`, { kind: "button" });
  await handleEventSchedulerInteraction(review);
  assert.equal(review.replyPayload.flags, 64);
  const add = managerInteraction(guildId, client, `harmony-manager:candidate:add:${candidateId}`, { kind: "button" });
  await handleEventSchedulerInteraction(add);
  assert.equal(add.modal.data.custom_id, `harmony-manager:candidate:addmodal:${candidateId}`);
  const submit = managerInteraction(guildId, client, `harmony-manager:candidate:addmodal:${candidateId}`, {
    kind: "modal",
    fields: { title: "SKZ Fan Event", "event-date": "2026-12-01", "event-time": "19:00", "event-timezone": "America/New_York", description: "Official details" },
  });
  await handleEventSchedulerInteraction(submit);
  assert.equal(store.getCalendarCandidate(guildId, candidateId).status, "added");
  assert.equal(store.getEvent(guildId, store.getCalendarCandidate(guildId, candidateId).calendar_event_id).title, "SKZ Fan Event");
  assert.equal(submit.replyPayload.flags, 64);
});

test("candidate Link Existing is match-aware and atomic", async () => {
  const guildId = `candidate-link-${Date.now()}`;
  const { client } = setupGuild(guildId);
  const eventId = store.createCalendarEvent({ guildId, calendarChannelId: null, title: "SKZ Fan Event", link: "https://official.example/existing", timezone: "America/New_York", eventAt: "2026-12-01T19:00:00.000Z", eventDate: "2026-12-01", eventTimezone: "America/New_York", calendarType: "stray_kids", category: "other", createdBy: "admin" });
  const candidate = store.createOrGetCalendarCandidate({ guildId, title: "SKZ Fan Event", proposedEventDate: "2026-12-01", sourceUrl: "https://official.example/submitted" }).candidate;
  const review = managerInteraction(guildId, client, `harmony-manager:candidate:review:${candidate.id}`, { kind: "button" });
  await handleEventSchedulerInteraction(review);
  assert.match(review.replyPayload.content, /Likely calendar matches/);
  const link = managerInteraction(guildId, client, `harmony-manager:candidate:link:${candidate.id}`, { kind: "button" });
  await handleEventSchedulerInteraction(link);
  assert.match(link.updatePayload.content, /Linked this candidate/);
  assert.equal(store.getCalendarCandidate(guildId, candidate.id).calendar_event_id, eventId);
  const stale = managerInteraction(guildId, client, `harmony-manager:candidate:dismiss:${candidate.id}`, { kind: "button" });
  await handleEventSchedulerInteraction(stale);
  assert.equal(stale.replyPayload.flags, 64);
});

