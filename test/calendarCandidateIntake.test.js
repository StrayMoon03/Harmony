const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/stores/eventSchedulerStore");
const calendarCandidateCommand = require("../src/commands/calendarCandidate");
const { handleEventSchedulerInteraction } = require("../src/services/eventSchedulerService");
const { extractCandidateMetadata, enrichCalendarCandidate, parseTextDates } = require("../src/services/calendarCandidateEnrichment");

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

test("social title date range extracts the live Instagram dates and KST without inventing a time", () => {
  const metadata = extractCandidateMetadata(
    `<title>Stray Kids on Instagram: ODD&amp;FRESH 26.10.22 THU – 11.08 SUN (KST)</title>`,
    "https://www.instagram.com/p/DeOPfnHzVKh/",
  );
  assert.equal(metadata.proposedEventDate, "2026-10-22");
  assert.equal(metadata.proposedEventEndDate, "2026-11-08");
  assert.equal(metadata.proposedEventTimezone, "Asia/Seoul");
  assert.equal(metadata.proposedEventAt, null);
});

test("candidate storage and private review preserve extracted date range and timezone", async () => {
  const guildId = `candidate-range-${Date.now()}`;
  const { client } = setupGuild(guildId);
  const candidate = store.createOrGetCalendarCandidate({
    guildId, title: "ODD&FRESH POP-UP", proposedEventDate: "2026-10-22", proposedEventEndDate: "2026-11-08", proposedEventTimezone: "Asia/Seoul", sourceUrl: "https://official.example/popup",
  }).candidate;
  const review = managerInteraction(guildId, client, `harmony-manager:candidate:review:${candidate.id}`, { kind: "button" });
  await handleEventSchedulerInteraction(review);
  assert.match(review.replyPayload.content, /Harmony extracted start date: 2026-10-22/);
  assert.match(review.replyPayload.content, /Harmony extracted end date: 2026-11-08/);
  assert.match(review.replyPayload.content, /Harmony extracted timezone: Asia\/Seoul/);
  assert.match(review.replyPayload.content, /Event time: Not provided/);
});

test("social parser supports Korean-style single dates and cross-year ranges", () => {
  assert.deepEqual(parseTextDates("Event 2026.10.22 THU"), { proposedEventDate: "2026-10-22" });
  assert.deepEqual(parseTextDates("Pop-up 2026.12.31 THU – 01.02 SAT (KST)"), { proposedEventDate: "2026-12-31", proposedEventEndDate: "2027-01-02" });
  assert.deepEqual(parseTextDates("Event 10.22"), {});
  assert.deepEqual(parseTextDates("Event 10.22 THU"), {});
  assert.deepEqual(parseTextDates("Event 10/22 THU"), {});
});

test("weekday disagreement degrades conservatively", () => {
  assert.deepEqual(parseTextDates("Event 2026.10.22 FRI"), {});
  assert.deepEqual(parseTextDates("Event 2026.10.22 THU – 11.08 MON"), {});
});

test("JSON-LD date and endDate remain authoritative and preserve existing behavior", () => {
  const metadata = extractCandidateMetadata(`<script type="application/ld+json">${JSON.stringify({
    "@type": "Event", name: "Structured Event", startDate: "2026-12-01T19:00:00-05:00", endDate: "2026-12-02", eventSchedule: { scheduleTimezone: "America/New_York" },
  })}</script>`, "https://official.example/structured");
  assert.equal(metadata.proposedEventDate, "2026-12-01");
  assert.equal(metadata.proposedEventEndDate, "2026-12-02");
  assert.equal(metadata.proposedEventAt, "2026-12-02T00:00:00.000Z");
  assert.equal(metadata.proposedEventTimezone, "America/New_York");
  const aliased = extractCandidateMetadata(`<script type="application/ld+json">${JSON.stringify({ "@type": "Event", name: "KST Event", startDate: "2026-12-01", eventSchedule: { scheduleTimezone: "KST" } })}</script>`, "https://official.example/kst");
  assert.equal(aliased.proposedEventTimezone, "Asia/Seoul");
});

test("enrichment blocks private destinations and redirects to them", async () => {
  const privateResult = await enrichCalendarCandidate("http://127.0.0.1/event", { fetchImpl: async () => ({ ok: true, status: 200, text: async () => "ignored" }) });
  assert.equal(privateResult.error, "blocked-destination");
  let redirectCalls = 0;
  const redirectResult = await enrichCalendarCandidate("https://public.example/event", {
    fetchImpl: async () => {
      redirectCalls += 1;
      return redirectCalls === 1
        ? { ok: false, status: 302, headers: { get: () => "http://[::1]/metadata" } }
        : { ok: true, status: 200, text: async () => "not reached" };
    },
    lookupImpl: async () => [{ address: "8.8.8.8", family: 4 }],
  });
  assert.equal(redirectResult.error, "blocked-destination");
});

