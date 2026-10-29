const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChannelType, PermissionFlagsBits } = require("discord.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-media-manager-test-"));
process.env.HARMONY_DB_PATH = path.join(tempDir, "media-manager.sqlite");

const { getDb, closeDb } = require("../src/db/sqlite");
const roomStore = require("../src/stores/adminRoomStore");
const errorInboxStore = require("../src/stores/errorInboxStore");
const errorMonitorStore = require("../src/stores/errorMonitorStore");
const shareStore = require("../src/stores/shareStore");
const manager = require("../src/services/adminRoomService");
const errorInboxCommand = require("../src/commands/errorInbox");
const errorMonitorCommand = require("../src/commands/errorMonitor");
const forgetCommand = require("../src/commands/forgetShare");
const errorMonitorService = require("../src/services/errorMonitorService");

getDb();

function fixture(guildId = "media-manager-guild") {
  const channels = new Map();
  const sent = new Map();
  const me = { id: "bot", permissions: { has: () => true } };
  const guild = {
    id: guildId,
    name: `Guild ${guildId}`,
    ownerId: "owner-id",
    members: { me },
    channels: {
      cache: channels,
      fetch: async (id) => channels.get(id) || null,
    },
  };
  function addChannel(id, { send, permissions = () => true } = {}) {
    const channel = {
      id,
      guildId,
      name: id,
      type: ChannelType.GuildText,
      isTextBased: () => true,
      permissionsFor: () => ({ has: permissions }),
      send: async (payload) => {
        if (send) return send(payload);
        const messages = sent.get(id) || [];
        messages.push(payload);
        sent.set(id, messages);
        return { id: `sent-${messages.length}` };
      },
    };
    channels.set(id, channel);
    return channel;
  }
  const client = {
    guilds: { cache: new Map([[guildId, guild]]), fetch: async (id) => id === guildId ? guild : null },
  };
  roomStore.savePanel({ guildId, channelId: "admin-room", messageId: "admin-panel", enabled: true });
  addChannel("admin-room");
  return { guild, client, addChannel, sent };
}

function interaction(f, customId, overrides = {}) {
  let response;
  let modal;
  const value = {
    customId,
    guild: f.guild,
    guildId: f.guild.id,
    channelId: "admin-room",
    message: { id: "admin-panel" },
    user: { id: "admin-id", username: "Admin" },
    member: { permissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild } },
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    client: f.client,
    values: [],
    options: { getSubcommand: () => "status", getString: () => "not-a-link" },
    fields: { getTextInputValue: () => "not-a-link" },
    isButton: () => !overrides.modal && !overrides.select,
    isChannelSelectMenu: () => Boolean(overrides.select),
    isModalSubmit: () => Boolean(overrides.modal),
    reply: async (payload) => { response = payload; return payload; },
    update: async (payload) => { response = payload; return payload; },
    deferUpdate: async () => { value.deferred = true; },
    editReply: async (payload) => { response = payload; return payload; },
    deferReply: async () => { value.deferred = true; },
    showModal: async (payload) => { modal = payload; },
    get response() { return response; },
    get modal() { return modal; },
    ...overrides,
  };
  return value;
}

async function openManager(f) {
  const open = interaction(f, "harmony-admin-room:media");
  await manager.handleAdminRoomInteraction(open);
  return open.response;
}

test("opening the manager is read-only and shows global inbox and monitor state without secrets", async () => {
  const f = fixture("media-read-only");
  const result = await openManager(f);
  assert.equal(result.flags, 64);
  assert.match(result.embeds[0].data.title, /Media & Errors Manager/);
  assert.match(result.embeds[0].data.description, /MEDIA ERROR INBOX/);
  assert.match(result.embeds[0].data.description, /Scope:\*\* Media failures from every server Harmony serves/);
  assert.match(result.embeds[0].data.description, /private troubleshooting channel.*trusted admins/i);
  assert.match(result.embeds[0].data.description, /AUTOMATIC ERROR MONITOR/);
  assert.match(result.embeds[0].data.description, /Automatic merging\/deployment: \*\*Off/);
  assert.match(result.embeds[0].data.description, /FORGET SHARED POST/);
  assert.equal(errorInboxStore.getErrorInboxSettings(), null);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM error_monitor_settings").get().n, 0);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM error_inbox_settings").get().n, 0);
  assert.doesNotMatch(JSON.stringify(result), /github-token-value|cookie-secret|oauth-secret/);
});

