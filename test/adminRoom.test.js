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
const welcomePassStore = require("../src/stores/welcomePassStore");
const greetingStore = require("../src/stores/greetingStore");
const memberCountStore = require("../src/stores/memberCountStore");
const messageLogStore = require("../src/stores/messageLogStore");
const { renderGreetingMessage } = greetingStore;
const { renderWelcomePassReleaseMessage } = welcomePassStore;
const room = require("../src/services/adminRoomService");
const { resolveWelcomePassEntryChannelId, resolveWelcomePassEntryMessage } = require("../src/services/welcomePassService");
const { managerPanelComponents } = require("../src/services/eventSchedulerService");

getDb();

function permissionSet(allowed = true) {
  return { has: (permission) => allowed && [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.Administrator].includes(permission) };
}

function createGuild(guildId = "admin-room-guild") {
  const channelsById = new Map();
  const rolesById = new Map();
  const guild = {
    id: guildId,
    ownerId: "owner-id",
    members: {
      me: { id: "bot-id", permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } },
      fetch: async () => new Map(),
    },
    roles: { cache: rolesById, everyone: { id: guildId }, fetch: async (id) => rolesById.get(id) || null },
    channels: {
      cache: channelsById,
      fetch: async (id) => channelsById.get(id) || null,
      create: async (options) => {
        const channel = addChannel(`created-${channelsById.size + 1}`);
        channel.name = options.name;
        channel.type = options.type;
        channel.parentId = options.parent || null;
        return channel;
      },
    },
  };
  function addChannel(id) {
    const sent = [];
    const channel = {
      id,
      guildId: guild.id,
      name: id,
      parentId: null,
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
      setName: async (name) => { channel.name = name; return channel; },
      setParent: async (parent) => { channel.parentId = parent.id; return channel; },
      setPosition: async () => channel,
      sent,
    };
    channelsById.set(id, channel);
    return channel;
  }
  function addRole(id, name = id, extra = {}) {
    const role = { id, name, managed: false, ...extra };
    rolesById.set(id, role);
    return role;
  }
  return { guild, addChannel, addRole };
}

function client(guild = null) {
  const cache = new Map(guild ? [[guild.id, guild]] : []);
  return { isReady: () => true, user: { id: "bot-id" }, ws: { ping: 25 }, listenerCount: () => 1, guilds: { cache, fetch: async (id) => cache.get(id) || null } };
}

function setupInteraction({ guild, channel, action = "install" }) {
  const output = { deferred: false, edited: null };
  return {
    ...output,
    guild,
    guildId: guild.id,
    user: { id: "admin-id" },
    memberPermissions: permissionSet(true),
    client: client(guild),
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

test("Greetings Manager exposes current settings and edits only the selected setting", async () => {
  const { guild, addChannel } = createGuild("greetings-manager-controls");
  const panel = addChannel("greetings-admin-panel");
  const oldChannel = addChannel("old-greeting-room");
  const nextChannel = addChannel("new-greeting-room");
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "greetings-panel-message", enabled: true });
  greetingStore.saveGreetingSettings({
    guildId: guild.id,
    channelId: oldChannel.id,
    entranceMessage: "Hello {member} in {server}.",
    exitMessage: "Goodbye {name} from {server}.",
  });
  greetingStore.disableGreetingSettings(guild.id);

  const open = guardInteraction(guild, "harmony-admin-room:greetings", { channelId: panel.id, message: { id: "greetings-panel-message" } });
  await room.handleAdminRoomInteraction(open);
  const payload = open.response;
  assert.match(payload.embeds[0].data.title, /Greetings Manager/);
  assert.match(payload.embeds[0].data.description, /Current Status:\*\* Off/);
  assert.ok(payload.embeds[0].data.description.includes(`Greeting Channel:** <#${oldChannel.id}>`));
  assert.match(payload.embeds[0].data.description, /Hello \{member\} in \{server\}/);
  assert.match(payload.embeds[0].data.description, /Goodbye \{name\} from \{server\}/);
  assert.ok(payload.components.flatMap((row) => row.components).some((component) => component.data.custom_id === "harmony-admin-room:greetings-channel-select"));
  assert.ok(payload.components.flatMap((row) => row.components).some((component) => component.data.custom_id === "harmony-admin-room:greetings-preview"));
  assert.ok(payload.components.flatMap((row) => row.components).some((component) => component.data.custom_id === "harmony-admin-room:greetings-test"));

  const select = guardInteraction(guild, "harmony-admin-room:greetings-channel-select", { values: [nextChannel.id] });
  await room.handleAdminRoomInteraction(select);
  const saved = greetingStore.getGreetingSettings(guild.id);
  assert.equal(saved.channel_id, nextChannel.id);
  assert.equal(saved.enabled, 0, "changing the channel does not silently turn existing Off settings On");
  assert.equal(saved.entrance_message, "Hello {member} in {server}.");
  assert.equal(saved.exit_message, "Goodbye {name} from {server}.");
});