test("enrichment rejects IPv6 loopback, private, and link-local literals", async () => {
  for (const address of ["::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1"]) {
    const result = await enrichCalendarCandidate(`http://[${address}]/event`, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => "not reached" }) });
    assert.equal(result.error, "blocked-destination", address);
  }
});

test("enrichment rejects DNS names resolving to prohibited addresses", async () => {
  const result = await enrichCalendarCandidate("https://attacker.example/event", {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "not reached" }),
    lookupImpl: async () => [{ address: "192.168.1.20", family: 4 }],
  });
  assert.equal(result.error, "blocked-destination");
});

test("enrichment stops an oversized streamed response before loading it fully", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1_500_000);
  const result = await enrichCalendarCandidate("https://official.example/large", {
    fetchImpl: async () => ({
      ok: true, status: 200,
      body: { getReader: () => ({
        reads: 0,
        async read() { this.reads += 1; return this.reads === 1 ? { done: false, value: chunk } : { done: false, value: chunk }; },
        async cancel() { cancelled = true; }, releaseLock() {},
      }) },
    }),
  });
  assert.equal(result.error, "response-too-large");
  assert.equal(cancelled, true);
});

test("discovered all-day candidate is compact, reviewed in-place, and preserves source metadata", async () => {
  const guildId = `discovery-compact-${Date.now()}`;
  const { client, sent } = setupGuild(guildId);
  const sourceUrl = "https://straykids.jype.com/schedule?scheduledId=9260";
  const metadata = JSON.stringify({
    allDay: true, scheduledDate: "2026-10-24",
    scheduledAt: "2026-10-24T00:00:00+09:00", explicitOffset: "+09:00", timezone: null,
  });
  const { submitCalendarCandidate } = require("../src/services/eventSchedulerService");
  const result = await submitCalendarCandidate(client, {
    guildId, sourceUrl, skipEnrichment: true,
    sourceType: "discovery", sourceProvider: "jype-straykids-schedule",
    discoveryKey: "jype-straykids-schedule:10:9260",
    sourceMetadata: metadata, title: "Stray Kids World Tour <RUN IT> FUKUOKA",
    proposedEventDate: "2026-10-24", proposedEventAt: null,
  });
  const candidate = result.candidate;
  assert.equal(sent.length, 0);
  assert.equal(result.noticeSent, false);
  assert.equal(store.getCalendarCandidate(guildId, candidate.id).source_url, sourceUrl);
  assert.equal(store.getCalendarCandidate(guildId, candidate.id).source_metadata, metadata);
  const review = managerInteraction(guildId, client, `harmony-manager:candidate:review:${candidate.id}`, { kind: "button" });
  await handleEventSchedulerInteraction(review);
  assert.equal(review.replyPayload, undefined);
  assert.match(review.updatePayload.content, /All-day: Yes/);
  assert.doesNotMatch(review.updatePayload.content, /Still missing: event time/);
  assert.doesNotMatch(review.updatePayload.content, /Event time: 00:00/);
  assert.match(review.updatePayload.content, /Still missing: nothing obvious/);
  assert.ok(review.updatePayload.components.some(row => row.components.some(button => button.data?.label === "Add to Calendar")));
  assert.ok(review.updatePayload.components.some(row => row.components.some(button => button.data?.label === "Dismiss")));
  assert.ok(review.updatePayload.components.some(row => row.components.some(button => button.data?.label === "Official Source")));
  assert.equal(store.listEvents(guildId).length, 0);
  assert.equal(store.getCalendarCandidate(guildId, candidate.id).status, "open");
  const dismiss = managerInteraction(guildId, client, `harmony-manager:candidate:dismiss:${candidate.id}`, { kind: "button" });
  await handleEventSchedulerInteraction(dismiss);
  assert.match(dismiss.updatePayload.content, /Ignored/);
  assert.deepEqual(dismiss.updatePayload.components, []);
  const stale = managerInteraction(guildId, client, `harmony-manager:candidate:dismiss:${candidate.id}`, { kind: "button" });
  await handleEventSchedulerInteraction(stale);
  assert.match(stale.replyPayload.content, /already been reviewed/);
  assert.equal(store.listEvents(guildId).length, 0);
});

