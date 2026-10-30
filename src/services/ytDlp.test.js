const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");

test("yt-dlp metadata uses ignore-config only when requested by Instagram", async () => {
  const source = await fs.readFile(path.join(__dirname, "ytDlp.js"), "utf8");
  const calls = [];
  const module = { exports: {} };
  const sandboxRequire = name => {
    if (name === "node:child_process") return { execFile() {} };
    if (name === "node:util") return { promisify: () => async (_command, args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ uploader: "creator" }) };
    } };
    return require(name);
  };
  vm.runInNewContext(source, { require: sandboxRequire, module, process, JSON });

  await module.exports.getMediaInfo("https://www.facebook.com/watch/123");
  await module.exports.getMediaInfo("https://www.instagram.com/p/EXACT/", { ignoreConfig: true });

  assert.equal(calls[0].includes("--ignore-config"), false);
  assert.equal(calls[1][0], "--ignore-config");
});
