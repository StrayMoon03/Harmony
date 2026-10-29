const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChannelType, PermissionFlagsBits } = require("discord.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-admin-room-test-"));
process.env.HARMONY_DB_PATH = path.join(tempDir, "admin-room.sqlite");

const { getDb, closeDb } = require("../src/db/sqlite");
const roomStore = require("../src/stores/adminRoomStore");
const guardStore = require("../src/stores/communityGuardStore");
const room = require("../src/services/adminRoomService");
const { managerPanelComponents } = require("../src/services/eventSchedulerService");

getDb();

function permissionSet(allowed = true) {
  return { has: (permission) => allowed && [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.Administrator].includes(permission) };
}

function createGuild(guildId = "admin-room-guild") {
  const channelsById = new Map();
  const guild = {
    id: guildId,
    ownerId: "owner-id",
    members: { me: { id: "bot-id" } },
    channels: {
      cache: channelsById,
      fetch: async (id) => channelsById.get(id) || null,
    },
  };
  function addChannel(id) {
    const sent = [];
    const channel = {
      id,
      guildId: guild.id,
      type: ChannelType.GuildText,
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => true }),
      messages: { fetch: async (messageId) => sent.find((item) => item.id === messageId) || null },
      send: async (payload) => {
        const message = {
          id: `${id}-message-${sent.length + 1}`,
          channelId: id,
          payload,
          editCalls: [],
          edit: async (next) => { message.editCalls.push(next); message.payload = next; return message; },
        };
        sent.push(message);
        return message;
      },
      sent,
    };
    channelsById.set(id, channel);
    return channel;
  }
  return { guild, addChannel };
}

function client() {
  return { isReady: () => true, user: { id: "bot-id" }, ws: { ping: 25 }, listenerCount: () => 1 };
}

function setupInteraction({ guild, channel, action = "install" }) {
  const output = { deferred: false, edited: null };
  return {
    ...output,
    guild,
    guildId: guild.id,
    user: { id: "admin-id" },
    memberPermissions: permissionSet(true),
    client: client(),
    options: {
      getSubcommand: () => action,
      getChannel: () => channel,
    },
    deferReply: async () => { output.deferred = true; },
    editReply: async (value) => { output.edited = value; return value; },
    get deferred() { return output.deferred; },
    get edited() { return output.edited; },
  };
}

test("Admin Room install, persistence, refresh, move, and off lifecycle", async () => {
  const { guild, addChannel } = createGuild("lifecycle-guild");
  const first = addChannel("room-one");
  const second = addChannel("room-two");

  await room.execute(setupInteraction({ guild, channel: first, action: "install" }));
  let saved = roomStore.getPanel(guild.id);
  assert.equal(saved.channel_id, first.id);
  assert.equal(saved.enabled, 1);
  assert.equal(first.sent.length, 1);
  assert.match(first.sent[0].payload.embeds[0].data.title, /ADMIN CONTROLS/);

  await room.execute(setupInteraction({ guild, action: "refresh" }));
  assert.equal(first.sent[0].editCalls.length, 1);
  assert.equal(roomStore.getEnabledPanels().filter((panel) => panel.guild_id === guild.id).length, 1);
  assert.equal(first.sent.length, 1, "refresh edits the persisted panel instead of posting a duplicate");
  const refreshedControls = first.sent[0].payload.components.flatMap((row) => row.components).map((item) => item.data.custom_id);
  assert.equal(refreshedControls.length, 10);
  assert.equal(new Set(refreshedControls).size, 10);

  await room.execute(setupInteraction({ guild, channel: second, action: "move" }));
  saved = roomStore.getPanel(guild.id);
  assert.equal(saved.channel_id, second.id);
  assert.equal(second.sent.length, 1);
  assert.deepEqual(first.sent[0].editCalls.at(-1).components, []);
  assert.equal(roomStore.getEnabledPanels().filter((panel) => panel.guild_id === guild.id).length, 1);

  await room.execute(setupInteraction({ guild, action: "off" }));
  assert.equal(roomStore.getPanel(guild.id).enabled, 0);
  assert.equal(roomStore.getEnabledPanels().some((panel) => panel.guild_id === guild.id), false);
  assert.deepEqual(second.sent[0].editCalls.at(-1).components, []);
});

