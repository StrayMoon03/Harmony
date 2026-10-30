const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");

test("photo browser child receives no session path for anonymous retrieval", async () => {
  const source = await fs.readFile(path.join(__dirname, "instagramPhotoFallback.js"), "utf8");
  const module = { exports: {} };
  const seen = [];
  const sandboxRequire = name => {
    if (name === "node:util") return { promisify: () => async (_command, _args, options) => {
      seen.push(options.env.INSTAGRAM_COOKIES);
      return { stdout: "HARMONY_INSTAGRAM_PHOTOS:{\"code\":\"EXACT\",\"photos\":[]}" };
    } };
    if (name === "./browserLock") return { withBrowserLock: work => work() };
    return require(name);
  };
  vm.runInNewContext(source, {
    require: sandboxRequire,
    module,
    __dirname,
    process: { ...process, env: { ...process.env, INSTAGRAM_COOKIES: "/private/miss-harmony.txt" } },
    URL,
  });
  await assert.rejects(module.exports.downloadInstagramPhotos("https://www.instagram.com/p/EXACT/", "/unused"));
  assert.equal(seen[0], "");
});

test("photo browser receives the existing session only for the explicit authenticated retry", async () => {
  const source = await fs.readFile(path.join(__dirname, "instagramPhotoFallback.js"), "utf8");
  const module = { exports: {} };
  const seen = [];
  const error = new Error("browser login redirect");
  error.stderr = "HARMONY_INSTAGRAM_AUTH_REQUIRED";
  const sandboxRequire = name => {
    if (name === "node:util") return { promisify: () => async (_command, _args, options) => {
      seen.push(options.env.INSTAGRAM_COOKIES);
      throw error;
    } };
    if (name === "./browserLock") return { withBrowserLock: work => work() };
    return require(name);
  };
  vm.runInNewContext(source, {
    require: sandboxRequire,
    module,
    __dirname,
    process: { ...process, env: { ...process.env, INSTAGRAM_COOKIES: "/private/miss-harmony.txt" } },
    URL,
  });
  await assert.rejects(
    module.exports.downloadInstagramPhotos("https://www.instagram.com/p/EXACT/", "/unused", { useCookies: true }),
    error => error.code === "INSTAGRAM_AUTH_REQUIRED"
  );
  assert.deepEqual(seen, ["/private/miss-harmony.txt"]);
});