test("normal timed candidate still uses ephemeral review and reports missing time", async () => {
  const guildId = `timed-unchanged-${Date.now()}`;
  const { client } = setupGuild(guildId);
  const candidate = store.createOrGetCalendarCandidate({
    guildId, sourceUrl: "https://official.example/timed", sourceType: "member_submission",
    title: "Timed event", proposedEventDate: "2026-12-10",
  }).candidate;
  const review = managerInteraction(guildId, client, `harmony-manager:candidate:review:${candidate.id}`, { kind: "button" });
  await handleEventSchedulerInteraction(review);
  assert.equal(review.replyPayload.flags, 64);
  assert.match(review.replyPayload.content, /Still missing: event time/);
  assert.equal(review.updatePayload, undefined);
});

function timezoneCandidate(guildId, overrides = {}) {
  return store.createOrGetCalendarCandidate({
    guildId, sourceUrl: `https://official.example/${guildId}`,
    sourceType: "discovery", sourceProvider: "jype-straykids-schedule",
    discoveryKey: `test:${guildId}`,
    sourceMetadata: JSON.stringify({ allDay: true, explicitOffset: "+09:00", timezone: null }),
    title: "All-day test", proposedEventDate: "2026-12-10",
    ...overrides,
  }).candidate;
}

async function timezoneModal(guildId, client, candidate) {
  const add = managerInteraction(guildId, client, `harmony-manager:candidate:add:${candidate.id}`, { kind: "button" });
  await handleEventSchedulerInteraction(add);
  return Object.fromEntries(add.modal.components.map(row => [row.components[0].data.custom_id, row.components[0].data]));
}

async function timezoneSubmit(guildId, client, candidate, fields = {}) {
  const submit = managerInteraction(guildId, client, `harmony-manager:candidate:addmodal:${candidate.id}`, {
    kind: "modal",
    fields: { title: candidate.title, "event-date": candidate.proposed_event_date, "event-time": "", "event-timezone": "", ...fields },
  });
  await handleEventSchedulerInteraction(submit);
  return submit;
}

test("explicit discovered all-day modal has blank time and optional blank timezone", async () => {
  const guildId = `all-day-modal-${Date.now()}`;
  const { client } = setupGuild(guildId);
  const candidate = timezoneCandidate(guildId);
  const fields = await timezoneModal(guildId, client, candidate);
  assert.equal(fields["event-time"].value || "", "");
  assert.equal(fields["event-timezone"].value || "", "");
  assert.equal(fields["event-timezone"].required, false);
  assert.equal(store.listEvents(guildId).length, 0);
});

test("explicit discovered all-day blank submit preserves null event timezone and legacy fallback", async () => {
  const guildId = `all-day-save-${Date.now()}`;
  const { client } = setupGuild(guildId);
  const candidate = timezoneCandidate(guildId);
  const submit = await timezoneSubmit(guildId, client, candidate);
  assert.match(submit.replyPayload.content, /Added/);
  const saved = store.getCalendarCandidate(guildId, candidate.id);
  const event = store.getEvent(guildId, saved.calendar_event_id);
  assert.equal(saved.status, "added");
  assert.equal(event.all_day, 1);
  assert.equal(event.event_at, null);
  assert.equal(event.event_timezone, null);
  assert.equal(event.timezone, "America/New_York");
  assert.equal(saved.source_metadata, candidate.source_metadata);
  assert.equal(store.listAnnouncements(event.id).length, 0);
});

test("explicit discovered all-day manually supplied named timezone is preserved", async () => {
  const guildId = `all-day-named-${Date.now()}`;
  const { client } = setupGuild(guildId);
  const candidate = timezoneCandidate(guildId);
  await timezoneSubmit(guildId, client, candidate, { "event-timezone": "Asia/Tokyo" });
  const event = store.getEvent(guildId, store.getCalendarCandidate(guildId, candidate.id).calendar_event_id);
  assert.equal(event.event_timezone, "Asia/Tokyo");
  assert.equal(event.timezone, "Asia/Tokyo");
  assert.equal(event.all_day, 1);
  assert.equal(event.event_at, null);
});

test("explicit discovered all-day invalid named timezone and numeric offset are rejected", async () => {
  const guildId = `all-day-invalid-${Date.now()}`;
  const { client } = setupGuild(guildId);
  const candidate = timezoneCandidate(guildId);
  for (const timezone of ["Invalid/Zone", "+09:00"]) {
    const submit = await timezoneSubmit(guildId, client, candidate, { "event-timezone": timezone });
    assert.match(submit.replyPayload.content, /Provide a valid/);
    assert.equal(store.getCalendarCandidate(guildId, candidate.id).status, "open");
    assert.equal(store.listEvents(guildId).length, 0);
  }
});