test("Greetings Manager configures a new channel, edits both message fields, and On/Off preserves configuration", async () => {
  const { guild, addChannel } = createGuild("greetings-manager-enable");
  const panel = addChannel("greetings-enable-panel");
  const channel = addChannel("greetings-enable-room");
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "greetings-enable-panel-message", enabled: true });

  const open = guardInteraction(guild, "harmony-admin-room:greetings", { channelId: panel.id, message: { id: "greetings-enable-panel-message" } });
  await room.handleAdminRoomInteraction(open);
  assert.match(open.response.embeds[0].data.description, /Current Status:\*\* Not configured/);
  await room.handleAdminRoomInteraction(guardInteraction(guild, "harmony-admin-room:greetings-channel-select", { values: [channel.id] }));
  let saved = greetingStore.getGreetingSettings(guild.id);
  assert.equal(saved.channel_id, channel.id);
  assert.equal(saved.enabled, 1);

  const entranceEdit = guardInteraction(guild, "harmony-admin-room:greetings-entrance-edit");
  await room.handleAdminRoomInteraction(entranceEdit);
  assert.match(entranceEdit.modal.data.title, /Entrance Message/);
  const exitEdit = guardInteraction(guild, "harmony-admin-room:greetings-exit-edit");
  await room.handleAdminRoomInteraction(exitEdit);
  assert.match(exitEdit.modal.data.title, /Exit Message/);

  await room.handleAdminRoomInteraction(guardInteraction(guild, "harmony-admin-room:greetings-entrance-submit", {
    fields: { getTextInputValue: () => "Welcome {member} — {name} at {server}" },
  }));
  await room.handleAdminRoomInteraction(guardInteraction(guild, "harmony-admin-room:greetings-exit-submit", {
    fields: { getTextInputValue: () => "Farewell {name}, from {server}" },
  }));
  saved = greetingStore.getGreetingSettings(guild.id);
  assert.equal(saved.entrance_message, "Welcome {member} — {name} at {server}");
  assert.equal(saved.exit_message, "Farewell {name}, from {server}");
  assert.equal(saved.channel_id, channel.id);
  assert.equal(saved.enabled, 1);

  await room.handleAdminRoomInteraction(guardInteraction(guild, "harmony-admin-room:greetings-toggle"));
  saved = greetingStore.getGreetingSettings(guild.id);
  assert.equal(saved.enabled, 0);
  assert.equal(saved.channel_id, channel.id);
  assert.equal(saved.entrance_message, "Welcome {member} — {name} at {server}");
  assert.equal(saved.exit_message, "Farewell {name}, from {server}");
  await room.handleAdminRoomInteraction(guardInteraction(guild, "harmony-admin-room:greetings-toggle"));
  assert.equal(greetingStore.getGreetingSettings(guild.id).enabled, 1);
  assert.equal(greetingStore.getGreetingSettings(guild.id).channel_id, channel.id);
});

test("Greetings preview is private and non-pinging; Send Test keeps Administrator permission parity", async () => {
  const { guild, addChannel } = createGuild("greetings-manager-preview");
  guild.name = "Youtiful Stay";
  const panel = addChannel("greetings-preview-panel");
  const channel = addChannel("greetings-preview-room");
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "greetings-preview-panel-message", enabled: true });
  greetingStore.saveGreetingSettings({
    guildId: guild.id,
    channelId: channel.id,
    entranceMessage: "Welcome {member} ({name}) to {server}!",
    exitMessage: "Goodbye {name} from {server}.",
  });

  const open = guardInteraction(guild, "harmony-admin-room:greetings", { channelId: panel.id, message: { id: "greetings-preview-panel-message" } });
  await room.handleAdminRoomInteraction(open);
  const preview = guardInteraction(guild, "harmony-admin-room:greetings-preview", { member: { displayName: "Test Admin" } });
  await room.handleAdminRoomInteraction(preview);
  assert.equal(preview.response.flags, 64);
  assert.match(preview.response.content, /Welcome <@guard-admin> \(Test Admin\) to Youtiful Stay/);
  assert.equal(preview.response.allowedMentions.parse.length, 0);

  const sendTest = guardInteraction(guild, "harmony-admin-room:greetings-test", {
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.Administrator },
    member: { displayName: "Test Admin" },
  });
  await room.handleAdminRoomInteraction(sendTest);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].payload.content, "Welcome <@guard-admin> (Test Admin) to Youtiful Stay!");
  assert.deepEqual(channel.sent[0].payload.allowedMentions, { users: ["guard-admin"] });
  assert.match(sendTest.response.content, /Test delivered successfully/);

  const manageGuildOnly = { has: (permission) => permission === PermissionFlagsBits.ManageGuild };
  const managerOpen = guardInteraction(guild, "harmony-admin-room:greetings", {
    channelId: panel.id,
    message: { id: "greetings-preview-panel-message" },
    memberPermissions: manageGuildOnly,
  });
  await room.handleAdminRoomInteraction(managerOpen);
  assert.ok(!managerOpen.response.components.flatMap((row) => row.components).some((component) => component.data.custom_id === "harmony-admin-room:greetings-test"));
  const forgedTest = guardInteraction(guild, "harmony-admin-room:greetings-test", { memberPermissions: manageGuildOnly });
  await room.handleAdminRoomInteraction(forgedTest);
  assert.match(forgedTest.response.content, /server owner or an Administrator/);
  assert.equal(channel.sent.length, 1);
});

test("Greetings controls reject stale Admin Controls sessions and leave slash command definition intact", async () => {
  const { guild, addChannel } = createGuild("greetings-manager-stale");
  const panel = addChannel("greetings-stale-panel");
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "greetings-current-panel", enabled: true });
  const open = guardInteraction(guild, "harmony-admin-room:greetings", { channelId: panel.id, message: { id: "greetings-current-panel" } });
  await room.handleAdminRoomInteraction(open);
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "greetings-replaced-panel", enabled: true });
  const stale = guardInteraction(guild, "harmony-admin-room:greetings-toggle");
  await room.handleAdminRoomInteraction(stale);
  assert.match(stale.response.content, /panel that is no longer active/i);

  const greetingsCommand = require("../src/commands/greetings");
  const schema = greetingsCommand.data.toJSON();
  assert.equal(schema.name, "harmony-greetings");
  assert.deepEqual(schema.options.map((option) => option.name), ["setup", "preview", "test", "off"]);
  assert.equal(schema.default_member_permissions, String(PermissionFlagsBits.Administrator));
});

test("Member Counts Manager reads current configuration and opening it never creates or refreshes counters", async () => {
  const { guild, addChannel } = createGuild("member-count-manager-read-only-open");
  const panel = addChannel("member-count-admin-panel");
  const before = guild.channels.cache.size;
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "member-count-panel-message", enabled: true });

  const open = guardInteraction(guild, "harmony-admin-room:members", { channelId: panel.id, message: { id: "member-count-panel-message" } });
  await room.handleAdminRoomInteraction(open);
  assert.equal(open.response.flags, 64);
  assert.match(open.response.embeds[0].data.title, /Member Counts Manager/);
  assert.match(open.response.embeds[0].data.description, /Current Status:\*\* Not configured/);
  assert.match(open.response.embeds[0].data.description, /Configured STAY role:\*\* Not selected/);
  assert.equal(guild.channels.cache.size, before);
  assert.equal(memberCountStore.getMemberCountSettings(guild.id), null);
  const components = open.response.components.flatMap((row) => row.components);
  assert.ok(components.some((item) => item.data.custom_id === "harmony-admin-room:members-role-select"));
  assert.ok(components.some((item) => item.data.custom_id === "harmony-admin-room:members-refresh" && item.data.disabled));
});