test("startup restores a missing panel message at its saved location", async () => {
  const { guild, addChannel } = createGuild("restore-guild");
  const channel = addChannel("saved-room");
  roomStore.savePanel({ guildId: guild.id, channelId: channel.id, messageId: "deleted-panel-message", enabled: true });
  await room.refreshConfiguredAdminRooms({ guilds: { cache: new Map([[guild.id, guild]]) } });
  const saved = roomStore.getPanel(guild.id);
  assert.equal(saved.channel_id, channel.id);
  assert.equal(saved.enabled, 1);
  assert.equal(channel.sent.length, 1);
  assert.notEqual(saved.message_id, "deleted-panel-message");
  assert.equal(roomStore.getEnabledPanels().filter((panel) => panel.guild_id === guild.id).length, 1);
});

test("unauthorized Admin Room component interactions are rejected server-side", async () => {
  let response = null;
  const interaction = {
    customId: "harmony-admin-room:category",
    guild: { id: "auth-guild", ownerId: "owner-id" },
    user: { id: "ordinary-member" },
    memberPermissions: permissionSet(false),
    isStringSelectMenu: () => true,
    values: ["calendar"],
    reply: async (payload) => { response = payload; },
  };
  assert.equal(await room.handleAdminRoomInteraction(interaction), true);
  assert.match(response.content, /authorized server admins/i);
  assert.equal(response.flags, 64);
});

test("the persistent panel exposes direct non-schedule admin controls only", async () => {
  const { guild } = createGuild("direct-controls-guild");
  const payload = await room.buildHomePayload(guild, client());
  const embed = payload.embeds[0].data;
  const controls = payload.components.flatMap((row) => row.components);
  const ids = controls.map((item) => item.data.custom_id);

  assert.match(embed.title, /HARMONY ADMIN CONTROLS/);
  assert.doesNotMatch(JSON.stringify(payload), /Calendar & Events|Open Stray Kids Schedule Manager|Open Youtiful Stays Schedule Manager|Choose an Admin Room section/);
  assert.equal(payload.components.length, 2);
  assert.deepEqual(payload.components.map((row) => row.components.length), [5, 5]);
  assert.equal(new Set(ids).size, ids.length);
  for (const action of ["guard", "guard-history-open", "welcome", "greetings", "members", "collections", "logs", "birthdays", "status", "media"]) {
    assert.ok(ids.includes(`harmony-admin-room:${action}`), `missing direct control for ${action}`);
  }
  assert.ok(ids.every((id) => !/calendar|schedule|category|home/.test(id)));
});

test("authorized controls open the existing Guard, history, Birthday, and community workflows", async () => {
  const { guild } = createGuild("navigation-guild");
  roomStore.savePanel({ guildId: guild.id, channelId: "active-room", messageId: "active-panel", enabled: true });
  const base = {
    guild, guildId: guild.id, channelId: "active-room", message: { id: "active-panel" },
    user: { id: "admin-id" }, memberPermissions: permissionSet(true), client: client(),
    reply: async (payload) => { base.response = payload; },
  };
  await room.handleAdminRoomInteraction({ ...base, customId: "harmony-admin-room:guard" });
  assert.match(base.response.embeds[0].data.title, /Harmony Guard/);
  assert.equal(base.response.flags, 64);

  await room.handleAdminRoomInteraction({ ...base, customId: "harmony-admin-room:guard-history-open" });
  assert.match(base.response.embeds[0].data.title, /History/);
  assert.equal(base.response.flags, 64);

  await room.handleAdminRoomInteraction({ ...base, customId: "harmony-admin-room:birthdays" });
  const birthdayReply = base.response;
  assert.match(birthdayReply.content, /BIRTHDAY MANAGER/);
  assert.equal(birthdayReply.flags, 64);

  await room.handleAdminRoomInteraction({ ...base, customId: "harmony-admin-room:welcome" });
  assert.match(base.response.embeds[0].data.title, /Welcome Pass/);
  for (const [action, title] of [["greetings", "Greetings"], ["members", "Member Counts"], ["collections", "Collections"], ["logs", "Message Logs"], ["media", "Media & System"]]) {
    await room.handleAdminRoomInteraction({ ...base, customId: `harmony-admin-room:${action}` });
    assert.match(base.response.embeds[0].data.title, new RegExp(title));
  }
});