test("explicit discovered all-day time entered manually still requires timezone", async () => {
  const guildId = `all-day-time-${Date.now()}`;
  const { client } = setupGuild(guildId);
  const candidate = timezoneCandidate(guildId);
  const submit = await timezoneSubmit(guildId, client, candidate, { "event-time": "19:00" });
  assert.match(submit.replyPayload.content, /Provide a valid/);
  assert.equal(store.getCalendarCandidate(guildId, candidate.id).status, "open");
  assert.equal(store.listEvents(guildId).length, 0);
});

test("timed and non-explicit discovery metadata retain required timezone fallback", async () => {
  for (const [index, metadata] of [
    { allDay: false }, { allDay: "true" }, {}, "invalid-json",
  ].entries()) {
    const guildId = `discovery-timezone-regression-${index}-${Date.now()}`;
    const { client } = setupGuild(guildId);
    const candidate = timezoneCandidate(guildId, { sourceMetadata: typeof metadata === "string" ? metadata : JSON.stringify(metadata) });
    const fields = await timezoneModal(guildId, client, candidate);
    assert.equal(fields["event-timezone"].value, "America/New_York");
    assert.equal(fields["event-timezone"].required, true);
    const rejected = await timezoneSubmit(guildId, client, candidate);
    assert.match(rejected.replyPayload.content, /Provide a valid/);
    assert.equal(store.listEvents(guildId).length, 0);
  }
});

test("human and proposed named timezone candidates retain modal and submission behavior", async () => {
  for (const [index, overrides] of [
    { sourceType: "member_submission", discoveryKey: null },
    { proposedEventTimezone: "Asia/Seoul", proposedEventAt: "2026-12-10T10:00:00.000Z" },
    { sourceMetadata: JSON.stringify({ allDay: false }), proposedEventTimezone: "Asia/Tokyo", proposedEventAt: "2026-12-10T10:00:00.000Z" },
  ].entries()) {
    const guildId = `candidate-timezone-regression-${index}-${Date.now()}`;
    const { client } = setupGuild(guildId);
    const candidate = timezoneCandidate(guildId, overrides);
    const fields = await timezoneModal(guildId, client, candidate);
    assert.equal(fields["event-timezone"].value, overrides.proposedEventTimezone || "America/New_York");
    assert.equal(fields["event-timezone"].required, true);
    assert.equal(fields["event-time"].value || "", index === 1 ? "19:00" : index === 2 ? "19:00" : "");
    const rejected = await timezoneSubmit(guildId, client, candidate);
    assert.match(rejected.replyPayload.content, /Provide a valid/);
    await timezoneSubmit(guildId, client, candidate, {
      "event-timezone": fields["event-timezone"].value, "event-time": fields["event-time"].value || "",
    });
    const event = store.getEvent(guildId, store.getCalendarCandidate(guildId, candidate.id).calendar_event_id);
    assert.equal(event.event_timezone, fields["event-timezone"].value);
    assert.equal(event.event_at, overrides.proposedEventAt || null);
  }
});

test("discovered review hides raw metadata while retaining details, matches, source button and storage", async () => {
  const guildId = `review-metadata-${Date.now()}`;
  const { client } = setupGuild(guildId);
  const candidate = timezoneCandidate(guildId, { proposedEventTimezone: "Asia/Tokyo", submittedNote: "Official note" });
  const eventId = store.createCalendarEvent({
    guildId, title: candidate.title, eventDate: candidate.proposed_event_date,
    calendarType: "stray_kids", allDay: true, createdBy: "admin",
  });
  const existingEvent = store.getEvent(guildId, eventId);
  const review = managerInteraction(guildId, client, `harmony-manager:candidate:review:${candidate.id}`, { kind: "button" });
  await handleEventSchedulerInteraction(review);
  const content = review.updatePayload.content;
  for (const detail of [candidate.title, candidate.proposed_event_date, "Asia/Tokyo", "All-day: Yes", "jype-straykids-schedule", "Still missing: nothing obvious", "Official note", `#${eventId}`]) {
    assert.ok(content.includes(detail), detail);
  }
  assert.doesNotMatch(content, /explicitOffset|source_metadata|\+09:00/);
  assert.ok(!content.includes(candidate.source_metadata));
  assert.ok(review.updatePayload.components.some(row => row.components.some(button => button.data.label === "Official Source" && button.data.url === candidate.source_url)));
  assert.equal(store.getCalendarCandidate(guildId, candidate.id).source_metadata, candidate.source_metadata);
  assert.equal(store.getCalendarCandidate(guildId, candidate.id).status, "open");
  assert.deepEqual(store.getEvent(guildId, eventId), existingEvent);
});
