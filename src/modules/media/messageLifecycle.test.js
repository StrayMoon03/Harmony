const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WORKING_TEXT,
  FAILURE_TEXT,
  MediaRetrievalTimeoutError,
  isHandledMediaTimeout,
  withMediaLifecycle,
  deleteOriginalAfterSuccess,
} = require("./messageLifecycle");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeMessage() {
  const sent = [];
  let typing = 0;
  return {
    sent,
    get typing() { return typing; },
    channel: {
      sendTyping: async () => { typing += 1; },
      send: async (payload) => {
        const item = { payload, deleted: false, delete: async () => { item.deleted = true; } };
        sent.push(item);
        return item;
      },
    },
  };
}

test("typing starts immediately and quick retrieval shows no notice", async () => {
  const message = fakeMessage();
  await withMediaLifecycle(message, async (lifecycle) => lifecycle.markRetrieved(), {
    workingDelayMs: 10,
    cutoffMs: 30,
  });
  await wait(15);
  assert.equal(message.typing, 1);
  assert.equal(message.sent.length, 0);
});

test("Working notice is standalone and removed after retrieval", async () => {
  const message = fakeMessage();
  await withMediaLifecycle(message, async (lifecycle) => {
    await wait(15);
    await lifecycle.markRetrieved();
  }, { workingDelayMs: 5, cutoffMs: 40 });
  assert.equal(message.sent[0].payload.content, WORKING_TEXT);
  assert.equal(message.sent[0].deleted, true);
});

test("cutoff removes Working, reports timeout, and leaves original untouched", async () => {
  const message = fakeMessage();
  let timeout;
  await assert.rejects(
    withMediaLifecycle(message, async (lifecycle) => {
      await wait(25);
      await lifecycle.markRetrieved();
    }, {
      workingDelayMs: 5,
      cutoffMs: 15,
      failureDeleteMs: 5,
      onTimeout: (error) => { timeout = error; },
    }),
    MediaRetrievalTimeoutError
  );
  assert.ok(timeout instanceof MediaRetrievalTimeoutError);
  assert.equal(message.sent[0].payload.content, WORKING_TEXT);
  assert.equal(message.sent[0].deleted, true);
  assert.equal(message.sent[1].payload.content, FAILURE_TEXT);
  await wait(10);
  assert.equal(message.sent[1].deleted, true);
});

test("a cutoff timeout is recognized as already reported", () => {
  assert.equal(isHandledMediaTimeout(new MediaRetrievalTimeoutError()), true);
  assert.equal(isHandledMediaTimeout(new Error("late result"), { timedOut: true }), true);
  assert.equal(isHandledMediaTimeout(new Error("download failed"), { timedOut: false }), false);
});

test("configured custom status emoji replaces the fallback attachment", async () => {
  process.env.HARMONY_WORKING_EMOJI_ID = "123456789012345678";
  const message = fakeMessage();
  await withMediaLifecycle(message, async (lifecycle) => {
    await wait(12);
    await lifecycle.markRetrieved();
  }, { workingDelayMs: 5, cutoffMs: 30 });
  delete process.env.HARMONY_WORKING_EMOJI_ID;
  assert.match(message.sent[0].payload.content, /<:harmony_working:123456789012345678>/);
  assert.deepEqual(message.sent[0].payload.files, []);
});

test("a normal failure removes Working and cannot later emit a timeout failure", async () => {
  const message = fakeMessage();
  await withMediaLifecycle(message, async (lifecycle) => {
    await wait(12);
    assert.equal(await lifecycle.finishFailure(), true);
  }, { workingDelayMs: 5, cutoffMs: 18 });
  await wait(20);
  assert.equal(message.sent.length, 1);
  assert.equal(message.sent[0].deleted, true);
});

test("original is deleted only after replacement and rolls replacement back on failure", async () => {
  let replacementDeleted = false;
  const message = {
    delete: async () => { throw new Error("missing permission"); },
    channel: { messages: { fetch: async () => ({ delete: async () => { replacementDeleted = true; } }) } },
  };
  await assert.rejects(deleteOriginalAfterSuccess(message, ["replacement"]), /permission/);
  assert.equal(replacementDeleted, true);
});

test("safe link-only or preserved-comment messages are deleted after replacement", async () => {
  let deleted = false;
  const message = { delete: async () => { deleted = true; } };
  assert.equal(await deleteOriginalAfterSuccess(message, ["replacement"], true), true);
  assert.equal(deleted, true);
});

test("ambiguous comment parsing preserves the original message", async () => {
  let deleted = false;
  const message = { delete: async () => { deleted = true; } };
  assert.equal(await deleteOriginalAfterSuccess(message, ["replacement"], false), false);
  assert.equal(deleted, false);
});