test("global inbox destination is displayed while off and On restores it without changing the destination", async () => {
  const f = fixture("media-inbox-toggle");
  const destination = f.addChannel("private-errors");
  errorInboxStore.saveErrorInboxSettings(f.guild.id, destination.id);
  errorInboxStore.disableErrorInbox();
  const payload = await openManager(f);
  assert.match(payload.embeds[0].data.description, /Status:\*\* Off/);
  assert.match(payload.embeds[0].data.description, /Guild media-inbox-toggle · #private-errors/);
  const turnOn = interaction(f, "harmony-admin-room:media-inbox-toggle");
  await manager.handleAdminRoomInteraction(turnOn);
  const saved = errorInboxStore.getErrorInboxSettings();
  assert.equal(saved.enabled, 1);
  assert.equal(saved.destination_guild_id, f.guild.id);
  assert.equal(saved.destination_channel_id, destination.id);
  assert.match(turnOn.response.embeds[0].data.description, /Status:\*\* On/);
});

test("changing the inbox tests posting before save and failed tests preserve the old destination", async () => {
  const f = fixture("media-inbox-change");
  errorInboxStore.saveErrorInboxSettings("previous-guild", "previous-channel");
  const required = new Set([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
  let sawOldSettingDuringTest = false;
  const candidate = f.addChannel("new-errors", {
    permissions: (permission) => required.has(permission),
    send: async (payload) => {
      sawOldSettingDuringTest = errorInboxStore.getErrorInboxSettings().destination_channel_id === "previous-channel";
      assert.match(payload.embeds[0].data.title, /error inbox is ready/i);
      return { id: "probe" };
    },
  });
  await openManager(f);
  const select = interaction(f, "harmony-admin-room:media-error-inbox-select", { select: true, values: [candidate.id] });
  await manager.handleAdminRoomInteraction(select);
  assert.equal(sawOldSettingDuringTest, true);
  assert.equal(errorInboxStore.getErrorInboxSettings().destination_channel_id, candidate.id);

  const oldSettings = errorInboxStore.getErrorInboxSettings();
  const denied = f.addChannel("denied-errors", { permissions: (permission) => permission !== PermissionFlagsBits.EmbedLinks });
  const deniedSelect = interaction(f, "harmony-admin-room:media-error-inbox-select", { select: true, values: [denied.id] });
  await manager.handleAdminRoomInteraction(deniedSelect);
  assert.match(deniedSelect.response.content, /View Channel.*Send Messages.*Embed Links/);
  assert.equal(errorInboxStore.getErrorInboxSettings().destination_channel_id, oldSettings.destination_channel_id);

  const failing = f.addChannel("failing-errors", {
    permissions: (permission) => required.has(permission),
    send: async () => { throw new Error("private low-level failure"); },
  });
  const failedSelect = interaction(f, "harmony-admin-room:media-error-inbox-select", { select: true, values: [failing.id] });
  await manager.handleAdminRoomInteraction(failedSelect);
  assert.equal(errorInboxStore.getErrorInboxSettings().destination_channel_id, oldSettings.destination_channel_id);
  assert.doesNotMatch(JSON.stringify(failedSelect.response), /private low-level failure/);
  assert.match(failedSelect.response.embeds[0].data.description, /saved Error Inbox was not changed/i);
});

test("Send Test uses the saved global error-inbox behavior", async () => {
  const f = fixture("media-inbox-test");
  const destination = f.addChannel("central-errors");
  errorInboxStore.saveErrorInboxSettings(f.guild.id, destination.id);
  await openManager(f);
  const send = interaction(f, "harmony-admin-room:media-inbox-test");
  await manager.handleAdminRoomInteraction(send);
  assert.equal(f.sent.get(destination.id).length, 1);
  assert.match(f.sent.get(destination.id)[0].embeds[0].data.title, /error inbox is ready/i);
  assert.match(send.response.embeds[0].data.description, /Test delivered to the central Error Inbox/);
});

test("monitor toggle validates configuration, keeps reports private, and Off preserves settings semantics", async () => {
  const f = fixture("media-monitor");
  const previous = {
    HARMONY_ERROR_GITHUB_TOKEN: process.env.HARMONY_ERROR_GITHUB_TOKEN,
    HARMONY_ERROR_GITHUB_REPO: process.env.HARMONY_ERROR_GITHUB_REPO,
  };
  delete process.env.HARMONY_ERROR_GITHUB_TOKEN;
  delete process.env.HARMONY_ERROR_GITHUB_REPO;
  await openManager(f);
  const rejected = interaction(f, "harmony-admin-room:media-monitor-toggle");
  await manager.handleAdminRoomInteraction(rejected);
  assert.match(rejected.response.embeds[0].data.description, /setup is missing or invalid.*Ask the owner/i);
  assert.equal(errorMonitorStore.getErrorMonitorSettings().enabled, 0);
  assert.doesNotMatch(JSON.stringify(rejected.response), /HARMONY_ERROR_GITHUB_TOKEN|token|secret/i);

  process.env.HARMONY_ERROR_GITHUB_TOKEN = "private-github-token-value";
  process.env.HARMONY_ERROR_GITHUB_REPO = "owner/private-errors";
  assert.equal(errorMonitorService.isErrorMonitorConfigured(), true);
  const enabled = interaction(f, "harmony-admin-room:media-monitor-toggle");
  await manager.handleAdminRoomInteraction(enabled);
  assert.equal(errorMonitorStore.getErrorMonitorSettings().enabled, 1);
  assert.match(enabled.response.embeds[0].data.description, /Automatic Error Monitor is on/);
  assert.doesNotMatch(JSON.stringify(enabled.response), /private-github-token-value|owner\/private-errors/);
  const off = interaction(f, "harmony-admin-room:media-monitor-toggle");
  await manager.handleAdminRoomInteraction(off);
  assert.equal(errorMonitorStore.getErrorMonitorSettings().enabled, 0);
  assert.match(off.response.embeds[0].data.description, /Existing reports were left in place/);
  assert.equal(errorMonitorService.isErrorMonitorConfigured(), true);
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("Forget Shared Post modal uses the slash command resolver and removal behavior", async () => {
  const f = fixture("media-forget");
  await openManager(f);
  const button = interaction(f, "harmony-admin-room:media-forget");
  await manager.handleAdminRoomInteraction(button);
  const modalData = button.modal.toJSON();
  assert.match(modalData.title, /Forget Shared Post/);
  assert.equal(modalData.components[0].components[0].label, "Social Post Link");
  assert.match(modalData.components[0].components[0].placeholder, /Instagram.*Facebook.*TikTok.*X.*YouTube.*Threads/);

  const url = "https://www.instagram.com/p/MEDIAFORGET123/";
  const key = await forgetCommand.resolveShareKey(url);
  shareStore.insert({ platform: key.platform, mediaId: key.mediaId, sharedBy: "Member", guildId: f.guild.id });
  const submit = interaction(f, "harmony-admin-room:media-forget-submit", { modal: true, fields: { getTextInputValue: () => url } });
  await manager.handleAdminRoomInteraction(submit);
  assert.match(submit.response.content, /can be shared again/);
  assert.equal(shareStore.find(key.platform, key.mediaId, f.guild.id), null);

  const missing = interaction(f, "harmony-admin-room:media-forget-submit", { modal: true, fields: { getTextInputValue: () => "https://www.instagram.com/p/NOTSAVED123/" } });
  await manager.handleAdminRoomInteraction(missing);
  assert.match(missing.response.content, /doesn’t currently have that post saved/);

  const invalid = interaction(f, "harmony-admin-room:media-forget-submit", { modal: true, fields: { getTextInputValue: () => "https://example.com/not-supported" } });
  await manager.handleAdminRoomInteraction(invalid);
  assert.match(invalid.response.content, /Instagram, Facebook, TikTok, X, YouTube, or Threads/);
});

test("Forget Shared Post resolver retains all six supported platforms", async () => {
  const links = [
    ["instagram", "https://www.instagram.com/p/ABC123/"],
    ["facebook", "https://www.facebook.com/share/p/ABC123/"],
    ["tiktok", "https://www.tiktok.com/@stay/video/1234567890123456789"],
    ["x", "https://x.com/stay/status/1234567890123456789"],
    ["youtube", "https://www.youtube.com/watch?v=abcdefghijk"],
    ["threads", "https://www.threads.com/@stay/post/ABC123"],
  ];
  for (const [platform, link] of links) {
    assert.equal((await forgetCommand.resolveShareKey(link)).platform, platform);
  }
});

test("manager stale-session protection and Close work without changing global configuration", async () => {
  const f = fixture("media-stale");
  const open = await openManager(f);
  assert.equal(open.flags, 64);
  roomStore.savePanel({ guildId: f.guild.id, channelId: "admin-room", messageId: "replacement-panel", enabled: true });
  const stale = interaction(f, "harmony-admin-room:media-refresh");
  await manager.handleAdminRoomInteraction(stale);
  assert.match(stale.response.content, /no longer active/);

  roomStore.savePanel({ guildId: f.guild.id, channelId: "admin-room", messageId: "admin-panel", enabled: true });
  await openManager(f);
  const close = interaction(f, "harmony-admin-room:media-close");
  await manager.handleAdminRoomInteraction(close);
  assert.match(close.response.content, /closed/);
  assert.deepEqual(close.response.components, []);
  assert.equal(errorInboxStore.getErrorInboxSettings().destination_channel_id, "central-errors");
});

test("expired manager sessions are rejected after fifteen minutes", async () => {
  const f = fixture("media-expired");
  await openManager(f);
  const actualNow = Date.now;
  try {
    Date.now = () => actualNow() + 16 * 60 * 1000;
    const expired = interaction(f, "harmony-admin-room:media-refresh");
    await manager.handleAdminRoomInteraction(expired);
    assert.match(expired.response.content, /no longer active/);
  } finally {
    Date.now = actualNow;
  }
});

test("the three established slash commands remain registered and functional", async () => {
  assert.equal(errorInboxCommand.data.name, "harmony-errors");
  assert.deepEqual(errorInboxCommand.data.toJSON().options.map((item) => item.name), ["setup", "status", "test", "off"]);
  assert.equal(errorMonitorCommand.data.name, "harmony-monitor");
  assert.deepEqual(errorMonitorCommand.data.toJSON().options.map((item) => item.name), ["on", "off", "status"]);
  assert.equal(forgetCommand.data.name, "harmony-forget");

  const f = fixture("media-slash-compat");
  const slashInbox = f.addChannel("slash-private-errors");
  const setup = interaction(f, "", { options: { getSubcommand: () => "setup", getChannel: () => slashInbox } });
  await errorInboxCommand.execute(setup);
  assert.match(setup.response, /Media failures from \*\*every server Harmony is in\*\*/);
  assert.equal(errorInboxStore.getErrorInboxSettings().destination_channel_id, slashInbox.id);
  assert.equal(f.sent.get(slashInbox.id).length, 2, "setup keeps the posting-permission probe and sends its test report");
  const testInbox = interaction(f, "", { options: { getSubcommand: () => "test" } });
  await errorInboxCommand.execute(testInbox);
  assert.match(testInbox.response, /Test delivered/);
  const offInbox = interaction(f, "", { options: { getSubcommand: () => "off" } });
  await errorInboxCommand.execute(offInbox);
  assert.equal(errorInboxStore.getErrorInboxSettings().enabled, 0);
  assert.equal(errorInboxStore.getErrorInboxSettings().destination_channel_id, slashInbox.id);

  const status = interaction(f, "", { options: { getSubcommand: () => "status" } });
  await errorInboxCommand.execute(status);
  assert.match(status.response, /central error inbox is off/i);
  const monitorStatus = interaction(f, "", { options: { getSubcommand: () => "status" } });
  await errorMonitorCommand.execute(monitorStatus);
  assert.match(monitorStatus.response, /Sanitized media failures only/);
  const previousToken = process.env.HARMONY_ERROR_GITHUB_TOKEN;
  const previousRepo = process.env.HARMONY_ERROR_GITHUB_REPO;
  process.env.HARMONY_ERROR_GITHUB_TOKEN = "private-token-never-output";
  process.env.HARMONY_ERROR_GITHUB_REPO = "owner/private-errors";
  const monitorOn = interaction(f, "", { options: { getSubcommand: () => "on" } });
  await errorMonitorCommand.execute(monitorOn);
  assert.equal(errorMonitorStore.getErrorMonitorSettings().enabled, 1);
  assert.match(monitorOn.response, /nothing will merge or deploy automatically/i);
  const monitorOff = interaction(f, "", { options: { getSubcommand: () => "off" } });
  await errorMonitorCommand.execute(monitorOff);
  assert.equal(errorMonitorStore.getErrorMonitorSettings().enabled, 0);
  assert.match(monitorOff.response, /existing private reports were left in place/i);
  for (const [name, value] of [["HARMONY_ERROR_GITHUB_TOKEN", previousToken], ["HARMONY_ERROR_GITHUB_REPO", previousRepo]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const forget = interaction(f, "", { options: { getString: () => "https://example.com/nope" } });
  await forgetCommand.execute(forget);
  assert.match(forget.response.content, /Instagram, Facebook, TikTok, X, YouTube, or Threads/);
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
