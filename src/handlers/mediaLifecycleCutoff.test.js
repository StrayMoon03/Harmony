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

test("other non-Facebook and non-Instagram media keeps the existing lifecycle cutoff", () => {
  assert.equal(
    mediaLifecycleCutoffMs("https://www.threads.com/share/example/"),
    undefined
  );
});
