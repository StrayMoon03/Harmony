const test = require("node:test");
const assert = require("node:assert/strict");
const { formatMediaCard, extractOriginalDate } = require("./formatter");

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
});
