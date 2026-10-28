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
  assert.match(first.sent[0].payload.embeds[0].data.title, /ADMIN ROOM/);

  await room.execute(setupInteraction({ guild, action: "refresh" }));
  assert.equal(first.sent[0].editCalls.length, 1);
  assert.equal(roomStore.getEnabledPanels().filter((panel) => panel.guild_id === guild.id).length, 1);

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

test("authorized admin can navigate calendar and Birthday Manager routes", async () => {
  const { guild } = createGuild("navigation-guild");
  roomStore.savePanel({ guildId: guild.id, channelId: "active-room", messageId: "active-panel", enabled: true });
  const permission = permissionSet(true);
  const replies = [];
  const interaction = {
    customId: "harmony-admin-room:category",
    guild,
    guildId: guild.id,
    channelId: "active-room",
    message: { id: "active-panel" },
    user: { id: "admin-id" },
    memberPermissions: permission,
    client: client(),
    isStringSelectMenu: () => true,
    values: ["calendar"],
    reply: async (payload) => { replies.push(payload); },
  };
  await room.handleAdminRoomInteraction(interaction);
  assert.equal(replies.length, 1);
  assert.match(replies[0].embeds[0].data.title, /Calendar & Events/);
  assert.ok(replies[0].components.flatMap((row) => row.components).some((item) => item.data.custom_id === "harmony-admin-room:birthdays"));

  const birthdayReply = [];
  await room.handleAdminRoomInteraction({
    ...interaction,
    customId: "harmony-admin-room:birthdays",
    reply: async (payload) => birthdayReply.push(payload),
  });
  assert.match(birthdayReply[0].content, /BIRTHDAY MANAGER/);
  assert.equal(birthdayReply[0].flags, 64);
});

test("ephemeral Admin Room Home continues navigation after a valid persistent-panel entry", async () => {
  const { guild } = createGuild("ephemeral-navigation-guild");
  roomStore.savePanel({ guildId: guild.id, channelId: "active-room", messageId: "active-panel", enabled: true });
  const base = {
    guild,
    guildId: guild.id,
    channelId: "active-room",
    user: { id: "admin-id" },
    memberPermissions: permissionSet(true),
    client: client(),
    isStringSelectMenu: () => true,
  };
  let calendarPage;
  await room.handleAdminRoomInteraction({
    ...base,
    customId: "harmony-admin-room:category",
    message: { id: "active-panel" },
    values: ["calendar"],
    reply: async (payload) => { calendarPage = payload; },
  });
  assert.match(calendarPage.embeds[0].data.title, /Calendar & Events/);

  let ephemeralHome;
  await room.handleAdminRoomInteraction({
    ...base,
    customId: "harmony-admin-room:home",
    message: { id: "ephemeral-calendar-page" },
    update: async (payload) => { ephemeralHome = payload; },
  });
  const homeMenu = ephemeralHome.components.flatMap((row) => row.components).find((item) => item.data.custom_id === "harmony-admin-room:category:ephemeral");
  assert.ok(homeMenu, "ephemeral Home marks its category menu as an authorized continuation");

  let communityPage;
  await room.handleAdminRoomInteraction({
    ...base,
    customId: homeMenu.data.custom_id,
    message: { id: "ephemeral-home-message" },
    values: ["community"],
    reply: async (payload) => { communityPage = payload; },
  });
  assert.match(communityPage.embeds[0].data.title, /Community/);
  assert.equal(communityPage.flags, 64);
});

test("a moved or disabled panel cannot launch Admin Room workflows", async () => {
  const guildId = "stale-panel-guild";
  roomStore.savePanel({ guildId, channelId: "new-room", messageId: "new-panel", enabled: true });
  let response;
  await room.handleAdminRoomInteraction({
    customId: "harmony-admin-room:category",
    guild: { id: guildId, ownerId: "owner-id" },
    guildId,
    channelId: "old-room",
    message: { id: "old-panel" },
    user: { id: "admin-id" },
    memberPermissions: permissionSet(true),
    isStringSelectMenu: () => true,
    values: ["calendar"],
    reply: async (payload) => { response = payload; },
  });
  assert.match(response.content, /no longer active/i);
});

test("home summary uses existing status signals and keeps unverified social status unknown", async () => {
  const { guild } = createGuild("summary-guild");
  const reportRows = [
    { id: "discord", name: "Harmony / Discord connection", status: "healthy" },
    { id: "database", name: "Database", status: "healthy" },
    { id: "discovery", name: "Event discovery", status: "attention" },
    { id: "event-sync", name: "Discord/event synchronization", status: "unknown" },
    { id: "guard", name: "Community Guard", status: "unknown" },
    ...["instagram", "threads", "facebook", "youtube"].map((name) => ({ id: `social-${name}`, name, status: "unknown" })),
  ];
  const payload = await room.buildHomePayload(guild, client(), { statusRows: reportRows });
  const description = payload.embeds[0].data.fields.map((field) => field.value).join("\n");
  assert.match(description, /Discovery 🟡/);
  assert.match(description, /Social sessions ⚪/);
  assert.doesNotMatch(description, /Social sessions 🟢/);
  assert.match(description, /not currently verifiable/i);
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
