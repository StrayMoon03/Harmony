const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");

test("getMediaInfo forwards an optional cancellation signal to yt-dlp", async () => {
  const source = await fs.readFile(path.join(__dirname, "ytDlp.js"), "utf8");
  const module = { exports: {} };
  const controller = new AbortController();
  let receivedOptions;
  const sandboxRequire = name => {
    if (name === "node:child_process") return { execFile() {} };
    if (name === "node:util") return {
      promisify: () => async (_command, _args, options) => {
        receivedOptions = options;
        return { stdout: JSON.stringify({ title: "example" }) };
      },
    };
    return require(name);
  };
  vm.runInNewContext(source, { require: sandboxRequire, module, process });

  const info = await module.exports.getMediaInfo("https://www.instagram.com/reel/example/", { signal: controller.signal });
  assert.equal(info.title, "example");
  assert.equal(receivedOptions.signal, controller.signal);
});

test("getMediaInfo honors a custom timeoutMs and defaults to 18s", async () => {
  const source = await fs.readFile(path.join(__dirname, "ytDlp.js"), "utf8");
  const seen = [];
  const sandboxRequire = name => {
    if (name === "node:child_process") return { execFile() {} };
    if (name === "node:util") return {
      promisify: () => async (_c, _a, options) => { seen.push(options.timeout); return { stdout: "{}" }; },
    };
    return require(name);
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { require: sandboxRequire, module, process });
  await module.exports.getMediaInfo("https://www.tiktok.com/x", { timeoutMs: 6000 });
  await module.exports.getMediaInfo("https://www.tiktok.com/x");
  assert.deepEqual(seen, [6000, 18000]);
});