test("Member Counts setup uses the existing service, rejects @everyone, and reports refreshed totals privately", async () => {
  const { guild, addChannel, addRole } = createGuild("member-count-manager-setup");
  const panel = addChannel("member-count-setup-panel");
  const stayRole = addRole("stay-role", "STAY");
  guild.members.fetch = async () => new Map([
    ["human-with-role", { user: { bot: false }, roles: { cache: { has: (id) => id === stayRole.id } } }],
    ["human-without-role", { user: { bot: false }, roles: { cache: { has: () => false } } }],
    ["bot-member", { user: { bot: true }, roles: { cache: { has: () => false } } }],
  ]);
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "member-count-setup-panel-message", enabled: true });
  const open = guardInteraction(guild, "harmony-admin-room:members", { channelId: panel.id, message: { id: "member-count-setup-panel-message" } });
  await room.handleAdminRoomInteraction(open);
  const before = guild.channels.cache.size;

  const everyone = guardInteraction(guild, "harmony-admin-room:members-role-select", { values: [guild.id] });
  await room.handleAdminRoomInteraction(everyone);
  assert.match(everyone.response.content, /other than @everyone/);
  assert.equal(guild.channels.cache.size, before);

  const setup = guardInteraction(guild, "harmony-admin-room:members-role-select", { values: [stayRole.id] });
  await room.handleAdminRoomInteraction(setup);
  const saved = memberCountStore.getMemberCountSettings(guild.id);
  assert.equal(saved.role_id, stayRole.id);
  assert.equal(saved.enabled, 1);
  assert.ok(saved.category_id);
  assert.ok(saved.total_channel_id);
  assert.ok(saved.stay_channel_id);
  assert.ok(saved.no_role_channel_id);
  assert.equal(guild.channels.cache.size, before + 4, "setup creates one category and three counters");
  assert.match(setup.response.embeds[0].data.description, /Total members: \*\*2\*\* · STAY members: \*\*1\*\* · No STAY role: \*\*1\*\*/);

  const refresh = guardInteraction(guild, "harmony-admin-room:members-refresh");
  await room.handleAdminRoomInteraction(refresh);
  assert.equal(refresh.deferred.flags, 64);
  assert.match(refresh.response, /\*\*2\*\* total members, \*\*1\*\* with the STAY role, and \*\*1\*\* without it/);
});

test("Member Counts explicit setup reuses existing counters and changing role does not duplicate channels", async () => {
  const { guild, addChannel, addRole } = createGuild("member-count-manager-reuse");
  const panel = addChannel("member-count-reuse-panel");
  const category = addChannel("existing-counter-category");
  category.type = ChannelType.GuildCategory;
  const total = addChannel("existing-total-counter");
  total.type = ChannelType.GuildVoice;
  total.parentId = category.id;
  const stay = addChannel("existing-stay-counter");
  stay.type = ChannelType.GuildVoice;
  stay.parentId = category.id;
  const noRole = addChannel("existing-no-role-counter");
  noRole.type = ChannelType.GuildVoice;
  noRole.parentId = category.id;
  const role = addRole("old-stay-role", "Old STAY");
  const newRole = addRole("new-stay-role", "New STAY");
  memberCountStore.saveMemberCountSettings({ guildId: guild.id, roleId: role.id, categoryId: category.id, totalChannelId: total.id, stayChannelId: stay.id, noRoleChannelId: noRole.id });
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "member-count-reuse-panel-message", enabled: true });
  const open = guardInteraction(guild, "harmony-admin-room:members", { channelId: panel.id, message: { id: "member-count-reuse-panel-message" } });
  await room.handleAdminRoomInteraction(open);
  const before = guild.channels.cache.size;
  const setup = guardInteraction(guild, "harmony-admin-room:members-role-select", { values: [newRole.id] });
  await room.handleAdminRoomInteraction(setup);
  const saved = memberCountStore.getMemberCountSettings(guild.id);
  assert.equal(saved.role_id, newRole.id);
  assert.equal(saved.category_id, category.id);
  assert.equal(saved.total_channel_id, total.id);
  assert.equal(saved.stay_channel_id, stay.id);
  assert.equal(saved.no_role_channel_id, noRole.id);
  assert.equal(guild.channels.cache.size, before, "selecting a role updates the role and reuses intact saved channels");
});

test("Member Counts On/Off preserves setup and re-enables saved counters without recreation", async () => {
  const { guild, addChannel } = createGuild("member-count-manager-toggle");
  const panel = addChannel("member-count-toggle-panel");
  const channels = [addChannel("count-category"), addChannel("count-total"), addChannel("count-stay"), addChannel("count-no-role")];
  memberCountStore.saveMemberCountSettings({ guildId: guild.id, roleId: "stay-role-toggle", categoryId: channels[0].id, totalChannelId: channels[1].id, stayChannelId: channels[2].id, noRoleChannelId: channels[3].id });
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "member-count-toggle-panel-message", enabled: true });
  const open = guardInteraction(guild, "harmony-admin-room:members", { channelId: panel.id, message: { id: "member-count-toggle-panel-message" } });
  await room.handleAdminRoomInteraction(open);
  assert.match(open.response.embeds[0].data.description, /Current Status:\*\* On/);
  const before = guild.channels.cache.size;

  const off = guardInteraction(guild, "harmony-admin-room:members-toggle");
  await room.handleAdminRoomInteraction(off);
  let saved = memberCountStore.getMemberCountSettings(guild.id);
  assert.equal(saved.enabled, 0);
  assert.deepEqual([saved.category_id, saved.total_channel_id, saved.stay_channel_id, saved.no_role_channel_id], channels.map((channel) => channel.id));
  assert.equal(guild.channels.cache.size, before);

  const on = guardInteraction(guild, "harmony-admin-room:members-toggle");
  await room.handleAdminRoomInteraction(on);
  saved = memberCountStore.getMemberCountSettings(guild.id);
  assert.equal(saved.enabled, 1);
  assert.deepEqual([saved.category_id, saved.total_channel_id, saved.stay_channel_id, saved.no_role_channel_id], channels.map((channel) => channel.id));
  assert.equal(guild.channels.cache.size, before, "re-enabling changes only the saved enabled flag");
});

