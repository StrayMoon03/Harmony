const test = require("node:test");
const assert = require("node:assert/strict");
const { withBrowserLock } = require("./browserLock");

test("cancelled Instagram browser work leaves the serialized queue usable", async () => {
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withBrowserLock(async () => {
    firstStarted();
    await firstGate;
  });
  await started;

  const controller = new AbortController();
  let cancelledTaskStarted = false;
  const cancelled = withBrowserLock(async () => {
    cancelledTaskStarted = true;
  }, { signal: controller.signal });
  controller.abort(new Error("retrieval cutoff"));
  await assert.rejects(cancelled, /retrieval cutoff/);

  let nextTaskStarted = false;
  const next = withBrowserLock(async () => {
    nextTaskStarted = true;
  });
  releaseFirst();
  await Promise.all([first, next]);

  assert.equal(cancelledTaskStarted, false);
  assert.equal(nextTaskStarted, true);
});

test("already-aborted browser work never enters the queue", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already expired"));
  let started = false;
  await assert.rejects(withBrowserLock(async () => { started = true; }, { signal: controller.signal }), /already expired/);
  assert.equal(started, false);
});
