const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-guard-test-"));
process.env.HARMONY_DB_PATH = path.join(tempDir, "guard.sqlite");

const { getDb, closeDb } = require("../src/db/sqlite");
const store = require("../src/stores/communityGuardStore");
const guard = require("../src/services/communityGuardService");
const command = require("../src/commands/communityGuard");

let sequence = 0;
function guildId() { sequence += 1; return `guard-test-${sequence}`; }
function message({ guild, content = "", attachments = [], author = {}, id = `message-${sequence}` } = {}) {
  return {
    id,
    guild,
    guildId: guild?.id,
    channelId: "source-channel",
    content,
    author: { id: "member-1", username: "Member", globalName: "Member One", bot: false, send: async () => true, ...author },
    attachments: new Map(attachments.map((file, index) => [String(index), file])),
    channel: { messages: { fetch: async () => ({ filter: () => new Map() }) } },
    client: { user: { id: "harmony-bot" } },
    delete: async () => {},
  };
}

function setupGuild(id, { roomAvailable = true, failRoomSend = false } = {}) {
  const posted = [];
  const room = {
    id: "review-room",
    isTextBased: () => true,
    send: async (payload) => {
      if (failRoomSend) throw new Error("send denied");
      const sent = { ...payload, id: `review-${posted.length + 1}`, channelId: "review-room", edit: async (update) => Object.assign(sent, update) };
      posted.push(sent);
      return sent;
    },
    messages: { fetch: async (id) => posted.find((item) => item.id === id) || null },
  };
  const guild = {
    id,
    roles: { everyone: { id: "everyone" }, cache: new Map() },
    channels: {
      cache: new Map(roomAvailable ? [["review-room", room]] : []),
      fetch: async (id) => id === "review-room" && roomAvailable ? room : null,
    },
  };
  return { guild, room, posted };
}

test("new phrase rules use whole-word matching while legacy rules retain substring behavior", () => {
  const oldRuleId = store.addRule({ guildId: "legacy", type: "phrase", pattern: "sale", action: "flag", category: "other" });
  const legacy = store.getRule("legacy", oldRuleId);
  assert.equal(guard.ruleMatches(legacy, message({ content: "wholesale price" })), true);

  const id = guard.createRule({ guildId: "new", conditions: [{ type: "phrase", value: "sale" }], category: "other" });
  const rule = store.getRule("new", id);
  assert.equal(rule.action, "flag");
  assert.equal(guard.ruleMatches(rule, message({ content: "wholesale price" })), false);
  assert.equal(guard.ruleMatches(rule, message({ content: "For sale today" })), true);
  const phraseId = guard.createRule({ guildId: "phrase", conditions: [{ type: "phrase", value: "bubble messages" }], category: "paid" });
  assert.equal(guard.ruleMatches(store.getRule("phrase", phraseId), message({ content: "Shared BUBBLE   messages yesterday" })), true);
});

test("additive Guard migration preserves existing rule rows and leaves their condition payload legacy-null", () => {
  const { DatabaseSync } = require("node:sqlite");
  const { migrate } = require("../src/db/sqlite");
  const legacy = new DatabaseSync(":memory:");
  legacy.exec(`CREATE TABLE community_guard_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL,
    rule_type TEXT NOT NULL CHECK (rule_type IN ('domain', 'url', 'phrase')),
    pattern TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('flag', 'remove')),
    category TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  INSERT INTO community_guard_rules (guild_id, rule_type, pattern, action, category, created_at)
  VALUES ('preserve-me', 'phrase', 'sale', 'remove', 'spam', '2026-01-01T00:00:00.000Z');`);
  migrate(legacy);
  const saved = legacy.prepare("SELECT * FROM community_guard_rules WHERE guild_id = 'preserve-me'").get();
  assert.equal(saved.pattern, "sale");
  assert.equal(saved.action, "remove");
  assert.equal(saved.conditions_json, null);
  assert.equal(saved.match_mode, "all");
  legacy.close();
});

