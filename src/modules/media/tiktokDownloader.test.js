const test = require("node:test");
const assert = require("node:assert/strict");

const {
  shouldKeepOriginalTikTokPreview,
} = require("./tiktokDownloader");

test("keeps the original TikTok player when a video fallback has no audio", () => {
  assert.equal(
    shouldKeepOriginalTikTokPreview({ hasAudio: false }, false),
    true
  );
});

test("does not treat photo posts or videos with audio as streaming fallbacks", () => {
  assert.equal(
    shouldKeepOriginalTikTokPreview({ hasAudio: false }, true),
    false
  );
  assert.equal(
    shouldKeepOriginalTikTokPreview({ hasAudio: true }, false),
    false
  );
});
