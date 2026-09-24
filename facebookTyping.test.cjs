const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const source = fs.readFileSync(__dirname + "/src/handlers/mediaHandler.js", "utf8");

test("all supported platforms use the shared immediate-typing lifecycle", () => {
  assert.match(source, /withMediaLifecycle\(/);
  assert.match(source, /processMediaMessage\(message, lifecycle\)/);
  assert.doesNotMatch(source, /await message\.channel\.sendTyping\(\)/);
});

test("Facebook still reaches metadata and download after duplicate detection", () => {
  const start = source.indexOf('    const platform = "facebook";');
  const end = source.indexOf("  // =========================\n  // TikTok", start);
  const branch = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(branch.indexOf("shareStore.find") < branch.indexOf("getMediaInfo"));
  assert.ok(branch.indexOf("getMediaInfo") < branch.indexOf("downloadFacebookMedia"));
  assert.match(branch, /sendAlreadyShared\(message, existing, platform\)/);
});

test("private Facebook download errors still reach the shared reporter", () => {
  const start = source.indexOf('    const platform = "facebook";');
  const end = source.indexOf("  // =========================\n  // TikTok", start);
  const branch = source.slice(start, end);
  assert.match(branch, /replyWithHarmonyError\([\s\S]*message,[\s\S]*error/);
});

test("all six successful media branches preserve submitter text before deletion", () => {
  const builders = source.match(/buildSuccessfulCard\(message, originalUrl,/g) || [];
  const guardedDeletes = source.match(
    /deleteOriginalAfterSuccess\(message, sentMessageIds, safeToDelete\)/g
  ) || [];
  assert.equal(builders.length, 6);
  assert.equal(guardedDeletes.length, 6);
  assert.match(source, /sharedById: message\.author\.id/);
  assert.match(source, /memberComment: preservation\.comment/);
});