test("compound ALL and ANY conditions support Bubble text plus image without matching ordinary discussion", () => {
  const guild = guildId();
  const allId = guard.createRule({
    guildId: guild, name: "Possible Bubble Content Sharing", matchMode: "all", category: "paid",
    conditions: [{ type: "phrase", value: "Bubble" }, { type: "has_image_attachment" }],
  });
  const all = store.getRule(guild, allId);
  assert.equal(guard.ruleMatches(all, message({ content: "Did you see what he said on Bubble?" })), false);
  assert.equal(guard.ruleMatches(all, message({ content: "Someone shared this on Bubble", attachments: [{ name: "screen.png", contentType: "image/png" }] })), true);
  assert.equal(guard.ruleMatches(all, message({ content: "Someone shared this on Bubble", attachments: [{ name: "screen.dat", contentType: "application/octet-stream" }] })), false);

  const anyId = guard.createRule({
    guildId: guild, matchMode: "any", category: "other",
    conditions: [{ type: "phrase", value: "Bubble" }, { type: "has_attachment" }],
  });
  const any = store.getRule(guild, anyId);
  assert.equal(guard.ruleMatches(any, message({ content: "Are you subscribed to Bubble?" })), true);
  assert.equal(guard.ruleMatches(any, message({ content: "hello" })), false);
});

test("domain and URL conditions preserve domain boundary and URL-substring rules", () => {
  const domain = { rule_type: "domain", pattern: "www.example.com", conditions_json: null };
  assert.equal(guard.ruleMatches(domain, message({ content: "https://shop.example.com/item" })), true);
  assert.equal(guard.ruleMatches(domain, message({ content: "https://example.com.evil.test/item" })), false);
  const urlGuild = guildId();
  const urlId = guard.createRule({ guildId: urlGuild, conditions: [{ type: "url", value: "instagram.com/p/abc" }], category: "spam" });
  assert.equal(guard.ruleMatches(store.getRule(urlGuild, urlId), message({ content: "https://www.instagram.com/p/ABC123" })), true);
  assert.equal(guard.ruleMatches(store.getRule(urlGuild, urlId), message({ content: "https://www.instagram.com/reel/ABC123" })), false);
});

test("rule editing changes rule configuration without replacing its ID", () => {
  const guild = guildId();
  const id = guard.createRule({ guildId: guild, name: "First", conditions: [{ type: "phrase", value: "sale" }], category: "other" });
  store.addAction({ guildId: guild, messageId: "historic", channelId: "c", userId: "u", category: "other", source: "test", ruleId: id, dmDelivered: true });
  assert.equal(guard.editRule(guild, id, {
    name: "Possible sharing", matchMode: "all", category: "paid", action: "flag",
    conditions: [{ type: "phrase", value: "bubble" }, { type: "has_image_attachment" }],
  }), true);
  const updated = store.getRule(guild, id);
  assert.equal(updated.name, "Possible sharing");
  assert.equal(updated.category, "paid");
  assert.equal(updated.match_mode, "all");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM community_guard_actions WHERE guild_id = ? AND rule_id = ?").get(guild, id).count, 1);
});

test("review card includes matched conditions, message text and attachment metadata; repeats update rather than duplicate", async () => {
  const id = guildId();
  const { guild, posted } = setupGuild(id);
  store.saveSettings(id, "review-room");
  const ruleId = guard.createRule({
    guildId: id, name: "Possible Bubble Content Sharing", category: "paid", matchMode: "all",
    conditions: [{ type: "phrase", value: "Bubble" }, { type: "has_image_attachment" }],
  });
  const member = { id: "member-1", username: "Member", globalName: "Member One", bot: false, send: async () => assert.fail("flagging must not DM the member") };
  const original = message({ guild, id: "bubble-1", content: "Look at this Bubble image", author: member, attachments: [{ name: "bubble-screen.png", contentType: "image/png" }] });
  assert.equal(await guard.handleGuardedMessage(original), true);
  assert.equal(posted.length, 1);
  const embed = posted[0].embeds[0].data;
  assert.match(embed.description, /Possible Bubble Content Sharing/);
  assert.match(embed.description, /Paid content/);
  assert.match(embed.description, /Text contains “bubble”/i);
  assert.match(embed.description, /Message has an image attachment/);
  assert.match(embed.description, /Look at this Bubble image/);
  assert.match(embed.description, /bubble-screen\.png — image\/png/);
  assert.match(embed.description, /Open original message/);
  assert.deepEqual(posted[0].allowedMentions, { parse: [] });
  const edited = message({ guild, id: "bubble-1", content: "Updated Bubble screenshot", author: member, attachments: [{ name: "bubble-screen.png", contentType: "image/png" }] });
  assert.equal(await guard.handleGuardedMessage(edited, { edited: true }), true);
  assert.equal(posted.length, 1);
  assert.match(posted[0].embeds[0].data.description, /Updated Bubble screenshot/);
});