function guardInteraction(guild, customId, extra = {}) {
  const interaction = {
    guild,
    guildId: guild.id,
    channelId: "ephemeral-channel",
    user: { id: "guard-admin" },
    memberPermissions: permissionSet(true),
    client: client(),
    customId,
    values: [],
    response: null,
    update: async (payload) => { interaction.response = payload; return payload; },
    reply: async (payload) => { interaction.response = payload; return payload; },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (payload) => { interaction.response = payload; return payload; },
    showModal: async (modal) => { interaction.modal = modal; },
    ...extra,
  };
  return interaction;
}

test("Guard Manager exposes direct room, monitoring, rules, add/edit/remove, and history controls", async () => {
  const { guild } = createGuild("interactive-guard-controls");
  const payload = await room.guardPage(guild);
  const ids = payload.components.flatMap((row) => row.components).map((component) => component.data.custom_id);
  assert.match(payload.embeds[0].data.description, /Monitoring:\*\* Off/);
  assert.match(payload.embeds[0].data.description, /Review Room:\*\* Not configured/);
  assert.match(payload.embeds[0].data.description, /Active rules:\*\* 0/);
  for (const action of ["guard-room", "guard-toggle", "guard-rules:0", "guard-add", "guard-edit", "guard-remove", "guard-history:0"]) {
    assert.ok(ids.includes(`harmony-admin-room:${action}`), `missing ${action}`);
  }
});

test("Rules control displays configured rules using shared Guard formatting", async () => {
  const { guild } = createGuild("guard-rules-view");
  const id = guardStore.addRule({ guildId: guild.id, type: "phrase", pattern: "Bubble", action: "flag", category: "paid", name: "Paid Bubble sharing" });
  const view = guardInteraction(guild, "harmony-admin-room:guard-rules:0");
  await room.handleAdminRoomInteraction(view);
  assert.match(view.response.embeds[0].data.title, /Guard Rules/);
  assert.match(view.response.embeds[0].data.description, new RegExp(`#${id}.*Paid Bubble sharing`));
  assert.match(view.response.embeds[0].data.description, /Paid content · Admin Review/);
  assert.ok(view.response.components.flatMap((row) => row.components).some((component) => component.data.custom_id === "harmony-admin-room:guard:ephemeral"));
});

test("Guard Review Room selector saves a same-guild text channel and preserves monitoring", async () => {
  const { guild, addChannel } = createGuild("guard-room-select");
  const chosen = addChannel("moderation-review-room");
  guardStore.saveSettings(guild.id, "old-room");
  const open = guardInteraction(guild, "harmony-admin-room:guard-room");
  await room.handleAdminRoomInteraction(open);
  assert.match(open.response.embeds[0].data.title, /Review Room/);
  assert.equal(open.response.components[0].components[0].data.channel_types[0], ChannelType.GuildText);

  const select = guardInteraction(guild, "harmony-admin-room:guard-room-select", { values: [chosen.id] });
  await room.handleAdminRoomInteraction(select);
  assert.equal(guardStore.getSettings(guild.id).channel_id, chosen.id);
  assert.equal(guardStore.getSettings(guild.id).enabled, 1);
  assert.match(select.response.embeds[0].data.description, /Review Room set/);
});

test("Guard monitoring toggles from the manager and cannot turn on without a Review Room", async () => {
  const { guild } = createGuild("guard-toggle");
  const missingRoom = guardInteraction(guild, "harmony-admin-room:guard-toggle");
  await room.handleAdminRoomInteraction(missingRoom);
  assert.match(missingRoom.response.content, /Choose a Guard Review Room/);
  assert.equal(guardStore.getSettings(guild.id), null);

  guardStore.saveSettings(guild.id, "review-room");
  const off = guardInteraction(guild, "harmony-admin-room:guard-toggle");
  await room.handleAdminRoomInteraction(off);
  assert.equal(guardStore.getSettings(guild.id).enabled, 0);
  assert.match(off.response.embeds[0].data.description, /Automatic monitoring is now \*\*Off/);
  const on = guardInteraction(guild, "harmony-admin-room:guard-toggle");
  await room.handleAdminRoomInteraction(on);
  assert.equal(guardStore.getSettings(guild.id).enabled, 1);
});

