const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Client, Events } = require("discord.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-member-activity-"));
process.env.HARMONY_DB_PATH = path.join(tempDir, "activity.sqlite");

const { closeDb } = require("../src/db/sqlite");
const { getWeeklyMemberCountActivity } = require("../src/stores/memberCountStore");
const runtimeSecrets = require("../src/services/runtimeSecrets");
const welcomePassServer = require("../src/services/welcomePassServer");

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("human join packets count before ready and every leave and rejoin counts for the same member", async (t) => {
  let client;
  process.env.DISCORD_TOKEN = "test-token";
  t.mock.method(runtimeSecrets, "prepareRuntimeSecrets", () => {});
  t.mock.method(welcomePassServer, "startWelcomePassServer", () => {});
  t.mock.method(Client.prototype, "login", function () { client = this; });
  require("../src/index");

  const now = new Date();
  const guild = { id: "join-leave-cycles", name: "Test guild" };
  const member = { guild, user: { id: "same-human", username: "Human" } };
  const bot = { guild, user: { id: "a-bot", username: "Bot", bot: true } };
  const joinPacket = ({ user }) => client.emit(Events.Raw, {
    t: "GUILD_MEMBER_ADD",
    d: { guild_id: guild.id, user },
  });
  const joinCallback = client.listeners(Events.GuildMemberAdd)[0];
  const leave = client.listeners(Events.GuildMemberRemove)[0];
  const counts = () => getWeeklyMemberCountActivity(guild.id, now);

  assert.equal(client.isReady(), false);
  joinPacket(member);
  assert.deepEqual(counts(), { joined: 1, left: 0, net: 1 });
  await joinCallback(member);
  assert.deepEqual(counts(), { joined: 1, left: 0, net: 1 });
  await leave(member);
  assert.deepEqual(counts(), { joined: 1, left: 1, net: 0 });
  joinPacket(member);
  await joinCallback(member);
  assert.deepEqual(counts(), { joined: 2, left: 1, net: 1 });
  await leave(member);
  joinPacket(member);
  await joinCallback(member);
  assert.deepEqual(counts(), { joined: 3, left: 2, net: 1 });

  joinPacket(bot);
  await joinCallback(bot);
  await leave(bot);
  assert.deepEqual(counts(), { joined: 3, left: 2, net: 1 });
});
