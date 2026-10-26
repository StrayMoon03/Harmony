const test = require("node:test");
const assert = require("node:assert/strict");
const calendarCommand = require("../src/commands/calendarCandidate");
const { handleEventSchedulerInteraction } = require("../src/services/eventSchedulerService");
const store = require("../src/stores/eventSchedulerStore");

function commandInteraction(guildId, subcommand, guild = null) {
  const responses = [];
  return {
    guildId, guild, client: {}, user: { id: "admin" }, memberPermissions: { has: () => true }, responses,
    options: { getSubcommand: () => subcommand },
    reply: async (payload) => responses.push(payload),
    deferReply: async () => {}, editReply: async (payload) => responses.push(payload),
  };
}

function componentInteraction({ customId, guildId, values = [], guild = null, kind = "select" }) {
  const responses = [];
  return {
    customId, guildId, guild, client: {}, values, memberPermissions: { has: () => true }, responses,
    isButton: () => kind === "button", isStringSelectMenu: () => kind === "select", isModalSubmit: () => false,
    reply: async (payload) => responses.push(payload), update: async (payload) => responses.push(payload),
  };
}

test("calendar slash interface exposes review and reconciliation without a manager panel", () => {
  const options = calendarCommand.data.toJSON().options.map((option) => option.name);
  assert.deepEqual(options, ["submit", "discover", "review", "reconcile"]);
});

test("slash candidate review opens the same existing review actions", async () => {
  const guildId = `slash-candidate-review-${Date.now()}`;
  const candidate = store.createOrGetCalendarCandidate({
    guildId, title: "Candidate Event", proposedEventDate: "2099-11-02", sourceUrl: "https://example.test/event", sourceType: "member_submission",
  }).candidate;
  const open = commandInteraction(guildId, "review");
  await calendarCommand.execute(open);
  assert.equal(open.responses[0].flags, 64);
  const picker = open.responses[0].components[0].components[0];
  assert.equal(picker.data.custom_id, "harmony-calendar:review-select");
  assert.equal(picker.toJSON().options[0].value, String(candidate.id));
  const review = componentInteraction({ customId: "harmony-calendar:review-select", guildId, values: [String(candidate.id)] });
  await handleEventSchedulerInteraction(review);
  assert.match(review.responses[0].content, /Potential Stray Kids event/);
  assert.ok(review.responses[0].components.some((row) => row.components.some((button) => button.data.custom_id === `harmony-manager:candidate:add:${candidate.id}`)));
});

test("slash Discord-event reconciliation opens the existing link/add/ignore workflow", async () => {
  const guildId = `slash-native-reconcile-${Date.now()}`;
  const native = {
    id: `${guildId}-event`, guildId, name: "Native Show", scheduledStartAt: new Date("2099-11-03T20:00:00.000Z"),
    scheduledEndAt: new Date("2099-11-03T22:00:00.000Z"), status: 1, creatorId: "organizer",
  };
  const guild = { scheduledEvents: { fetch: async (id) => id ? native : new Map([[native.id, native]]) } };
  const open = commandInteraction(guildId, "reconcile", guild);
  await calendarCommand.execute(open);
  const picker = open.responses[0].components[0].components[0];
  assert.equal(picker.data.custom_id, "harmony-calendar:reconcile-select");
  assert.equal(picker.toJSON().options[0].value, native.id);
  const review = componentInteraction({ customId: "harmony-calendar:reconcile-select", guildId, values: [native.id], guild });
  await handleEventSchedulerInteraction(review);
  assert.match(review.responses[0].content, /native Discord Scheduled Event/);
  assert.ok(review.responses[0].components.some((row) => row.components.some((button) => button.data.custom_id === `harmony-manager:community:nativeadd:${native.id}`)));
  assert.equal(store.getDiscordEventReconciliation(guildId, native.id).status, "open");
});