test("Member Counts setup preserves the bot Manage Channels permission check and stale Admin panel protection", async () => {
  const { guild, addChannel, addRole } = createGuild("member-count-manager-protection");
  const panel = addChannel("member-count-protection-panel");
  const role = addRole("stay-role-protection", "STAY");
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "member-count-protection-panel-message", enabled: true });
  const noPermission = guardInteraction(guild, "harmony-admin-room:members", { channelId: panel.id, message: { id: "member-count-protection-panel-message" } });
  await room.handleAdminRoomInteraction(noPermission);
  guild.members.me.permissions.has = (permission) => permission !== PermissionFlagsBits.ManageChannels;
  const denied = guardInteraction(guild, "harmony-admin-room:members-role-select", { values: [role.id] });
  await room.handleAdminRoomInteraction(denied);
  assert.match(denied.response.content, /needs \*\*Manage Channels\*\*/);
  assert.equal(memberCountStore.getMemberCountSettings(guild.id), null);

  guild.members.me.permissions.has = () => true;
  const staleOpen = guardInteraction(guild, "harmony-admin-room:members", { channelId: panel.id, message: { id: "member-count-protection-panel-message" } });
  await room.handleAdminRoomInteraction(staleOpen);
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "member-count-replaced-panel", enabled: true });
  const stale = guardInteraction(guild, "harmony-admin-room:members-toggle");
  await room.handleAdminRoomInteraction(stale);
  assert.match(stale.response.content, /panel that is no longer active/i);
});

test("/harmony-member-counts slash command remains registered with its existing subcommands and permissions", () => {
  const command = require("../src/commands/memberCounts");
  const schema = command.data.toJSON();
  assert.equal(schema.name, "harmony-member-counts");
  assert.deepEqual(schema.options.map((option) => option.name), ["setup", "refresh", "status", "off"]);
  assert.equal(schema.default_member_permissions, String(PermissionFlagsBits.Administrator));
});

test("Message Logs Manager opens read-only and displays configured status, channel, retention, and exclusions", async () => {
  const { guild, addChannel } = createGuild("message-logs-manager-read-only");
  const panel = addChannel("message-logs-admin-panel");
  const logChannel = addChannel("trusted-log-room");
  const excluded = addChannel("excluded-chat");
  messageLogStore.saveLogSettings(guild.id, logChannel.id);
  messageLogStore.addExcludedChannel(guild.id, excluded.id);
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "message-logs-panel-message", enabled: true });
  const before = { settings: messageLogStore.getLogSettings(guild.id), excluded: messageLogStore.listExcludedChannels(guild.id), channelCount: guild.channels.cache.size };

  const open = guardInteraction(guild, "harmony-admin-room:logs", { channelId: panel.id, message: { id: "message-logs-panel-message" } });
  await room.handleAdminRoomInteraction(open);
  const description = open.response.embeds[0].data.description;
  assert.equal(open.response.flags, 64);
  assert.match(open.response.embeds[0].data.title, /Message Logs Manager/);
  assert.match(description, /Status:\*\* On/);
  assert.ok(description.includes(`Log channel:** <#${logChannel.id}>`));
  assert.match(description, /Retention:\*\* 3 days/);
  assert.ok(description.includes(`<#${excluded.id}>`));
  assert.match(description, /private log channel.*trusted admins/i);
  assert.equal(messageLogStore.getLogSettings(guild.id).channel_id, before.settings.channel_id);
  assert.deepEqual(messageLogStore.listExcludedChannels(guild.id), before.excluded);
  assert.equal(guild.channels.cache.size, before.channelCount);
  const controls = open.response.components.flatMap((row) => row.components);
  assert.ok(controls.some((item) => item.data.custom_id === "harmony-admin-room:logs-channel-select"));
  assert.ok(controls.some((item) => item.data.custom_id === "harmony-admin-room:logs-exclude-channel-select"));
  assert.ok(controls.some((item) => item.data.custom_id === "harmony-admin-room:logs-include-channel-select:0"));
});

test("Message Logs channel selector configures or changes the channel without touching exclusions", async () => {
  const { guild, addChannel } = createGuild("message-logs-manager-setup");
  const panel = addChannel("message-logs-setup-panel");
  const first = addChannel("first-log-room");
  const next = addChannel("next-log-room");
  const excluded = addChannel("preserved-exclusion");
  messageLogStore.addExcludedChannel(guild.id, excluded.id);
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "message-logs-setup-panel-message", enabled: true });
  const open = guardInteraction(guild, "harmony-admin-room:logs", { channelId: panel.id, message: { id: "message-logs-setup-panel-message" } });
  await room.handleAdminRoomInteraction(open);
  assert.match(open.response.embeds[0].data.description, /Status:\*\* Not configured/);

  const configure = guardInteraction(guild, "harmony-admin-room:logs-channel-select", { values: [first.id] });
  await room.handleAdminRoomInteraction(configure);
  assert.equal(messageLogStore.getLogSettings(guild.id).channel_id, first.id);
  assert.equal(messageLogStore.getLogSettings(guild.id).enabled, 1);
  assert.deepEqual(messageLogStore.listExcludedChannels(guild.id), [excluded.id]);

  const change = guardInteraction(guild, "harmony-admin-room:logs-channel-select", { values: [next.id] });
  await room.handleAdminRoomInteraction(change);
  assert.equal(messageLogStore.getLogSettings(guild.id).channel_id, next.id);
  assert.equal(messageLogStore.getLogSettings(guild.id).enabled, 1);
  assert.deepEqual(messageLogStore.listExcludedChannels(guild.id), [excluded.id]);
  assert.ok(change.response.embeds[0].data.description.includes(`<#${next.id}>`));
});

