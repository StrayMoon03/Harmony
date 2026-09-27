const test = require("node:test");
const assert = require("node:assert/strict");
const { isFacebookShareAlias } = require("./facebook");

test("recognizes Facebook share aliases handled directly by the browser", () => {
  for (const url of [
    "https://www.facebook.com/share/v/1JRUPjUMVR/",
    "https://facebook.com/share/r/example/",
    "https://m.facebook.com/share/p/example/",
    "https://www.facebook.com/share/1EQRuWwDbC/",
  ]) {
    assert.equal(isFacebookShareAlias(url), true);
  }
});

test("does not bypass normalization for canonical or unrelated URLs", () => {
  for (const url of [
    "https://www.facebook.com/watch/?v=123",
    "https://www.facebook.com/user/videos/123",
    "https://example.com/share/v/not-facebook/",
    "not a URL",
  ]) {
    assert.equal(isFacebookShareAlias(url), false);
  }
});
