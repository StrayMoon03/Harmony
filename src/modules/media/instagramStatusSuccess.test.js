const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const operationsStatusService = require("../../services/operationsStatusService");

test("successful Instagram media retrieval still clears the previous auth failure for Status", async () => {
  const at = new Date().toISOString();
  operationsStatusService.recordSocialAuthFailure("instagram", at, "session");
  operationsStatusService.recordSocialSuccess("instagram", at);
  const status = await operationsStatusService.checkSocial("instagram");
  assert.equal(status.status, operationsStatusService.STATUS.healthy);
});

test("Instagram handler records social success only after usable media was retrieved", async () => {
  const source = await fs.readFile(path.join(__dirname, "../../handlers/mediaHandler.js"), "utf8");
  const start = source.indexOf("if (instagramLinks.length > 0)");
  const end = source.indexOf("// Facebook", start);
  const instagramPath = source.slice(start, end);
  assert.ok(instagramPath.indexOf("await downloadMedia(originalUrl)") >= 0);
  assert.ok(instagramPath.indexOf("recordSocialSuccess(platform)") > instagramPath.indexOf("await downloadMedia(originalUrl)"));
  assert.ok(instagramPath.indexOf("recordSocialSuccess(platform)") > instagramPath.indexOf("classification.files.length === 0"));
});