test("Add Rule wizard uses existing Guard rule service and defaults to Admin Review", async () => {
  const { guild } = createGuild("guard-add-wizard");
  const start = guardInteraction(guild, "harmony-admin-room:guard-add");
  await room.handleAdminRoomInteraction(start);
  assert.match(start.response.embeds[0].data.title, /Add a Rule Condition/);

  const choose = guardInteraction(guild, "harmony-admin-room:guard-condition-type", { values: ["phrase"] });
  await room.handleAdminRoomInteraction(choose);
  assert.match(choose.modal.data.title, /Condition Value/);

  const submitValue = guardInteraction(guild, "harmony-admin-room:guard-condition-value", {
    isModalSubmit: () => true,
    fields: { getTextInputValue: () => "Bubble" },
  });
  await room.handleAdminRoomInteraction(submitValue);
  assert.match(submitValue.response.embeds[0].data.title, /Rule Conditions/);

  const done = guardInteraction(guild, "harmony-admin-room:guard-condition-done");
  await room.handleAdminRoomInteraction(done);
  for (const [action, value] of [["guard-detail-reason", "paid"], ["guard-detail-mode", "all"]]) {
    const select = guardInteraction(guild, `harmony-admin-room:${action}`, { values: [value] });
    await room.handleAdminRoomInteraction(select);
  }
  const save = guardInteraction(guild, "harmony-admin-room:guard-detail-save");
  await room.handleAdminRoomInteraction(save);
  const [rule] = guardStore.listRules(guild.id);
  assert.equal(rule.rule_type, "phrase");
  assert.equal(rule.pattern, "bubble");
  assert.equal(rule.category, "paid");
  assert.equal(rule.action, "flag");
  assert.match(save.response.embeds[0].data.description, /Rule #\d+ was added/);
});

test("Edit Rule preserves identity and Remove Rule waits for confirmation", async () => {
  const { guild } = createGuild("guard-edit-remove");
  const id = guardStore.addRule({ guildId: guild.id, type: "phrase", pattern: "bubble", action: "flag", category: "paid", name: "Paid media" });

  const edit = guardInteraction(guild, "harmony-admin-room:guard-edit");
  await room.handleAdminRoomInteraction(edit);
  assert.match(edit.response.embeds[0].data.title, /Edit a Guard Rule/);
  const select = guardInteraction(guild, "harmony-admin-room:guard-edit-select", { values: [String(id)] });
  await room.handleAdminRoomInteraction(select);
  const category = guardInteraction(guild, "harmony-admin-room:guard-detail-reason", { values: ["other"] });
  await room.handleAdminRoomInteraction(category);
  const save = guardInteraction(guild, "harmony-admin-room:guard-detail-save");
  await room.handleAdminRoomInteraction(save);
  assert.equal(guardStore.getRule(guild.id, id).category, "other");
  assert.equal(guardStore.getRule(guild.id, id).id, id);

  const remove = guardInteraction(guild, "harmony-admin-room:guard-remove");
  await room.handleAdminRoomInteraction(remove);
  const chooseRemove = guardInteraction(guild, "harmony-admin-room:guard-remove-select", { values: [String(id)] });
  await room.handleAdminRoomInteraction(chooseRemove);
  assert.match(chooseRemove.response.embeds[0].data.title, /Remove Guard Rule/);
  assert.ok(guardStore.getRule(guild.id, id), "rule remains before confirmation");
  const confirm = guardInteraction(guild, "harmony-admin-room:guard-remove-confirm");
  await room.handleAdminRoomInteraction(confirm);
  assert.equal(guardStore.getRule(guild.id, id), null);
});

test("requested Guard Review Room is seeded only when no room exists and never overrides an admin selection", async () => {
  const guildId = "guard-bootstrap";
  const { guild, addChannel } = createGuild(guildId);
  const requested = addChannel("1554747061252005938");
  const bootstrap = { guilds: { cache: new Map([[guildId, guild]]) } };
  const initial = await room.configureRequestedGuardReviewRoom(bootstrap);
  assert.deepEqual(initial, { guildId, channelId: requested.id, changed: true });
  assert.equal(guardStore.getSettings(guildId).channel_id, requested.id);
  assert.equal(guardStore.getSettings(guildId).enabled, 0);

  guardStore.setReviewRoom(guildId, "admin-selected-room");
  const next = await room.configureRequestedGuardReviewRoom(bootstrap);
  assert.equal(next.channelId, "admin-selected-room");
  assert.equal(next.changed, false);
  assert.equal(guardStore.getSettings(guildId).channel_id, "admin-selected-room");
});

test("a moved or disabled panel cannot launch Admin Room workflows", async () => {
  const guildId = "stale-panel-guild";
  roomStore.savePanel({ guildId, channelId: "new-room", messageId: "new-panel", enabled: true });
  let response;
  await room.handleAdminRoomInteraction({
    customId: "harmony-admin-room:guard",
    guild: { id: guildId, ownerId: "owner-id" },
    guildId,
    channelId: "old-room",
    message: { id: "old-panel" },
    user: { id: "admin-id" },
    memberPermissions: permissionSet(true),
    isStringSelectMenu: () => true,
    reply: async (payload) => { response = payload; },
  });
  assert.match(response.content, /no longer active/i);

  roomStore.setEnabled(guildId, false);
  let disabledResponse;
  await room.handleAdminRoomInteraction({
    customId: "harmony-admin-room:welcome",
    guild: { id: guildId, ownerId: "owner-id" },
    guildId,
    channelId: "new-room",
    message: { id: "new-panel" },
    user: { id: "admin-id" },
    memberPermissions: permissionSet(true),
    reply: async (payload) => { disabledResponse = payload; },
  });
  assert.match(disabledResponse.content, /no longer active/i);
});

test("Status / Health control reuses the existing fresh status report", async () => {
  const { guild } = createGuild("summary-guild");
  roomStore.savePanel({ guildId: guild.id, channelId: "status-room", messageId: "status-panel", enabled: true });
  const replies = [];
  let deferred = false;
  const interaction = {
    customId: "harmony-admin-room:status", guild, guildId: guild.id,
    channelId: "status-room", message: { id: "status-panel" }, user: { id: "admin-id" },
    memberPermissions: permissionSet(true), member: { permissions: permissionSet(true) }, client: client(),
    deferReply: async () => { deferred = true; },
    editReply: async (payload) => { replies.push(payload); },
  };
  Object.defineProperty(interaction, "deferred", { get: () => deferred });
  await room.handleAdminRoomInteraction(interaction);
  assert.equal(deferred, true);
  assert.equal(replies.length, 1);
  assert.match(replies[0].embeds[0].data.title, /Status \/ Health/);
});

test("Guard history paginates removals and Admin Review safe decisions without message content", () => {
  const guildId = "history-guild";
  const ruleId = guardStore.addRule({ guildId, type: "phrase", pattern: "private phrase", action: "flag", category: "paid", name: "Paid content" });
  for (let i = 0; i < 9; i += 1) {
    guardStore.addAction({ guildId, messageId: `removed-${i}`, channelId: "channel", userId: `member-${i}`, category: "paid", source: "Manual admin removal", ruleId, adminId: "mod-1", dmDelivered: i % 2 === 0 });
  }
  guardStore.setMessageState(guildId, "safe-message", "safe", ruleId);
  guardStore.markSafe(guildId, "safe-message", "mod-2");
  const first = room.guardHistoryPayload(guildId, 0);
  const second = room.guardHistoryPayload(guildId, 1);
  assert.match(first.embeds[0].data.title, /History/);
  assert.match(first.embeds[0].data.footer.text, /Page 1 of 2/);
  assert.match(first.embeds[0].data.description, /DM:/);
  assert.match(second.embeds[0].data.footer.text, /Page 2 of 2/);
  assert.match(`${first.embeds[0].data.description}${second.embeds[0].data.description}`, /Marked Safe/);
  assert.doesNotMatch(`${first.embeds[0].data.description}${second.embeds[0].data.description}`, /private phrase/);
});

test("Guard history component requires admin authorization", async () => {
  let response;
  const interaction = {
    customId: "harmony-admin-room:guard-history:0",
    guild: { id: "history-auth-guild", ownerId: "owner-id" },
    user: { id: "member-id" },
    memberPermissions: permissionSet(false),
    reply: async (payload) => { response = payload; },
  };
  await room.handleAdminRoomInteraction(interaction);
  assert.match(response.content, /authorized server admins/i);
});

test("existing Schedule Manager panel components remain available", () => {
  const ids = managerPanelComponents("stray_kids", "g").flatMap((row) => row.components).map((component) => component.data.custom_id);
  assert.ok(ids.includes("harmony-manager:stray_kids:add"));
  assert.ok(ids.includes("harmony-manager:stray_kids:cancel"));
  assert.ok(ids.includes("harmony-manager:stray_kids:candidate-inbox"));
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
