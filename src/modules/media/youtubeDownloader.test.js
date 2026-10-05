const test = require("node:test");
const assert = require("node:assert/strict");

const {
  shouldKeepOriginalYouTubePreview,
} = require("./youtubeDownloader");

test("keeps an intentional long-video streaming preview without reporting an error", () => {
  assert.equal(
    shouldKeepOriginalYouTubePreview({
      linkOnly: true,
      linkOnlyReason: "long-video",
    }),
    true
  );
});

test("keeps an upcoming live-event preview without reporting an error", () => {
  assert.equal(
    shouldKeepOriginalYouTubePreview({
      linkOnly: true,
      linkOnlyReason: "upcoming-live",
    }),
    true
  );
});

test("keeps the original YouTube player when download access is unavailable", () => {
  assert.equal(
    shouldKeepOriginalYouTubePreview({
      linkOnly: true,
      linkOnlyReason: "download-unavailable",
    }),
    true
  );
});

test("does not treat a non-link-only result as an original-player fallback", () => {
  assert.equal(
    shouldKeepOriginalYouTubePreview({
      linkOnly: false,
      linkOnlyReason: "download-unavailable",
    }),
    false
  );
  assert.equal(shouldKeepOriginalYouTubePreview(null), false);
});
