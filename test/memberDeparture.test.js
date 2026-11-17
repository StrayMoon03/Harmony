const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Client } = require("discord.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harmony-departure-test-"));
process.env.HARMONY_DB_PATH = path.join(tempDir, "harmony.sqlite");

const { closeDb } = require("../src/db/sqlite");
const { saveGreetingSettings } = require("../src/stores/greetingStore");
const { getWeeklyMemberCountActivity } = require("../src/stores/memberCountStore");
const { saveWelcomePassSettings } = require("../src/stores/welcomePassStore");
const runtimeSecrets = require("../src/services/runtimeSecrets");
const welcomePassServer = require("../src/services/welcomePassServer");

let onMemberRemove;
test.before(() => {
  process.env.DISCORD_TOKEN = "test-token";
  const mocks = [
    test.mock.method(runtimeSecrets, "prepareRuntimeSecrets", () => {}),
    test.mock.method(welcomePassServer, "startWelcomePassServer", () => {}),
    test.mock.method(Client.prototype, "login", function () {
      const listeners = this.listeners("guildMemberRemove");
      assert.equal(listeners.length, 1);
      [onMemberRemove] = listeners;
    }),
  ];
  try {
    require("../src/index");
  } finally {
    for (const mock of mocks) mock.mock.restore();
  }
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function fixture(guildId, { entryChannelId, legacyAvailable = true, bot = false } = {}) {
  const sent = [];
  const fetched = [];
  const channel = (id) => ({
    isTextBased: () => true,
    send: async (payload) => sent.push({ id, ...payload }),
  });
  const cache = new Map();
  if (legacyAvailable) cache.set("old-greetings", channel("old-greetings"));
  if (entryChannelId === "stay-roll-call") cache.set(entryChannelId, channel(entryChannelId));
  const member = {
    displayName: "STAY member",
    user: { username: "stay-member", bot },
    guild: {
      id: guildId,
      name: "Youtiful STAY",
      channels: {
        cache,
        fetch: async (id) => {
          fetched.push(id);
          throw new Error("Unknown Channel");
        },
      },
    },
  };
  saveGreetingSettings({
    guildId,
    channelId: "old-greetings",
    exitMessage: "{name} has left {server}.",
  });
  if (entryChannelId) {
    saveWelcomePassSettings({
      guildId,
      roleId: "stay",
      channelId: "welcome-pass-alerts",
      entryChannelId,
    });
  }
  return { member, sent, fetched };
}

function departure(channelId) {
  return [{
    id: channelId,
    content: "STAY member has left Youtiful STAY.",
    allowedMentions: { parse: [] },
  }];
}

test("a voluntary human leave posts to the current Welcome Pass entry channel", async () => {
  const { member, sent, fetched } = fixture("voluntary-leave", { entryChannelId: "stay-roll-call" });
  await onMemberRemove(member);
  assert.deepEqual(sent, departure("stay-roll-call"));
  assert.deepEqual(fetched, []);
});

test("a kicked human uses the same guildMemberRemove event when the legacy channel is gone", async () => {
  const { member, sent, fetched } = fixture("kicked-member", {
    entryChannelId: "stay-roll-call",
    legacyAvailable: false,
  });
  // Discord delivers the same event and member data for a leave and a kick.
  await onMemberRemove(member);
  assert.deepEqual(sent, departure("stay-roll-call"));
  assert.deepEqual(fetched, []);
});

test("a guild with only legacy greeting settings still receives departures", async () => {
  const { member, sent } = fixture("legacy-greetings");
  await onMemberRemove(member);
  assert.deepEqual(sent, departure("old-greetings"));
});

test("a bot departure sends no greeting and records no human leave", async () => {
  const { member, sent, fetched } = fixture("bot-leave", { entryChannelId: "stay-roll-call", bot: true });
  await onMemberRemove(member);
  assert.deepEqual(sent, []);
  assert.deepEqual(fetched, []);
  assert.equal(getWeeklyMemberCountActivity(member.guild.id).left, 0);
});

test("an unavailable current channel fails safely and preserves weekly leave tracking", async (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  const { member, sent, fetched } = fixture("missing-channel", { entryChannelId: "deleted-entry" });
  const now = new Date();
  await onMemberRemove(member);
  assert.deepEqual(fetched, ["deleted-entry"]);
  assert.deepEqual(sent, []);
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(getWeeklyMemberCountActivity(member.guild.id, now), { joined: 0, left: 1, net: -1 });
});