test("edited messages are screened; nonmatching edits close pending review and bot edits are ignored", async () => {
  const id = guildId();
  const { guild, posted } = setupGuild(id);
  store.saveSettings(id, "review-room");
  guard.createRule({ guildId: id, category: "other", conditions: [{ type: "phrase", value: "prohibited phrase" }] });
  const initial = message({ guild, id: "edited-1", content: "prohibited phrase" });
  assert.equal(await guard.handleGuardedMessage(initial), true);
  assert.equal(posted.length, 1);
  assert.equal(await guard.handleGuardedMessage(message({ guild, id: "edited-1", content: "ordinary text" }), { edited: true }), false);
  assert.deepEqual(posted[0].components, []);
  assert.equal(store.getMessageState(id, "edited-1").status, "resolved");
  const botMessage = message({ guild, id: "bot-1", content: "prohibited phrase", author: { bot: true } });
  assert.equal(await guard.handleGuardedMessage(botMessage, { edited: true }), false);
  assert.equal(posted.length, 1);
});

test("missing Guard Review Room does not hold flagged messages or leave pending review state", async () => {
  const id = guildId();
  const { guild } = setupGuild(id, { roomAvailable: false });
  store.saveSettings(id, "review-room");
  guard.createRule({ guildId: id, category: "other", conditions: [{ type: "phrase", value: "review me" }] });
  assert.equal(await guard.handleGuardedMessage(message({ guild, id: "no-room", content: "review me" })), false);
  assert.equal(store.getMessageState(id, "no-room").status, "resolved");
});

test("failed review-room send does not leave a message pending", async () => {
  const id = guildId();
  const { guild } = setupGuild(id, { failRoomSend: true });
  store.saveSettings(id, "review-room");
  guard.createRule({ guildId: id, category: "other", conditions: [{ type: "phrase", value: "review me" }] });
  assert.equal(await guard.handleGuardedMessage(message({ guild, id: "send-fails", content: "review me" })), false);
  assert.equal(store.getMessageState(id, "send-fails").status, "resolved");
});

test("automatic removal deletes, privately messages, cleans Collection contribution and records history", async () => {
  const id = guildId();
  const { guild, posted } = setupGuild(id);
  store.saveSettings(id, "review-room");
  const ruleId = guard.createRule({ guildId: id, category: "spam", action: "remove", conditions: [{ type: "domain", value: "bad.example" }] });
  let deleted = false;
  const dms = [];
  const target = message({ guild, id: "auto-remove", content: "https://bad.example/scam", author: { send: async (payload) => dms.push(payload.content) } });
  target.delete = async () => { deleted = true; };
  assert.equal(await guard.handleGuardedMessage(target), true);
  assert.equal(deleted, true);
  assert.equal(dms.length, 1);
  assert.match(dms[0], /possible spam or an unsafe link/);
  assert.equal(posted.length, 1);
  assert.match(posted[0].embeds[0].data.title, /Community Guard Removal/);
  const action = getDb().prepare("SELECT * FROM community_guard_actions WHERE guild_id = ? AND message_id = ?").get(id, "auto-remove");
  assert.equal(action.rule_id, ruleId);
  assert.equal(action.dm_delivered, 1);
  assert.equal(store.getMessageState(id, "auto-remove").status, "removed");
});

test("delete failure does not DM or record a removal", async () => {
  const id = guildId();
  const { guild } = setupGuild(id);
  store.saveSettings(id, "review-room");
  guard.createRule({ guildId: id, category: "spam", action: "remove", conditions: [{ type: "domain", value: "bad.example" }] });
  let dmCount = 0;
  const target = message({ guild, id: "delete-fails", content: "https://bad.example/x", author: { send: async () => { dmCount += 1; } } });
  target.delete = async () => { throw new Error("missing permission"); };
  assert.equal(await guard.handleGuardedMessage(target), true);
  assert.equal(dmCount, 0);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM community_guard_actions WHERE message_id = ?").get("delete-fails").count, 0);
});

