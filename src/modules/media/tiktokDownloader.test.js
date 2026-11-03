const test = require("node:test");
const assert = require("node:assert/strict");

const {
  shouldKeepOriginalTikTokPreview,
  requiresTikTokStreamingFallback,
  getTikTokUploadOptions,
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

test("long TikTok videos retain the existing original-player fallback boundary", () => {
  assert.equal(requiresTikTokStreamingFallback(89.99), false);
  assert.equal(requiresTikTokStreamingFallback(90), true);
});

test("only normal TikTok videos opt into compatibility conversion and safe MP4 names", () => {
  assert.deepEqual(getTikTokUploadOptions(false), {
    embedColor: 0xff4fa3,
    ensureAppleCompatibleVideo: true,
    safeVideoFileNamePrefix: "harmony-tiktok-video",
  });
  assert.deepEqual(getTikTokUploadOptions(true), { embedColor: 0xff4fa3 });
});
