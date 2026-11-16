const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldRetryInstagramYtDlpWithoutCookies } = require("../src/modules/media/downloader");

test("Instagram skips the duplicate public yt-dlp retry after audio validation failure", () => {
  assert.equal(shouldRetryInstagramYtDlpWithoutCookies(new Error("INSTAGRAM_AUDIO_MISSING")), false);
});

test("Instagram skips the duplicate public yt-dlp retry when upstream rate-limits", () => {
  assert.equal(shouldRetryInstagramYtDlpWithoutCookies({ stderr: "HTTP Error 429: Too Many Requests" }), false);
});

test("Instagram preserves the public retry for authentication and unrelated failures", () => {
  assert.equal(shouldRetryInstagramYtDlpWithoutCookies(new Error("HTTP redirect to login page")), true);
  assert.equal(shouldRetryInstagramYtDlpWithoutCookies(new Error("temporary connection reset")), true);
});
