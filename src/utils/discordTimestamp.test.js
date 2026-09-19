const test = require("node:test");
const assert = require("node:assert/strict");
const { formatDiscordTimestamp } = require("./discordTimestamp");

test("UTC database timestamps become Discord-localized timestamps", () => {
  assert.equal(
    formatDiscordTimestamp("2026-09-17 15:32:00"),
    "<t:1789659120:f>"
  );
});

test("ISO timestamps preserve their actual instant", () => {
  assert.equal(
    formatDiscordTimestamp("2026-09-17T15:32:00.000Z"),
    "<t:1789659120:f>"
  );
});

test("invalid stored values remain visible instead of inventing a time", () => {
  assert.equal(formatDiscordTimestamp("unknown"), "unknown");
  assert.equal(formatDiscordTimestamp(null), "");
});
