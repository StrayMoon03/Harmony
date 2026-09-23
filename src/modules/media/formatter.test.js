const test = require("node:test");
const assert = require("node:assert/strict");
const { formatMediaCard, extractOriginalDate, formatXTextPost } = require("./formatter");

test("compact card includes platform, type, creator, date, and source link only", () => {
  const text = formatMediaCard({
    platform: "Instagram",
    mediaType: "Reel",
    creator: "straykids",
    originalUrl: "https://www.instagram.com/reel/ABC/",
    originalDate: new Date("2026-09-20T12:00:00Z"),
  });
  assert.match(text, /Instagram Reel/);
  assert.match(text, /@straykids • Sep 20, 2026/);
  assert.match(text, /View on Instagram/);
  assert.doesNotMatch(text, /Harmony|Shared by|Original Reel/);
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
  });
  assert.match(text, /X Post/);
  assert.match(text, /Stray Kids \(@Stray_Kids\) · Sep 20, 2026/);
  assert.match(text, /Full post text/);
  assert.match(text, /View on X/);
});
