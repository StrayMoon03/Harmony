const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-greetings-command-"));
process.env.HARMONY_DB_PATH = path.join(tempDir, "greetings.sqlite");

const { getDb, closeDb } = require("../src/db/sqlite");
const store = require("../src/stores/greetingStore");
const command = require("../src/commands/greetings");

getDb();

function interactionFor(action, guildId) {
  const sent = [];
  const channel = {
    id: "greeting-channel",
    isTextBased: () => true,
    send: async (payload) => { sent.push(payload); },
  };
  const guild = {
    id: guildId,
    name: "Youtiful Stay",
    channels: { cache: new Map([[channel.id, channel]]), fetch: async (id) => id === channel.id ? channel : null },
  };
  const interaction = {
    guild,
    user: { id: "admin-1", username: "admin", globalName: "Admin" },
    member: { displayName: "Admin Display" },
    deferred: false,
    reply: null,
    options: {
      getSubcommand: () => action,
      getChannel: () => channel,
      getString: () => null,
    },
    deferReply: async (payload) => { interaction.deferred = payload; },
    editReply: async (payload) => { interaction.reply = payload; },
  };
  return { interaction, channel, sent };
}

test("/harmony-greetings preview remains private and blocks mention parsing", async () => {
  store.saveGreetingSettings({
    guildId: "slash-preview",
    channelId: "greeting-channel",
    entranceMessage: "Welcome {member}, {name} to {server}!",
    exitMessage: "Goodbye {name} from {server}.",
  });
  const { interaction } = interactionFor("preview", "slash-preview");

  await command.execute(interaction);

  assert.equal(interaction.deferred.flags, 64);
  assert.match(interaction.reply.content, /Welcome <@admin-1>, Admin Display to Youtiful Stay/);
  assert.equal(interaction.reply.allowedMentions.parse.length, 0);
});

test("/harmony-greetings test still sends the entrance message and only pings the test user", async () => {
  store.saveGreetingSettings({
    guildId: "slash-test",
    channelId: "greeting-channel",
    entranceMessage: "Welcome {member} to {server}!",
    exitMessage: "Goodbye {name} from {server}.",
  });
  const { interaction, sent } = interactionFor("test", "slash-test");

  await command.execute(interaction);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, "Welcome <@admin-1> to Youtiful Stay!");
  assert.deepEqual(sent[0].allowedMentions, { users: ["admin-1"] });
  assert.match(interaction.reply.content, /Test delivered successfully/);
});

test("/harmony-greetings off leaves the saved channel and messages intact", async () => {
  store.saveGreetingSettings({
    guildId: "slash-off",
    channelId: "greeting-channel",
    entranceMessage: "Entry {member}",
    exitMessage: "Exit {name}",
  });
  const { interaction } = interactionFor("off", "slash-off");

  await command.execute(interaction);

  const saved = store.getGreetingSettings("slash-off");
  assert.equal(saved.enabled, 0);
  assert.equal(saved.channel_id, "greeting-channel");
  assert.equal(saved.entrance_message, "Entry {member}");
  assert.equal(saved.exit_message, "Exit {name}");
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
