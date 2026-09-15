const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractTikTokId,
  isTikTokLiveUrl,
} = require("./tiktok");

test("recognizes normalized TikTok live URLs", () => {
  assert.equal(
    isTikTokLiveUrl("https://www.tiktok.com/@creator/live?share_app_id=1233"),
    true
  );
  assert.equal(
    isTikTokLiveUrl("https://www.tiktok.com/@creator/video/123456789"),
    false
  );
  assert.equal(
    isTikTokLiveUrl("https://example.com/@creator/live"),
    false
  );
});

test("keeps extracting IDs from saved TikTok media", () => {
  assert.equal(
    extractTikTokId("https://www.tiktok.com/@creator/video/123456789"),
    "123456789"
  );
  assert.equal(
    extractTikTokId("https://www.tiktok.com/@creator/photo/987654321"),
    "987654321"
  );
});
