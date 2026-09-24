const test = require("node:test");
const assert = require("node:assert/strict");
const { extractMemberComment } = require("./memberComment");

const url = "https://www.tiktok.com/@creator/video/123";

test("link-only messages are safe to delete and have no comment", () => {
  assert.deepEqual(extractMemberComment(url, url), {
    safeToDelete: true,
    comment: null,
  });
  assert.deepEqual(extractMemberComment(`<${url}>`, url), {
    safeToDelete: true,
    comment: null,
  });
});

test("comments before, after, and around the processed URL are preserved", () => {
  assert.equal(
    extractMemberComment(`OMG HIS HAIR 😂 ${url}`, url).comment,
    "OMG HIS HAIR 😂"
  );
  assert.equal(
    extractMemberComment(`${url}\nI cannot handle this`, url).comment,
    "I cannot handle this"
  );
  assert.equal(
    extractMemberComment(`Before ${url} after`, url).comment,
    "Before after"
  );
});

test("only the processed URL is removed; other links and formatting remain", () => {
  const other = "https://example.com/details";
  const result = extractMemberComment(`**Look!** ${url}\n${other}`, url);
  assert.equal(result.safeToDelete, true);
  assert.equal(result.comment, `**Look!**\n${other}`);
});

test("ambiguous reconstruction keeps the original message", () => {
  assert.deepEqual(extractMemberComment("Look at this link", url), {
    safeToDelete: false,
    comment: null,
  });
  assert.deepEqual(extractMemberComment(`${url}!`, url), {
    safeToDelete: false,
    comment: null,
  });
});
