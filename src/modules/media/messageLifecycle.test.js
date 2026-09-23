const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WORKING_TEXT,
  FAILURE_TEXT,
  MediaRetrievalTimeoutError,
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

test("five-second notice is standalone and removed after retrieval", async () => {
  const message = fakeMessage();
  await withMediaLifecycle(message, async (lifecycle) => {
    await wait(15);
    lifecycle.markRetrieved();
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
      lifecycle.markRetrieved();
    }, {
      workingDelayMs: 5,
      cutoffMs: 15,
      onTimeout: (error) => { timeout = error; },
    }),
    MediaRetrievalTimeoutError
  );
  assert.ok(timeout instanceof MediaRetrievalTimeoutError);
  assert.equal(message.sent[0].payload.content, WORKING_TEXT);
  assert.equal(message.sent[0].deleted, true);
  assert.equal(message.sent[1].payload.content, FAILURE_TEXT);
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