test("Message Logs can exclude and include only explicitly selected channels, never the current log channel", async () => {
  const { guild, addChannel } = createGuild("message-logs-manager-exclusions");
  const panel = addChannel("message-logs-exclusion-panel");
  const logChannel = addChannel("message-logs-target");
  const another = addChannel("another-channel");
  const alreadyExcluded = addChannel("already-excluded");
  messageLogStore.saveLogSettings(guild.id, logChannel.id);
  messageLogStore.addExcludedChannel(guild.id, alreadyExcluded.id);
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "message-logs-exclusion-panel-message", enabled: true });
  const open = guardInteraction(guild, "harmony-admin-room:logs", { channelId: panel.id, message: { id: "message-logs-exclusion-panel-message" } });
  await room.handleAdminRoomInteraction(open);

  const denyLogRoom = guardInteraction(guild, "harmony-admin-room:logs-exclude-channel-select", { values: [logChannel.id] });
  await room.handleAdminRoomInteraction(denyLogRoom);
  assert.match(denyLogRoom.response.content, /already excluded from logging automatically/);
  assert.deepEqual(messageLogStore.listExcludedChannels(guild.id), [alreadyExcluded.id]);

  const exclude = guardInteraction(guild, "harmony-admin-room:logs-exclude-channel-select", { values: [another.id] });
  await room.handleAdminRoomInteraction(exclude);
  assert.deepEqual(messageLogStore.listExcludedChannels(guild.id), [alreadyExcluded.id, another.id].sort());
  assert.ok(exclude.response.embeds[0].data.description.includes(`<#${another.id}>`));

  const include = guardInteraction(guild, "harmony-admin-room:logs-include-channel-select:0", { values: [alreadyExcluded.id] });
  await room.handleAdminRoomInteraction(include);
  assert.deepEqual(messageLogStore.listExcludedChannels(guild.id), [another.id]);
  assert.match(include.response.embeds[0].data.description, /Excluded channels/i);
});

test("Message Logs Off preserves channel and exclusions, On reuses them, and existing log posts still expire", async () => {
  const { guild, addChannel } = createGuild("message-logs-manager-toggle");
  const panel = addChannel("message-logs-toggle-panel");
  const logChannel = addChannel("saved-log-channel");
  const excluded = addChannel("saved-excluded-channel");
  messageLogStore.saveLogSettings(guild.id, logChannel.id);
  messageLogStore.addExcludedChannel(guild.id, excluded.id);
  messageLogStore.addLogPost("existing-log-post", guild.id, logChannel.id, "2026-10-30T00:00:00.000Z");
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "message-logs-toggle-panel-message", enabled: true });
  const open = guardInteraction(guild, "harmony-admin-room:logs", { channelId: panel.id, message: { id: "message-logs-toggle-panel-message" } });
  await room.handleAdminRoomInteraction(open);
  const channelsBefore = guild.channels.cache.size;

  const off = guardInteraction(guild, "harmony-admin-room:logs-toggle");
  await room.handleAdminRoomInteraction(off);
  assert.equal(messageLogStore.getLogSettings(guild.id).enabled, 0);
  assert.equal(messageLogStore.getLogSettings(guild.id).channel_id, logChannel.id);
  assert.deepEqual(messageLogStore.listExcludedChannels(guild.id), [excluded.id]);
  assert.equal(messageLogStore.listExpiredLogPosts("2026-10-31T00:00:00.000Z").some((post) => post.message_id === "existing-log-post"), true);

  const on = guardInteraction(guild, "harmony-admin-room:logs-toggle");
  await room.handleAdminRoomInteraction(on);
  assert.equal(messageLogStore.getLogSettings(guild.id).enabled, 1);
  assert.equal(messageLogStore.getLogSettings(guild.id).channel_id, logChannel.id);
  assert.deepEqual(messageLogStore.listExcludedChannels(guild.id), [excluded.id]);
  assert.equal(guild.channels.cache.size, channelsBefore, "Off/On toggles never recreate channels");
});

test("Message Logs screens reject interactions after the originating Admin Controls panel is replaced", async () => {
  const { guild, addChannel } = createGuild("message-logs-manager-stale");
  const panel = addChannel("message-logs-stale-panel");
  messageLogStore.saveLogSettings(guild.id, "log-room");
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "active-message-logs-panel", enabled: true });
  const open = guardInteraction(guild, "harmony-admin-room:logs", { channelId: panel.id, message: { id: "active-message-logs-panel" } });
  await room.handleAdminRoomInteraction(open);
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "replacement-message-logs-panel", enabled: true });
  const stale = guardInteraction(guild, "harmony-admin-room:logs-toggle");
  await room.handleAdminRoomInteraction(stale);
  assert.match(stale.response.content, /panel that is no longer active/i);
  assert.equal(messageLogStore.getLogSettings(guild.id).enabled, 1);
});

test("/harmony-logs keeps setup/status/off/exclude/include and the three-day retention", () => {
  const command = require("../src/commands/messageLogs");
  const schema = command.data.toJSON();
  assert.equal(schema.name, "harmony-logs");
  assert.deepEqual(schema.options.map((option) => option.name), ["setup", "status", "off", "exclude", "include"]);
  assert.equal(schema.default_member_permissions, String(PermissionFlagsBits.Administrator));
  assert.equal(require("../src/services/messageLogService").RETENTION_MS, 72 * 60 * 60 * 1000);
});