test("Mark Safe stores the decision, removes controls, and is restricted to Manage Messages", async () => {
  const id = guildId();
  const { guild, posted } = setupGuild(id);
  store.saveSettings(id, "review-room");
  const ruleId = guard.createRule({ guildId: id, category: "other", conditions: [{ type: "phrase", value: "review me" }] });
  const target = message({ guild, id: "safe-target", content: "review me" });
  guild.channels.cache.set("source-channel", { isTextBased: () => true, messages: { fetch: async (id) => id === target.id ? target : null } });
  assert.equal(await guard.handleGuardedMessage(target), true);
  const unauthorizedResponses = [];
  const unauthorized = {
    customId: `guard_safe:${ruleId}:source-channel:safe-target`, guild,
    memberPermissions: { has: () => false }, isButton: () => true, isStringSelectMenu: () => false,
    reply: async (payload) => unauthorizedResponses.push(payload),
  };
  assert.equal(await guard.handleGuardComponent(unauthorized), true);
  assert.match(unauthorizedResponses[0].content, /Manage Messages/);
  const responses = [];
  const authorized = {
    customId: `guard_safe:${ruleId}:source-channel:safe-target`, guild, guildId: id,
    memberPermissions: { has: () => true }, user: { id: "mod-1" },
    isButton: () => true, isStringSelectMenu: () => false,
    deferReply: async () => {}, editReply: async (payload) => responses.push(payload),
    message: posted[0],
  };
  assert.equal(await guard.handleGuardComponent(authorized), true);
  assert.equal(store.getMessageState(id, "safe-target").status, "safe");
  assert.equal(getDb().prepare("SELECT marked_by FROM community_guard_safe_messages WHERE guild_id = ? AND message_id = ?").get(id, "safe-target").marked_by, "mod-1");
  assert.deepEqual(posted[0].components, []);
  assert.match(responses[0], /Marked safe/);
});

test("manual right-click moderation remains available while Guard is off and reports missing log room honestly", async () => {
  const id = guildId();
  const ruleCommand = command.data.toJSON();
  assert.ok(ruleCommand.options.some((option) => option.name === "rule-add"));
  assert.equal(ruleCommand.default_member_permissions, String(require("discord.js").PermissionFlagsBits.Administrator));
  const { guild } = setupGuild(id, { roomAvailable: false });
  store.disableSettings(id);
  let deleted = false;
  const target = message({ guild, id: "manual-target", content: "manual" , author: { send: async () => { throw new Error("DM closed"); } } });
  guild.channels.cache.set("source-channel", { isTextBased: () => true, messages: { fetch: async (id) => id === target.id ? target : null } });
  target.delete = async () => { deleted = true; };
  const responses = [];
  const interaction = {
    customId: "guard_manual:source-channel:manual-target", guild, guildId: id,
    memberPermissions: { has: () => true }, values: ["other"], user: { id: "mod-2" },
    isStringSelectMenu: () => true, isButton: () => false,
    deferReply: async () => {}, editReply: async (payload) => responses.push(payload),
  };
  assert.ok(await guard.handleGuardComponent(interaction));
  assert.equal(deleted, true);
  assert.match(responses[0], /no Guard Review Room log could be posted/);
  assert.doesNotMatch(responses[0], /notified the private admin channel/);
});

test("right-click command still offers all six removal reasons privately", async () => {
  const manualCommand = require("../src/commands/moderateMessage");
  assert.equal(manualCommand.data.toJSON().default_member_permissions, String(require("discord.js").PermissionFlagsBits.ManageMessages));
  const replies = [];
  await manualCommand.execute({
    targetMessage: { author: { bot: false }, channelId: "channel", id: "context-message" },
    reply: async (payload) => replies.push(payload),
  });
  assert.equal(replies[0].flags, require("discord.js").MessageFlags.Ephemeral);
  const values = replies[0].components[0].components[0].options.map((option) => option.data.value);
  assert.deepEqual(values, ["paid", "promotion", "inappropriate", "harmful_ai", "spam", "other"]);
});

