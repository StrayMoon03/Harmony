const test = require("node:test");
const assert = require("node:assert/strict");
const { formatMediaCard, extractOriginalDate, formatXTextPost } = require("./formatter");

test("successful cards use only platform identification above media", () => {
  const platforms = {
    Facebook: "🔵 **Facebook**",
    Instagram: "📸 **Instagram**",
    TikTok: "🎵 **TikTok**",
    Threads: "⚪ **Threads**",
    X: "⚫ **X**",
    YouTube: "🔴 **YouTube**",
  };

  for (const [platform, header] of Object.entries(platforms)) {
    const card = formatMediaCard({
      platform,
      mediaType: "Video",
      creator: "straykids",
      originalUrl: `https://example.com/${platform}`,
      originalDate: new Date("2026-09-20T12:00:00Z"),
      sharedById: "123456789012345678",
    });
    assert.equal(card.header, header);
    assert.doesNotMatch(card.header, /Video|Reel|Photo|Post|straykids/);
    assert.match(card.footer, /Shared by <@123456789012345678> • Sep 20, 2026/);
    assert.match(card.footer, new RegExp(`View on ${platform}`));
    assert.doesNotMatch(card.footer, /💬/);
  }
});

test("member comment is attributed once at the bottom", () => {
  const card = formatMediaCard({
    platform: "TikTok",
    mediaType: "Video",
    creator: "originalcreator",
    originalUrl: "https://www.tiktok.com/@creator/video/123",
    originalDate: new Date("2026-09-23T12:00:00Z"),
    sharedById: "123456789012345678",
    memberComment: "OMG HIS HAIR 😂",
  });
  assert.equal(card.header, "🎵 **TikTok**");
  assert.match(card.footer, /^Shared by <@123456789012345678> • Sep 23, 2026/);
  assert.match(card.footer, /\n\n<@123456789012345678>: OMG HIS HAIR 😂$/);
  assert.doesNotMatch(card.footer, /💬/);
  assert.doesNotMatch(card.header, /originalcreator/);
});

test("yt-dlp dates are normalized", () => {
  assert.equal(extractOriginalDate({ upload_date: "20260920" }).toISOString(), "2026-09-20T00:00:00.000Z");
  assert.equal(extractOriginalDate({ created_at: "2026-09-19T17:30:00Z" }).toISOString(), "2026-09-19T17:30:00.000Z");
  assert.equal(extractOriginalDate({ timestamp: 1789839000 }).toISOString(), "2026-09-19T17:30:00.000Z");
});

test("X text post uses exact metadata and the compact standalone layout", () => {
  const text = formatXTextPost({
    displayName: "Stray Kids",
    handle: "Stray_Kids",
    originalDate: "2026-09-20T12:00:00Z",
    text: "Full post text",
    originalUrl: "https://x.com/Stray_Kids/status/123",
    sharedById: "123456789012345678",
  });
  assert.match(text, /X Post/);
  assert.match(text, /Stray Kids \(@Stray_Kids\)/);
  assert.match(text, /Full post text/);
  assert.match(text, /Shared by <@123456789012345678> • Sep 20, 2026/);
  assert.match(text, /View on X/);
});
