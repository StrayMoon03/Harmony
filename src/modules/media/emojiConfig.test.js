const test = require("node:test");
const assert = require("node:assert/strict");
const { platformHeart, statusEmoji } = require("./emojiConfig");

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
