const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/stores/eventSchedulerStore");
const calendarCandidateCommand = require("../src/commands/calendarCandidate");
const { handleEventSchedulerInteraction } = require("../src/services/eventSchedulerService");
const { extractCandidateMetadata } = require("../src/services/calendarCandidateEnrichment");

global.fetch = async () => ({ ok: true, status: 200, text: async () => "<title>Test source</title>" });

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

test("submitted URL enrichment stores structured event metadata without creating calendar or announcements", async () => {
  const guildId = `candidate-enrich-${Date.now()}`;
  const { client, sent } = setupGuild(guildId);
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => `
    <meta property="og:title" content="Stray Kids Fan Meeting">
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "Event", name: "Stray Kids Fan Meeting",
      startDate: "2026-12-01T19:00:00-05:00", eventSchedule: { scheduleTimezone: "America/New_York" },
    })}</script>` });
  try {
    const result = await require("../src/services/eventSchedulerService").submitCalendarCandidate(client, { guildId, sourceUrl: "https://official.example/fan-meeting", sourceType: "member_submission", submitterId: "member" });
    assert.equal(result.duplicate, false);
    const candidate = store.getCalendarCandidate(guildId, result.candidate.id);
    assert.equal(candidate.title, "Stray Kids Fan Meeting");
    assert.equal(candidate.proposed_event_date, "2026-12-01");
    assert.equal(candidate.proposed_event_timezone, "America/New_York");
    assert.equal(candidate.source_provider, "official.example");
    assert.equal(candidate.source_metadata, "json-ld-event");
    assert.equal(store.listEvents(guildId).length, 0);
    assert.equal(store.listAnnouncements(result.candidate.id).length, 0);
    assert.match(sent[0].content, /Stray Kids Fan Meeting/);
  } finally { global.fetch = originalFetch; }
});

test("candidate Add to Calendar prefills extracted local date, time, and timezone", async () => {
  const guildId = `candidate-prefill-${Date.now()}`;
  const { client } = setupGuild(guildId);
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => `<script type="application/ld+json">${JSON.stringify({
    "@type": "Event", name: "Timezone Test", startDate: "2026-12-01T19:00:00-05:00", eventSchedule: { scheduleTimezone: "America/New_York" },
  })}</script>` });
  try {
    const result = await require("../src/services/eventSchedulerService").submitCalendarCandidate(client, { guildId, sourceUrl: "https://official.example/timezone-test", sourceType: "member_submission", submitterId: "member" });
    const candidate = store.getCalendarCandidate(guildId, result.candidate.id);
    assert.equal(candidate.proposed_event_at, "2026-12-02T00:00:00.000Z");
    assert.equal(candidate.proposed_event_date, "2026-12-01");
    assert.equal(candidate.proposed_event_timezone, "America/New_York");

    const review = managerInteraction(guildId, client, `harmony-manager:candidate:review:${candidate.id}`, { kind: "button" });
    await handleEventSchedulerInteraction(review);
    const add = managerInteraction(guildId, client, `harmony-manager:candidate:add:${candidate.id}`, { kind: "button" });
    await handleEventSchedulerInteraction(add);
    const values = Object.fromEntries(add.modal.components.map((row) => [row.components[0].data.custom_id, row.components[0].data.value || ""]));
    assert.equal(values.title, "Timezone Test");
    assert.equal(values["event-date"], "2026-12-01");
    assert.equal(values["event-time"], "19:00");
    assert.equal(values["event-timezone"], "America/New_York");
  } finally { global.fetch = originalFetch; }
});

test("candidate Add to Calendar leaves time blank without a trustworthy extracted timezone", async () => {
  const guildId = `candidate-prefill-blank-${Date.now()}`;
  const { client } = setupGuild(guildId);
  const candidate = store.createOrGetCalendarCandidate({
    guildId, title: "Date Only", proposedEventDate: "2026-12-01", sourceUrl: "https://official.example/date-only",
  }).candidate;
  const add = managerInteraction(guildId, client, `harmony-manager:candidate:add:${candidate.id}`, { kind: "button" });
  await handleEventSchedulerInteraction(add);
  const values = Object.fromEntries(add.modal.components.map((row) => [row.components[0].data.custom_id, row.components[0].data.value || ""]));
  assert.equal(values["event-date"], "2026-12-01");
  assert.equal(values["event-time"], "");
});

test("enrichment failure saves a candidate and leaves unsupported date/time missing", async () => {
  const guildId = `candidate-enrich-fail-${Date.now()}`;
  const { client } = setupGuild(guildId);
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("unavailable"); };
  try {
    const result = await require("../src/services/eventSchedulerService").submitCalendarCandidate(client, { guildId, sourceUrl: "https://official.example/unavailable", sourceType: "member_submission" });
    const candidate = store.getCalendarCandidate(guildId, result.candidate.id);
    assert.equal(candidate.title, null);
    assert.equal(candidate.proposed_event_date, null);
    assert.equal(candidate.proposed_event_at, null);
    assert.equal(candidate.status, "open");
  } finally { global.fetch = originalFetch; }
});

test("metadata extraction does not invent a time from a date-only source", () => {
  const metadata = extractCandidateMetadata(`<script type="application/ld+json">${JSON.stringify({ "@type": "Event", name: "Date Only Event", startDate: "2026-12-01" })}</script>`, "https://official.example/date-only");
  assert.equal(metadata.proposedEventDate, "2026-12-01");
  assert.equal(metadata.proposedEventAt, null);
  assert.equal(metadata.proposedEventTimezone, null);
});

test("candidate matching requires supporting identity and does not match by date alone", () => {
  const guildId = `candidate-match-${Date.now()}`;
  const sameDate = store.createCalendarEvent({ guildId, calendarChannelId: null, title: "Unrelated livestream", link: "https://official.example/other", timezone: "America/New_York", eventDate: "2026-12-01", eventTimezone: "America/New_York", calendarType: "stray_kids", category: "other", allDay: true, createdBy: "admin" });
  const candidate = store.createOrGetCalendarCandidate({ guildId, title: "Stray Kids Fan Meeting", proposedEventDate: "2026-12-01", sourceUrl: "https://official.example/fan-meeting" }).candidate;
  assert.deepEqual(store.findCandidateCalendarMatches(guildId, candidate), []);
  const legitimate = store.createCalendarEvent({ guildId, calendarChannelId: null, title: "Stray Kids Fan Meeting", link: "https://official.example/fan-meeting", timezone: "America/New_York", eventAt: "2026-12-01T19:00:00.000Z", eventDate: "2026-12-01", eventTimezone: "America/New_York", calendarType: "stray_kids", category: "other", allDay: false, createdBy: "admin" });
  assert.deepEqual(store.findCandidateCalendarMatches(guildId, candidate).map((event) => event.id), [legitimate]);
  assert.ok(sameDate);
});
