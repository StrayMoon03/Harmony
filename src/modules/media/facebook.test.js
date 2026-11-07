const test = require("node:test");
const assert = require("node:assert/strict");
const { isFacebookShareAlias } = require("./facebook");
const { isIdentitySensitiveFacebookPost } = require("./facebookDownloader");

test("recognizes Facebook share aliases handled directly by the browser", () => {
  for (const url of [
    "https://www.facebook.com/share/p/1J6qEkk4N1/",
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

test("the reported /share/p URL stays on the identity-bound browser path", () => {
  const url = "https://www.facebook.com/share/p/1J6qEkk4N1/";
  assert.equal(isFacebookShareAlias(url), true);
  assert.equal(isIdentitySensitiveFacebookPost(url, url), true);
});
