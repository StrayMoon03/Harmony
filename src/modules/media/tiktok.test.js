const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findTikTokLinks,
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

test("finds TikTok media and shortened links", () => {
  assert.deepEqual(
    findTikTokLinks(
      [
        "https://www.tiktok.com/@creator/video/123456789?is_from_webapp=1",
        "https://www.tiktok.com/@creator/photo/987654321",
        "https://www.tiktok.com/t/ZP8Example/",
        "https://vm.tiktok.com/ZMExample/",
        "https://vt.tiktok.com/ZExample/",
      ].join(" ")
    ),
    [
      "https://www.tiktok.com/@creator/video/123456789?is_from_webapp=1",
      "https://www.tiktok.com/@creator/photo/987654321",
      "https://www.tiktok.com/t/ZP8Example/",
      "https://vm.tiktok.com/ZMExample/",
      "https://vt.tiktok.com/ZExample/",
    ]
  );
});

test("ignores TikTok profiles and other non-media pages", () => {
  assert.deepEqual(
    findTikTokLinks(
      [
        "https://www.tiktok.com/@jimin",
        "https://www.tiktok.com/@creator/live",
        "https://www.tiktok.com/explore",
      ].join(" ")
    ),
    []
  );
});