test("review-room visibility warns for @everyone or ordinary roles and reports when restricted", () => {
  const everyone = { id: "everyone", permissions: { has: () => false } };
  const memberRole = { id: "member", permissions: { has: () => false } };
  const moderatorRole = { id: "mod", permissions: { has: (bit) => bit === require("discord.js").PermissionFlagsBits.ManageMessages } };
  const viewEveryone = { guild: { roles: { everyone, cache: new Map([["everyone", everyone], ["member", memberRole], ["mod", moderatorRole]]) } }, permissionsFor: (role) => ({ has: () => role.id === "everyone" || role.id === "member" }) };
  assert.match(guard.reviewRoomVisibilityWarning(viewEveryone), /appears able to view/);
  const restricted = { guild: viewEveryone.guild, permissionsFor: () => ({ has: () => false }) };
  assert.match(guard.reviewRoomVisibilityWarning(restricted), /do not appear able/);
});

test("setup wording does not claim privacy was verified and rule defaults to review", () => {
  const json = command.data.toJSON();
  const add = json.options.find((option) => option.name === "rule-add");
  assert.equal(add.options.find((option) => option.name === "action").required, false);
  assert.match(add.options.find((option) => option.name === "action").description, /default to Admin Review/);
  assert.ok(add.options.find((option) => option.name === "type").choices.some((choice) => choice.value === "domain"));
  assert.ok(add.options.find((option) => option.name === "type").choices.some((choice) => choice.value === "url"));
  assert.ok(add.options.find((option) => option.name === "type").choices.some((choice) => choice.value === "phrase"));
});

test("Guard off pauses automatic rules; setup re-enables them without removing rules", async () => {
  const id = guildId();
  const { guild, posted } = setupGuild(id);
  store.saveSettings(id, "review-room");
  const ruleId = guard.createRule({ guildId: id, category: "other", conditions: [{ type: "phrase", value: "flag me" }] });
  store.disableSettings(id);
  assert.equal(await guard.handleGuardedMessage(message({ guild, id: "while-off", content: "flag me" })), false);
  assert.equal(posted.length, 0);
  assert.equal(store.getMessageState(id, "while-off"), null);
  store.saveSettings(id, "review-room");
  assert.equal(store.getSettings(id).enabled, 1);
  assert.equal(store.getRule(id, ruleId).id, ruleId);
  assert.equal(await guard.handleGuardedMessage(message({ guild, id: "after-setup", content: "flag me" })), true);
  assert.equal(posted.length, 1);
});

test("slash rule add, view, edit and remove use the shared rule service and preserve the rule ID", async () => {
  const id = guildId();
  store.saveSettings(id, "review-room");
  const responses = [];
  function interaction(action, strings = {}, integers = {}) {
    return {
      guild: { id }, deferReply: async () => {}, editReply: async (reply) => responses.push(reply),
      options: {
        getSubcommand: () => action,
        getString: (name) => strings[name] ?? null,
        getInteger: (name) => integers[name] ?? null,
      },
    };
  }
  await command.execute(interaction("rule-add", { name: "Bubble evidence", type: "phrase", value: "bubble", reason: "paid" }));
  const created = store.listRules(id)[0];
  assert.equal(created.action, "flag");
  await command.execute(interaction("rules"));
  assert.match(responses[1].content, /Bubble evidence/);
  await command.execute(interaction("rule-edit", {
    name: "Bubble image review", "match-mode": "all", reason: "paid", action: "flag",
    "condition-1-type": "phrase", "condition-1-value": "bubble",
    "condition-2-type": "has_image_attachment",
  }, { "rule-id": created.id }));
  assert.equal(store.getRule(id, created.id).name, "Bubble image review");
  assert.equal(store.getRule(id, created.id).conditions_json, '[{"type":"phrase","value":"bubble"},{"type":"has_image_attachment"}]');
  await command.execute(interaction("rule-remove", {}, { "rule-id": created.id }));
  assert.equal(store.getRule(id, created.id), null);
  assert.throws(() => command.collectConditions({
    options: { getString: (name) => name === "condition-2-type" ? "has_image_attachment" : null },
  }, { editing: true }), /provide condition 1/);
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
