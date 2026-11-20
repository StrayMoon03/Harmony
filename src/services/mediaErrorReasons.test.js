const test = require("node:test");
const assert = require("node:assert/strict");
const { FAILURE_TEXT } = require("../modules/media/messageLifecycle");
const {
  FACEBOOK_LOGIN_WALL_USER_TEXT,
  FACEBOOK_LOGIN_WALL_INBOX_TEXT,
  isFacebookLoginOrCheckpointWall,
  publicFailureText,
  safeReason,
} = require("./mediaErrorReasons");

const facebookUrl = "https://www.facebook.com/share/v/19n8uUUV5m/";
const loginWall = new Error("Facebook opened a login or checkpoint page");
const aggregatedWall = new Error(
  "Harmony could not retrieve this Facebook post after trying every available download method.\n\n" +
    "facebook-browser+cookies (verified exact post): Facebook opened a login or checkpoint page"
);
const classifiedWall = {
  message: "FACEBOOK_EXACT_POST_FAILED: facebook-browser+cookies: Facebook opened a login or checkpoint page",
  socialAuthFailureKind: "owner",
  socialAuthFailureCategory: "checkpoint",
};

test("Facebook login/checkpoint walls use the private-group channel message", () => {
  assert.equal(publicFailureText(loginWall, facebookUrl), FACEBOOK_LOGIN_WALL_USER_TEXT);
  assert.equal(publicFailureText(aggregatedWall), FACEBOOK_LOGIN_WALL_USER_TEXT);
  assert.equal(publicFailureText(classifiedWall, facebookUrl), FACEBOOK_LOGIN_WALL_USER_TEXT);
  assert.equal(publicFailureText(new Error("login required"), facebookUrl), FACEBOOK_LOGIN_WALL_USER_TEXT);
  assert.match(FACEBOOK_LOGIN_WALL_USER_TEXT, /private group|only visible to certain people/i);
  assert.doesNotMatch(FACEBOOK_LOGIN_WALL_USER_TEXT, /cookies/i);
});

test("other failures keep the generic channel message", () => {
  assert.equal(publicFailureText(new Error("No media files were downloaded."), facebookUrl), FAILURE_TEXT);
  assert.equal(publicFailureText(new Error("requested format is not available"), facebookUrl), FAILURE_TEXT);
  assert.equal(
    publicFailureText(new Error("[instagram][error] HTTP redirect to login page (https://www.instagram.com/accounts/login/)")),
    FAILURE_TEXT
  );
  assert.equal(publicFailureText({ message: "provider error", socialAuthFailureKind: "owner" }), FAILURE_TEXT);
  assert.equal(publicFailureText(new Error("login required"), "https://www.instagram.com/p/abc123/"), FAILURE_TEXT);
});

test("Facebook login/checkpoint walls tell the inbox it may be a private post, with cookies as a fallback", () => {
  assert.equal(safeReason(loginWall, facebookUrl), FACEBOOK_LOGIN_WALL_INBOX_TEXT);
  assert.equal(safeReason(aggregatedWall), FACEBOOK_LOGIN_WALL_INBOX_TEXT);
  // The browser helper's combined login/checkpoint wording is also classified as
  // an owner checkpoint; the inbox must still prefer the private-post explanation.
  assert.equal(safeReason(classifiedWall, facebookUrl), FACEBOOK_LOGIN_WALL_INBOX_TEXT);
  assert.equal(
    safeReason(new Error("Facebook opened a login page after an authenticated post request")),
    FACEBOOK_LOGIN_WALL_INBOX_TEXT
  );
  assert.equal(safeReason(new Error("Facebook checkpoint page")), FACEBOOK_LOGIN_WALL_INBOX_TEXT);
  assert.match(FACEBOOK_LOGIN_WALL_INBOX_TEXT, /private group|limited to certain people/i);
  assert.match(FACEBOOK_LOGIN_WALL_INBOX_TEXT, /other Facebook posts are failing too[\s\S]*cookies may need refreshing/i);
});

test("Instagram and generic auth wording is unchanged", () => {
  const issue442Message = "Instagram exhausted its safe download methods: ERROR: [Instagram] DfdPSrShNtb: This content isn't available to everyone: It can't be seen by certain audiences. | [instagram][info] Waiting for 1 minutes until 05:15:11 (429 Too Many Requests) | Instagram browser could not verify the requested reel";
  assert.equal(safeReason(new Error(issue442Message)), "The platform login cookies may need to be refreshed.");
  assert.equal(
    safeReason(new Error("[instagram][error] HTTP redirect to login page (https://www.instagram.com/accounts/login/)")),
    "The platform login cookies may need to be refreshed."
  );
  assert.equal(safeReason(new Error("login required")), "The platform login cookies may need to be refreshed.");
  assert.equal(
    safeReason({ message: "provider error", socialAuthFailureKind: "session" }),
    "The platform login cookies need to be refreshed."
  );
  assert.equal(
    safeReason({ message: "provider error", socialAuthFailureKind: "owner" }),
    "The platform account needs a security check by its owner (then refresh cookies)."
  );
  assert.equal(safeReason(new Error("Facebook CDN image below size threshold")), "The retrieved media could not be used for posting.");
  assert.equal(safeReason(new Error("Facebook cookies not present in downloader config")), "Harmony could not retrieve usable media from this link.");
  assert.doesNotMatch(safeReason(new Error("Facebook CDN image below size threshold")), /private group|cookies/i);
});

test("isFacebookLoginOrCheckpointWall is limited to Facebook login or checkpoint walls", () => {
  assert.equal(isFacebookLoginOrCheckpointWall(loginWall, facebookUrl), true);
  assert.equal(isFacebookLoginOrCheckpointWall(new Error("login required"), facebookUrl), true);
  assert.equal(isFacebookLoginOrCheckpointWall(new Error("login required"), "https://www.instagram.com/p/abc123/"), false);
  assert.equal(isFacebookLoginOrCheckpointWall(new Error("No media files were downloaded."), facebookUrl), false);
  assert.equal(isFacebookLoginOrCheckpointWall(new Error("Facebook cookies not present in downloader config")), false);
  assert.equal(isFacebookLoginOrCheckpointWall({ message: "provider error", socialAuthFailureKind: "owner" }, facebookUrl), false);
});
