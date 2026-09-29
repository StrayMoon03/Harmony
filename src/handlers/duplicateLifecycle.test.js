const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sendAlreadySharedAndCleanup,
} = require("./mediaHandler");
const {
  resolveShareKey,
} = require("../commands/forgetShare");
const {
  extractFacebookId,
} = require("../modules/media/facebook");
const shareStore = require("../stores/shareStore");

function duplicateMessage(content, { sendFails = false } = {}) {
  const sent = [];
  let deleted = false;
  return {
    content,
    sent,
    get deleted() { return deleted; },
    delete: async () => { deleted = true; },
    channel: {
      send: async (payload) => {
        if (sendFails) throw new Error("Discord send failed");
        const response = { payload, delete: async () => {} };
        sent.push(response);
        return response;
      },
    },
  };
}

const record = {
  shared_by: "Kristina",
  shared_by_id: "member-1",
  shared_at: "2026-09-29T00:00:00.000Z",
};

test("duplicate response deletes a link-only submission only after sending", async () => {
  const url = "https://www.instagram.com/p/ABC123/";
  const message = duplicateMessage(url);

  await sendAlreadySharedAndCleanup(message, record, "instagram", url);

  assert.equal(message.sent.length, 1);
  assert.equal(message.deleted, true);
});

test("duplicate response preserves a member comment", async () => {
  const url = "https://www.instagram.com/p/ABC124/";
  const message = duplicateMessage(`That look! ${url}`);

  await sendAlreadySharedAndCleanup(message, record, "instagram", url);

  assert.equal(message.sent.length, 1);
  assert.equal(message.deleted, false);
});

test("duplicate response failure leaves the submitted message untouched", async () => {
  const url = "https://www.instagram.com/p/ABC125/";
  const message = duplicateMessage(url, { sendFails: true });

  await assert.rejects(
    sendAlreadySharedAndCleanup(message, record, "instagram", url),
    /Discord send failed/
  );
  assert.equal(message.deleted, false);
});

test("Facebook share aliases use the same key for sharing and forget", async () => {
  const token = `regression-${Date.now()}`;
  const url = `https://www.facebook.com/share/v/${token}/`;
  const normalMediaId = extractFacebookId(url);
  const forgetKey = await resolveShareKey(url);
  const guildId = `duplicate-regression-${Date.now()}`;

  assert.equal(forgetKey.platform, "facebook");
  assert.equal(forgetKey.mediaId, normalMediaId);

  try {
    const inserted = shareStore.insert({
      platform: "facebook",
      mediaId: normalMediaId,
      sharedBy: "Kristina",
      guildId,
      url,
    });
    assert.equal(inserted.ok, true);
    assert.ok(shareStore.find("facebook", normalMediaId, guildId));

    // This is the same removal operation used by /harmony-forget.
    assert.equal(shareStore.remove(forgetKey.platform, forgetKey.mediaId, guildId), true);
    assert.equal(shareStore.find("facebook", normalMediaId, guildId), null);

    // A subsequent submission can store the same key again as a new share.
    assert.equal(shareStore.insert({
      platform: "facebook",
      mediaId: normalMediaId,
      sharedBy: "Kristina",
      guildId,
      url,
    }).ok, true);
  } finally {
    shareStore.remove("facebook", normalMediaId, guildId);
  }
});

test("forgetting one share does not remove another share", () => {
  const guildId = `duplicate-isolation-${Date.now()}`;
  const first = `forget-first-${Date.now()}`;
  const second = `forget-second-${Date.now()}`;
  try {
    shareStore.insert({ platform: "instagram", mediaId: first, sharedBy: "A", guildId });
    shareStore.insert({ platform: "instagram", mediaId: second, sharedBy: "B", guildId });
    assert.equal(shareStore.remove("instagram", first, guildId), true);
    assert.equal(shareStore.find("instagram", first, guildId), null);
    assert.ok(shareStore.find("instagram", second, guildId));
  } finally {
    shareStore.remove("instagram", first, guildId);
    shareStore.remove("instagram", second, guildId);
  }
});
