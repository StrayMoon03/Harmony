const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTextPostMessage, DESCRIPTION_LIMIT } = require("./textPostCard");

const base = {
  platform: "Threads",
  text: "Hello Stays!",
  displayName: "rareb",
  handle: "rarebinswitzerland",
  avatarUrl: "https://scontent-a.cdninstagram.com/avatar.jpg",
  originalUrl: "https://www.threads.com/@rarebinswitzerland/post/Df19EthjObh",
  originalDate: "2026-11-16T12:01:20.000Z",
  sharedById: "123456789012345678",
};

test("text card carries the post text, author, link, time, color, and footer", () => {
  const payload = buildTextPostMessage(base);
  const embed = payload.embeds[0].data;
  assert.equal(payload.content, "Threads");
  assert.equal(embed.description, "Hello Stays!");
  assert.deepEqual(embed.author, {
    name: "rareb (@rarebinswitzerland)",
    icon_url: base.avatarUrl,
    url: base.originalUrl,
  });
  assert.equal(embed.timestamp, "2026-11-16T12:01:20.000Z");
  assert.equal(embed.color, 0xffffff);
  assert.equal(embed.footer.text, "Text-only post from Threads");
  assert.equal(embed.fields[0].value, "Shared by <@123456789012345678>");
  assert.equal(payload.components[0].components[0].data.url, base.originalUrl);
  assert.equal(payload.components[0].components[0].data.label, "View on Threads");
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test("long text is cut to Discord's description limit with an ellipsis", () => {
  const embed = buildTextPostMessage({ ...base, text: "a".repeat(5000) }).embeds[0].data;
  assert.equal(embed.description.length, DESCRIPTION_LIMIT);
  assert.ok(embed.description.endsWith("…"));
});

test("missing optional details are simply left out", () => {
  const embed = buildTextPostMessage({
    ...base, displayName: null, avatarUrl: "javascript:alert(1)", originalDate: "not a date",
    memberComment: "Look at this",
  }).embeds[0].data;
  assert.equal(embed.author.name, "@rarebinswitzerland");
  assert.equal(embed.author.icon_url, undefined);
  assert.equal(embed.timestamp, undefined);
  assert.equal(embed.fields[1].value, "Look at this");
});

test("X uses its own color and footer", () => {
  const payload = buildTextPostMessage({ ...base, platform: "X", originalUrl: "https://x.com/a/status/1" });
  assert.equal(payload.embeds[0].data.color, 0x000000);
  assert.equal(payload.embeds[0].data.footer.text, "Text-only post from X");
  assert.equal(payload.components[0].components[0].data.label, "View on X");
});