function guardInteraction(guild, customId, extra = {}) {
  const interaction = {
    guild,
    guildId: guild.id,
    channelId: "ephemeral-channel",
    user: { id: "guard-admin" },
    memberPermissions: permissionSet(true),
    client: client(guild),
    customId,
    values: [],
    response: null,
    update: async (payload) => { interaction.response = payload; return payload; },
    reply: async (payload) => { interaction.response = payload; return payload; },
    deferReply: async (payload) => { interaction.deferred = payload || true; },
    deferUpdate: async () => { interaction.deferredUpdate = true; },
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

test("Welcome Pass controls update one setting at a time, toggle mode, and edit the template", async () => {
  const { guild, addChannel, addRole } = createGuild("welcome-manager-controls");
  const role = addRole("stay-role", "STAY");
  const alerts = addChannel("private-alerts");
  const memberRoom = addChannel("member-room");
  const entryRoom = addChannel("entry-room");
  const nextAlerts = addChannel("new-alerts");
  const activePanel = addChannel("admin-panel-channel");
  roomStore.savePanel({ guildId: guild.id, channelId: activePanel.id, messageId: "welcome-panel", enabled: true });
  welcomePassStore.saveWelcomePassSettings({
    guildId: guild.id,
    roleId: role.id,
    channelId: alerts.id,
    releaseChannelId: memberRoom.id,
    entryChannelId: entryRoom.id,
    releaseMessage: "Welcome {member} to {server}!",
  });
  welcomePassStore.setWelcomePassGrantMode(guild.id, "manual");

  const open = guardInteraction(guild, "harmony-admin-room:welcome", {
    channelId: activePanel.id,
    message: { id: "welcome-panel" },
  });
  await room.handleAdminRoomInteraction(open);
  assert.equal(open.response.flags, 64);
  assert.match(open.response.embeds[0].data.description, /Status:\*\* Configured/);
  assert.match(open.response.embeds[0].data.description, /Approved Role:\*\* @STAY/);
  assert.ok(open.response.embeds[0].data.description.includes(`Welcome Pass Entry Channel:** <#${entryRoom.id}>`));
  assert.ok(open.response.embeds[0].data.description.includes(`Pass Submission Alerts:** <#${alerts.id}>`));
  assert.match(open.response.embeds[0].data.description, /primary purpose is to alert staff when a new pass is waiting for review/i);
  assert.ok(open.response.embeds[0].data.description.includes(`Approved Member Welcome Channel:** <#${memberRoom.id}>`));
  assert.doesNotMatch(open.response.embeds[0].data.description, /Private Alert Channel|Public\/Member Channel/);
  assert.match(open.response.embeds[0].data.description, /Grant Mode:\*\* manual/);
  const controls = open.response.components.flatMap((row) => row.components).map((component) => component.data.custom_id);
  for (const id of ["welcome-role", "welcome-entry", "welcome-private", "welcome-member", "welcome-entry-message", "welcome-approved-message", "welcome-mode"]) {
    assert.ok(controls.includes(`harmony-admin-room:${id}`));
  }

  const rolePicker = guardInteraction(guild, "harmony-admin-room:welcome-role");
  await room.handleAdminRoomInteraction(rolePicker);
  assert.ok(rolePicker.response.components[0].components[0].toJSON().custom_id.includes("welcome-role-select"));
  const roleSelect = guardInteraction(guild, "harmony-admin-room:welcome-role-select", { values: [role.id] });
  await room.handleAdminRoomInteraction(roleSelect);
  assert.equal(welcomePassStore.getWelcomePassSettings(guild.id).channel_id, alerts.id);

  const entryPicker = guardInteraction(guild, "harmony-admin-room:welcome-entry");
  await room.handleAdminRoomInteraction(entryPicker);
  assert.match(entryPicker.response.embeds[0].data.title, /Welcome Pass Entry Channel/);
  const entrySelect = guardInteraction(guild, "harmony-admin-room:welcome-entry-select", { values: ["new-entry-room"] });
  const newEntryRoom = addChannel("new-entry-room");
  await room.handleAdminRoomInteraction(entrySelect);
  assert.match(entrySelect.response.embeds[0].data.title, /New-Member Entrance Message/);
  assert.ok(entrySelect.response.embeds[0].data.description.includes("Everyone welcome {member}"));
  const editEntry = guardInteraction(guild, "harmony-admin-room:welcome-entry-message-edit");
  await room.handleAdminRoomInteraction(editEntry);
  assert.match(editEntry.modal.data.title, /Edit Entrance Message/);
  assert.match(editEntry.modal.toJSON().components[0].components[0].placeholder, /\{member\}/);
  const submitEntry = guardInteraction(guild, "harmony-admin-room:welcome-entry-message-submit", {
    isModalSubmit: () => true,
    fields: { getTextInputValue: () => "Welcome to the server, {member}!" },
  });
  await room.handleAdminRoomInteraction(submitEntry);
  let saved = welcomePassStore.getWelcomePassSettings(guild.id);
  assert.equal(saved.entry_channel_id, newEntryRoom.id);
  assert.equal(saved.entry_message, "Welcome to the server, {member}!");
  assert.equal(renderGreetingMessage(saved.entry_message, { memberMention: "<@new-member>", memberName: "Member", serverName: guild.name }), "Welcome to the server, <@new-member>!");
  assert.equal(saved.channel_id, alerts.id);
  assert.equal(saved.release_channel_id, memberRoom.id);

  const openChannel = guardInteraction(guild, "harmony-admin-room:welcome-private");
  await room.handleAdminRoomInteraction(openChannel);
  assert.match(openChannel.response.embeds[0].data.description, /new Welcome Pass is submitted and waiting for review/i);
  assert.equal(openChannel.response.components[0].components[0].data.channel_types[0], ChannelType.GuildText);
  const selectChannel = guardInteraction(guild, "harmony-admin-room:welcome-private-select", { values: [nextAlerts.id] });
  await room.handleAdminRoomInteraction(selectChannel);
  saved = welcomePassStore.getWelcomePassSettings(guild.id);
  assert.equal(saved.channel_id, nextAlerts.id);
  assert.equal(saved.role_id, role.id);
  assert.equal(saved.release_channel_id, memberRoom.id);
  assert.equal(saved.entry_channel_id, newEntryRoom.id);
  assert.equal(saved.release_message, "Welcome {member} to {server}!");
  assert.equal(saved.grant_mode, "manual");

  const toggle = guardInteraction(guild, "harmony-admin-room:welcome-mode");
  await room.handleAdminRoomInteraction(toggle);
  saved = welcomePassStore.getWelcomePassSettings(guild.id);
  assert.equal(saved.grant_mode, "automatic");
  assert.equal(saved.channel_id, nextAlerts.id);

  const approvedChannelPicker = guardInteraction(guild, "harmony-admin-room:welcome-member");
  await room.handleAdminRoomInteraction(approvedChannelPicker);
  const newMemberRoom = addChannel("new-member-room");
  const approvedChannelSelect = guardInteraction(guild, "harmony-admin-room:welcome-member-select", { values: [newMemberRoom.id] });
  await room.handleAdminRoomInteraction(approvedChannelSelect);
  assert.match(approvedChannelSelect.response.embeds[0].data.title, /Approved Member Welcome Message/);
  assert.ok(approvedChannelSelect.response.embeds[0].data.description.includes("Welcome {member} to {server}!"));
  const editApproved = guardInteraction(guild, "harmony-admin-room:welcome-approved-message-edit");
  await room.handleAdminRoomInteraction(editApproved);
  assert.match(editApproved.modal.data.title, /Edit Approved Welcome Message/);
  assert.match(editApproved.modal.toJSON().components[0].components[0].placeholder, /\{member\}/);
  const submit = guardInteraction(guild, "harmony-admin-room:welcome-approved-message-submit", {
    isModalSubmit: () => true,
    fields: { getTextInputValue: () => "Congratulations, {member}! Welcome to Main Chat." },
  });
  await room.handleAdminRoomInteraction(submit);
  saved = welcomePassStore.getWelcomePassSettings(guild.id);
  assert.equal(saved.release_message, "Congratulations, {member}! Welcome to Main Chat.");
  assert.equal(renderWelcomePassReleaseMessage(saved.release_message, { memberMention: "<@new-member>", memberName: "Member", serverName: guild.name }), "Congratulations, <@new-member>! Welcome to Main Chat.");
  assert.equal(saved.role_id, role.id);
  assert.equal(saved.channel_id, nextAlerts.id);
  assert.equal(saved.release_channel_id, newMemberRoom.id);
  assert.equal(saved.entry_channel_id, newEntryRoom.id);

  const back = guardInteraction(guild, "harmony-admin-room:welcome:ephemeral");
  await room.handleAdminRoomInteraction(back);
  assert.match(back.response.embeds[0].data.title, /Welcome Pass Manager/);
});

test("Welcome Pass can be set up through selectors without partially saving or clearing existing settings", async () => {
  const { guild, addChannel, addRole } = createGuild("welcome-manager-first-setup");
  const role = addRole("new-stay-role", "STAY");
  const alerts = addChannel("setup-alerts");
  const memberRoom = addChannel("setup-members");
  const entryRoom = addChannel("setup-entry");
  const panelChannel = addChannel("setup-admin-panel");
  roomStore.savePanel({ guildId: guild.id, channelId: panelChannel.id, messageId: "setup-panel", enabled: true });

  const open = guardInteraction(guild, "harmony-admin-room:welcome", { channelId: panelChannel.id, message: { id: "setup-panel" } });
  await room.handleAdminRoomInteraction(open);
  assert.match(open.response.embeds[0].data.description, /Setup needed/);
  assert.ok(open.response.embeds[0].data.description.includes(welcomePassStore.DEFAULT_RELEASE_MESSAGE));

  const rolePicker = guardInteraction(guild, "harmony-admin-room:welcome-role");
  await room.handleAdminRoomInteraction(rolePicker);
  const roleSelect = guardInteraction(guild, "harmony-admin-room:welcome-role-select", { values: [role.id] });
  await room.handleAdminRoomInteraction(roleSelect);
  assert.match(roleSelect.response.embeds[0].data.description, /Welcome Pass Entry Channel, Pass Submission Alerts, Approved Member Welcome Channel/);
  assert.equal(welcomePassStore.getWelcomePassSettings(guild.id), null, "incomplete setup remains session-only");

  const privatePicker = guardInteraction(guild, "harmony-admin-room:welcome-private");
  await room.handleAdminRoomInteraction(privatePicker);
  await room.handleAdminRoomInteraction(guardInteraction(guild, "harmony-admin-room:welcome-private-select", { values: [alerts.id] }));
  assert.equal(welcomePassStore.getWelcomePassSettings(guild.id), null);

  const memberPicker = guardInteraction(guild, "harmony-admin-room:welcome-member");
  await room.handleAdminRoomInteraction(memberPicker);
  const memberSelect = guardInteraction(guild, "harmony-admin-room:welcome-member-select", { values: [memberRoom.id] });
  await room.handleAdminRoomInteraction(memberSelect);
  assert.equal(welcomePassStore.getWelcomePassSettings(guild.id), null, "entry destination is required before first setup is saved");
  const entryPicker = guardInteraction(guild, "harmony-admin-room:welcome-entry");
  await room.handleAdminRoomInteraction(entryPicker);
  const entrySelect = guardInteraction(guild, "harmony-admin-room:welcome-entry-select", { values: [entryRoom.id] });
  await room.handleAdminRoomInteraction(entrySelect);
  assert.match(entrySelect.response.embeds[0].data.title, /New-Member Entrance Message/);
  const saved = welcomePassStore.getWelcomePassSettings(guild.id);
  assert.equal(saved.role_id, role.id);
  assert.equal(saved.channel_id, alerts.id);
  assert.equal(saved.release_channel_id, memberRoom.id);
  assert.equal(saved.entry_channel_id, entryRoom.id);
  assert.equal(saved.grant_mode, "automatic");
});

test("legacy Welcome Pass settings are retained but show Setup needed when the newer approved-member destination is absent", async () => {
  const { guild, addChannel, addRole } = createGuild("welcome-legacy-settings");
  const role = addRole("legacy-role", "STAY");
  const alerts = addChannel("legacy-alerts");
  const panel = addChannel("legacy-panel");
  roomStore.savePanel({ guildId: guild.id, channelId: panel.id, messageId: "legacy-message", enabled: true });
  welcomePassStore.saveWelcomePassSettings({
    guildId: guild.id,
    roleId: role.id,
    channelId: alerts.id,
    releaseMessage: welcomePassStore.DEFAULT_RELEASE_MESSAGE,
  });

  const before = welcomePassStore.getWelcomePassSettings(guild.id);
  assert.equal(before.role_id, role.id);
  assert.equal(before.channel_id, alerts.id);
  assert.equal(before.release_channel_id, null);

  const open = guardInteraction(guild, "harmony-admin-room:welcome", { channelId: panel.id, message: { id: "legacy-message" } });
  await room.handleAdminRoomInteraction(open);
  assert.match(open.response.embeds[0].data.description, /Status:\*\* Setup needed/);
  assert.ok(open.response.embeds[0].data.description.includes(`Approved Role:** @${role.name}`));
  assert.ok(open.response.embeds[0].data.description.includes(`Pass Submission Alerts:** <#${alerts.id}>`));
  assert.match(open.response.embeds[0].data.description, /Approved Member Welcome Channel:\*\* Not selected/);
  const after = welcomePassStore.getWelcomePassSettings(guild.id);
  assert.equal(after.role_id, before.role_id);
  assert.equal(after.channel_id, before.channel_id);
  assert.equal(after.release_channel_id, null, "opening the manager does not reset or fabricate the missing new setting");
});

test("legacy Welcome Pass installations keep using the existing Greetings entry channel until overridden", async () => {
  const { guild, addChannel, addRole } = createGuild("welcome-manager-legacy-entry");
  const greetingEntry = addChannel("legacy-greeting-entry");
  const explicitEntry = addChannel("explicit-welcome-entry");
  const alerts = addChannel("legacy-staff-alerts");
  const approved = addChannel("legacy-approved-room");
  const role = addRole("legacy-stay", "STAY");
  const panelChannel = addChannel("legacy-admin-panel");
  greetingStore.saveGreetingSettings({
    guildId: guild.id,
    channelId: greetingEntry.id,
    entranceMessage: "Complete your Welcome Pass, {member}!",
    exitMessage: "Goodbye, {name}.",
  });
  welcomePassStore.saveWelcomePassSettings({
    guildId: guild.id,
    roleId: role.id,
    channelId: alerts.id,
    releaseChannelId: approved.id,
    releaseMessage: "Approved {member}.",
  });
  roomStore.savePanel({ guildId: guild.id, channelId: panelChannel.id, messageId: "legacy-admin-message", enabled: true });

  const open = guardInteraction(guild, "harmony-admin-room:welcome", { channelId: panelChannel.id, message: { id: "legacy-admin-message" } });
  await room.handleAdminRoomInteraction(open);
  const summary = open.response.embeds[0].data.description;
  assert.match(summary, /Status:\*\* Configured/);
  assert.ok(summary.includes(`Welcome Pass Entry Channel:** <#${greetingEntry.id}> (following the current entrance greeting channel)`));
  assert.equal(resolveWelcomePassEntryChannelId(welcomePassStore.getWelcomePassSettings(guild.id), greetingStore.getGreetingSettings(guild.id)), greetingEntry.id);
  assert.equal(resolveWelcomePassEntryMessage(welcomePassStore.getWelcomePassSettings(guild.id), greetingStore.getGreetingSettings(guild.id)), "Complete your Welcome Pass, {member}!");

  const picker = guardInteraction(guild, "harmony-admin-room:welcome-entry");
  await room.handleAdminRoomInteraction(picker);
  await room.handleAdminRoomInteraction(guardInteraction(guild, "harmony-admin-room:welcome-entry-select", { values: [explicitEntry.id] }));
  const saved = welcomePassStore.getWelcomePassSettings(guild.id);
  assert.equal(saved.entry_channel_id, explicitEntry.id);
  assert.equal(saved.channel_id, alerts.id);
  assert.equal(saved.release_channel_id, approved.id);
  assert.equal(greetingStore.getGreetingSettings(guild.id).channel_id, greetingEntry.id, "Welcome Pass override does not change Greetings or exit-message destination");
  assert.equal(resolveWelcomePassEntryChannelId(saved, greetingStore.getGreetingSettings(guild.id)), explicitEntry.id);
  assert.equal(resolveWelcomePassEntryMessage(saved, greetingStore.getGreetingSettings(guild.id)), "Complete your Welcome Pass, {member}!");
});

test("slash-style Welcome Pass setup updates preserve an existing entry-channel override", () => {
  const guildId = "welcome-entry-preserve-on-setup";
  const original = {
    guildId,
    roleId: "preserve-role",
    channelId: "preserve-staff",
    releaseChannelId: "preserve-approved",
    entryChannelId: "preserve-entry",
    entryMessage: "Persisted entry text {member}",
    releaseMessage: "Original message",
  };
  welcomePassStore.saveWelcomePassSettings(original);
  welcomePassStore.saveWelcomePassSettings({
    ...original,
    entryChannelId: undefined,
    entryMessage: undefined,
    releaseMessage: "Updated message",
  });
  const saved = welcomePassStore.getWelcomePassSettings(guildId);
  assert.equal(saved.entry_channel_id, "preserve-entry");
  assert.equal(saved.entry_message, "Persisted entry text {member}");
  assert.equal(saved.release_message, "Updated message");
});

test("Welcome Pass unauthorized controls are rejected and unfinished setup can be discarded", async () => {
  const { guild, addChannel } = createGuild("welcome-manager-auth");
  const channel = addChannel("welcome-auth-panel");
  roomStore.savePanel({ guildId: guild.id, channelId: channel.id, messageId: "welcome-auth-message", enabled: true });
  const start = guardInteraction(guild, "harmony-admin-room:welcome", { channelId: channel.id, message: { id: "welcome-auth-message" } });
  await room.handleAdminRoomInteraction(start);
  await room.handleAdminRoomInteraction(guardInteraction(guild, "harmony-admin-room:welcome-role"));
  let response;
  await room.handleAdminRoomInteraction({
    ...guardInteraction(guild, "harmony-admin-room:welcome-role-select", { values: ["forged-role"] }),
    memberPermissions: permissionSet(false),
    reply: async (payload) => { response = payload; },
  });
  assert.match(response.content, /authorized server admins/i);
  assert.equal(welcomePassStore.getWelcomePassSettings(guild.id), null);

  const cancel = guardInteraction(guild, "harmony-admin-room:welcome-cancel");
  await room.handleAdminRoomInteraction(cancel);
  assert.match(cancel.response.embeds[0].data.description, /selections were discarded/i);
  assert.equal(welcomePassStore.getWelcomePassSettings(guild.id), null);
});

test("Welcome Pass ephemeral navigation is rejected after its source Admin Controls panel moves", async () => {
  const { guild, addChannel } = createGuild("welcome-manager-stale-navigation");
  const oldChannel = addChannel("old-admin-room");
  roomStore.savePanel({ guildId: guild.id, channelId: oldChannel.id, messageId: "old-admin-panel", enabled: true });
  await room.handleAdminRoomInteraction(guardInteraction(guild, "harmony-admin-room:welcome", {
    channelId: oldChannel.id,
    message: { id: "old-admin-panel" },
  }));
  roomStore.savePanel({ guildId: guild.id, channelId: "new-admin-room", messageId: "new-admin-panel", enabled: true });
  const back = guardInteraction(guild, "harmony-admin-room:welcome:ephemeral");
  await room.handleAdminRoomInteraction(back);
  assert.match(back.response.content, /no longer active/i);
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
