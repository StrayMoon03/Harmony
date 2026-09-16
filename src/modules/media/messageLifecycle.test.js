const test = require("node:test");
const assert = require("node:assert/strict");
const { withDelayedProgress, suppressOriginalEmbeds, handleOriginalPreviewUpdate } = require("./messageLifecycle");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("quick work does not post a processing message", async () => {
  let replies = 0;
  await withDelayedProgress({ reply: async () => { replies++; } }, async () => {}, 10);
  await wait(20);
  assert.equal(replies, 0);
});

test("slow work posts once and removes progress even on failure", async () => {
  let replies = 0, deleted = 0;
  const message = { reply: async (options) => {
    replies++;
    assert.equal(options.allowedMentions.repliedUser, false);
    return { delete: async () => { deleted++; } };
  } };
  await assert.rejects(withDelayedProgress(message, async () => { await wait(30); throw new Error("download failed"); }, 5), /download failed/);
  assert.equal(replies, 1);
  assert.equal(deleted, 1);
});

test("a progress reply arriving after completion is still removed", async () => {
  let deleted = 0;
  const message = { reply: async () => { await wait(30); return { delete: async () => { deleted++; } }; } };
  await withDelayedProgress(message, () => wait(15), 5);
  assert.equal(deleted, 1);
});

test("a refused progress reply does not stop the download", async () => {
  let completed = false;
  await withDelayedProgress({ reply: async () => { throw new Error("Discord unavailable"); } }, async () => { await wait(20); completed = true; }, 5);
  assert.equal(completed, true);
});

test("late preview updates are suppressed only for managed messages without the flag", async () => {
  let suppressed = 0;
  const message = { id: "managed", author: { bot: false }, embeds: [{}], flags: { has: () => false }, suppressEmbeds: async () => { suppressed++; } };
  await handleOriginalPreviewUpdate(message);
  assert.equal(suppressed, 0);
  await suppressOriginalEmbeds(message);
  await handleOriginalPreviewUpdate(message);
  assert.equal(suppressed, 2);
  message.flags.has = () => true;
  await handleOriginalPreviewUpdate(message);
  assert.equal(suppressed, 2);
});
