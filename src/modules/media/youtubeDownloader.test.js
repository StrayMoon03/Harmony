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

test("does not hide a genuine YouTube download failure", () => {
  assert.equal(
    shouldKeepOriginalYouTubePreview({
      linkOnly: true,
      linkOnlyReason: "download-unavailable",
    }),
    false
  );
  assert.equal(shouldKeepOriginalYouTubePreview(null), false);
});
