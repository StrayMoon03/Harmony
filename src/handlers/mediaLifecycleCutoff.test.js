const test = require("node:test");
const assert = require("node:assert/strict");
const { mediaLifecycleCutoffMs } = require("./mediaHandler");

test("Facebook shares allow the serialized exact-post browser queue to finish", () => {
  assert.equal(
    mediaLifecycleCutoffMs("https://www.facebook.com/share/v/19kbjUqUrr/"),
    90000
  );
});

test("Instagram fallback recovery receives a two-minute bounded lifecycle window", () => {
  assert.equal(
    mediaLifecycleCutoffMs("https://www.instagram.com/reel/example/"),
    120000
  );
  assert.equal(
    mediaLifecycleCutoffMs("https://www.instagram.com/p/example/"),
    120000
  );
});

test("Threads shares get a window long enough for the exact-post browser fallback", () => {
  assert.equal(
    mediaLifecycleCutoffMs("https://www.threads.com/share/example/"),
    90000
  );
});

test("X/Twitter shares get a window long enough for multi-video posts", () => {
  for (const url of [
    "https://x.com/skzpositivity/status/2122737396379009098?a=VAC80eEI3nPf0AdqVCg&s=33",
    "https://twitter.com/example/status/123",
    "https://mobile.twitter.com/example/status/123",
  ]) {
    assert.equal(mediaLifecycleCutoffMs(url), 90000);
  }
});

test("other media keeps the existing lifecycle cutoff", () => {
  assert.equal(
    mediaLifecycleCutoffMs("https://www.youtube.com/watch?v=example"),
    undefined
  );
});
