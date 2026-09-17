const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { saveVerifiedReel, exactReelCode } = require("./instagramReelFallback");
const owned = { code: "EXACT", video: "https://scontent-a.cdninstagram.com/owned.mp4?secret=SIGNED" };
const audioVideo = { stdout: JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }] }) };

async function runSave(result = owned, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-reel-test-"));
  const calls = [];
  const deps = {
    fetch: async (url, config) => {
      calls.push(config);
      return { ok: true, headers: new Headers({ "content-type": "video/mp4" }), body: [Buffer.alloc(2048)], ...options.response };
    },
    exec: async () => options.probe || audioVideo,
    ...options.deps,
  };
  try {
    if (options.reject) {
      await assert.rejects(saveVerifiedReel(result, "EXACT", dir, deps), options.reject);
      assert.deepEqual(await fs.readdir(dir), []);
    } else {
      const files = await saveVerifiedReel(result, "EXACT", dir, deps);
      assert.equal(files.length, 1);
      assert.equal((await fs.stat(files[0])).size, 2048);
      assert.equal(calls[0].redirect, "error");
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test("exact reel URL validation", () => {
  assert.equal(exactReelCode("https://www.instagram.com/reel/EXACT/"), "EXACT");
  for (const url of ["https://evil.test/reel/EXACT/", "https://www.instagram.com/p/EXACT/", "https://user:pass@www.instagram.com/reel/EXACT/", "https://www.instagram.com:8080/reel/EXACT/"]) assert.throws(() => exactReelCode(url));
});
test("owned video with audio saved, redirects forbidden", () => runSave());
test("identity mismatch rejected before fetch", () => runSave({ ...owned, code: "OTHER" }, { reject: /identity mismatch/ }));
test("foreign host rejected before fetch", () => runSave({ ...owned, video: "https://cdninstagram.com.evil.test/v.mp4" }, { reject: /URL rejected/ }));
test("HTML/login response rejected", () => runSave(owned, { response: { headers: new Headers({ "content-type": "text/html" }) }, reject: /could not verify/ }));
test("HTTP failure rejected", () => runSave(owned, { response: { ok: false }, reject: /could not verify/ }));
test("empty response rejected", () => runSave(owned, { response: { body: [Buffer.alloc(10)] }, reject: /could not verify/ }));
test("oversized response rejected", () => runSave(owned, { response: { headers: new Headers({ "content-type": "video/mp4", "content-length": String(101 * 1024 * 1024) }) }, reject: /could not verify/ }));
test("silent video rejected and deleted", () => runSave(owned, { probe: { stdout: '{"streams":[{"codec_type":"video"}]}' }, reject: /could not verify/ }));
test("audio-only file rejected and deleted", () => runSave(owned, { probe: { stdout: '{"streams":[{"codec_type":"audio"}]}' }, reject: /could not verify/ }));
test("signed URLs in request failure never propagated", () => runSave(owned, { deps: { fetch: async () => { throw new Error(owned.video); } }, reject: error => !error.message.includes("SIGNED") && /could not verify/.test(error.message) }));

async function routedDownload(url, expected) {
  const source = await fs.readFile(path.join(__dirname, "downloader.js"), "utf8");
  const routes = [];
  const module = { exports: {} };
  const sandboxRequire = name => {
    if (name === "node:util") return { promisify: () => async () => { throw new Error("simulated downloader failure"); } };
    if (name === "./instagramReelFallback") return { downloadInstagramReel: async () => { routes.push("reel"); return { files: ["owned.mp4"] }; } };
    if (name === "./instagramPhotoFallback") return { downloadInstagramPhotos: async () => { routes.push("photo"); return { files: ["owned.jpg"] }; } };
    return require(name);
  };
  vm.runInNewContext(source, { require: sandboxRequire, module, __dirname, process, console: { warn() {}, log() {} }, setTimeout, URL });
  const result = await module.exports.downloadMedia(url);
  try { assert.deepEqual(routes, [expected]); assert.equal(result.files.length, 1); }
  finally { await fs.rm(result.rawDir, { recursive: true, force: true }); }
}
test("exhausted reel methods reach reel recovery", () => routedDownload("https://www.instagram.com/reel/EXACT/", "reel"));
test("photo recovery routing remains unchanged", () => routedDownload("https://www.instagram.com/p/EXACT/", "photo"));
