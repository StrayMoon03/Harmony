const test = require("node:test");
const assert = require("node:assert/strict");
const { platformHeart, platformIcon, statusEmoji } = require("./emojiConfig");

test("platform hearts use configured Discord emoji IDs without inventing IDs", () => {
  process.env.HARMONY_HEART_FACEBOOK_ID = "123456789012345678";
  assert.equal(platformHeart("facebook"), "<:harmony_heart_facebook:123456789012345678>");
  delete process.env.HARMONY_HEART_FACEBOOK_ID;
  assert.equal(platformHeart("facebook"), "💙");
});

test("invalid status emoji IDs safely fall back to attachments", () => {
  process.env.HARMONY_UHOH_EMOJI_ID = "not-an-id";
  assert.equal(statusEmoji("failure"), null);
  delete process.env.HARMONY_UHOH_EMOJI_ID;
});

test("platform icons use all six configured Discord emoji IDs", () => {
  const configured = {
    HARMONY_PLATFORM_FACEBOOK_ID: ["Facebook", "facebook"],
    HARMONY_PLATFORM_INSTAGRAM_ID: ["Instagram", "instagram"],
    HARMONY_PLATFORM_TIKTOK_ID: ["TikTok", "tiktok"],
    HARMONY_PLATFORM_THREADS_ID: ["Threads", "threads"],
    HARMONY_PLATFORM_X_ID: ["X", "xlogo"],
    HARMONY_PLATFORM_YOUTUBE_ID: ["YouTube", "youtube"],
  };

  let id = 123456789012345670n;
  for (const [env, [platform, name]] of Object.entries(configured)) {
    process.env[env] = String(id += 1n);
    assert.equal(platformIcon(platform), `<:${name}:${process.env[env]}>`);
    delete process.env[env];
  }
});

test("missing or invalid platform icon IDs fall back to no emoji", () => {
  delete process.env.HARMONY_PLATFORM_FACEBOOK_ID;
  assert.equal(platformIcon("Facebook"), null);
  process.env.HARMONY_PLATFORM_FACEBOOK_ID = "invalid";
  assert.equal(platformIcon("Facebook"), null);
  delete process.env.HARMONY_PLATFORM_FACEBOOK_ID;
});
