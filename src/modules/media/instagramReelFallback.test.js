const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { saveVerifiedReel, exactReelCode } = require("./instagramReelFallback");
const owned = { code: "EXACT", video: "https://scontent-a.cdninstagram.com/owned.mp4?secret=SIGNED" };
const audioVideo = { stdout: JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }] }) };

test("browser diagnostics strip private and nonboolean fields", () => {
  const { sanitizedBrowserDiagnostics } = require("./instagramReelFallback");
  const report = sanitizedBrowserDiagnostics('PRIVATE STDERR\nHARMONY_INSTAGRAM_DIAGNOSTICS:' + JSON.stringify({ helperStarted: true, responseJsonFailed: false, cookiesLoaded: "SECRET", url: "SIGNED", cookie: "SECRET", exactRecordSeen: 1 }));
  assert.deepEqual(report, { helperStarted: true, responseJsonFailed: false });
});

test("malformed diagnostics never expose raw stderr", () => {
  const { sanitizedBrowserDiagnostics } = require("./instagramReelFallback");
  for (const value of [undefined, "SECRET", "HARMONY_INSTAGRAM_DIAGNOSTICS:SIGNED", "HARMONY_INSTAGRAM_DIAGNOSTICS:null", "HARMONY_INSTAGRAM_DIAGNOSTICS:[]"]) assert.equal(sanitizedBrowserDiagnostics(value), null);
});

test("failed browser execution logs only sanitized stage booleans", async () => {
  const source = await fs.readFile(path.join(__dirname, "instagramReelFallback.js"), "utf8");
  const warnings = [];
  const module = { exports: {} };
  const controller = new AbortController();
  let lockSignal;
  const error = new Error("PRIVATE SIGNED URL");
  error.stderr = 'PRIVATE COOKIE\nHARMONY_INSTAGRAM_DIAGNOSTICS:{"helperStarted":true,"browserLaunched":false,"url":"SIGNED"}';
  const sandboxRequire = name => {
    if (name === "node:util") return { promisify: () => async () => { throw error; } };
    if (name === "./browserLock") return { withBrowserLock: (work, options) => { lockSignal = options.signal; return work(); } };
    return require(name);
  };
  vm.runInNewContext(source, { require: sandboxRequire, module, __dirname, process, console: { warn: value => warnings.push(value) }, URL });
  await assert.rejects(module.exports.downloadInstagramReel("https://www.instagram.com/reel/EXACT/", "/unused", { signal: controller.signal }), error => error.message === "Instagram browser could not verify the requested reel");
  assert.equal(lockSignal, controller.signal);
  assert.deepEqual(warnings, ['HARMONY_INSTAGRAM_DIAGNOSTICS:{"helperStarted":true,"browserLaunched":false}']);
});

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
  const controller = new AbortController();
  let receivedSignal = null;
  const commandOptions = [];
  const module = { exports: {} };
  const sandboxRequire = name => {
    if (name === "node:util") return { promisify: () => async (...args) => { commandOptions.push(args[2]); throw new Error("simulated downloader failure"); } };
    if (name === "./instagramReelFallback") return { downloadInstagramReel: async (_url, _jobDir, options) => { routes.push("reel"); receivedSignal = options.signal; return { files: ["owned.mp4"] }; } };
    if (name === "./instagramPhotoFallback") return { downloadInstagramPhotos: async (_url, _jobDir, options) => { routes.push("photo"); receivedSignal = options.signal; return { files: ["owned.jpg"] }; } };
    return require(name);
  };
  vm.runInNewContext(source, { require: sandboxRequire, module, __dirname, process, console: { warn() {}, log() {} }, setTimeout, URL });
  const result = await module.exports.downloadMedia(url, { signal: controller.signal });
  try {
    assert.deepEqual(routes, [expected]);
    assert.equal(result.files.length, 1);
    assert.equal(receivedSignal, controller.signal);
    assert.deepEqual(commandOptions.map(options => options.timeout), [120000, 120000, 45000]);
    assert.ok(commandOptions.every(options => options.signal === controller.signal));
  }
  finally { await fs.rm(result.rawDir, { recursive: true, force: true }); }
}
test("exhausted incident reel methods reach reel recovery", () => routedDownload("https://www.instagram.com/reel/DdXwaqyN-RA/", "reel"));
test("photo recovery routing remains unchanged", () => routedDownload("https://www.instagram.com/p/EXACT/", "photo"));

test("Instagram timeout aborts yt-dlp before starting later fallback methods", async () => {
  const source = await fs.readFile(path.join(__dirname, "downloader.js"), "utf8");
  const module = { exports: {} };
  const controller = new AbortController();
  const timeout = new Error("retrieval deadline");
  let commands = 0;
  const sandboxRequire = name => {
    if (name === "node:util") return {
      promisify: () => async () => {
        commands += 1;
        controller.abort(timeout);
        throw timeout;
      },
    };
    if (name === "./instagramReelFallback" || name === "./instagramPhotoFallback") {
      return { downloadInstagramReel: async () => assert.fail("browser fallback should not start"), downloadInstagramPhotos: async () => assert.fail("photo fallback should not start") };
    }
    return require(name);
  };
  vm.runInNewContext(source, { require: sandboxRequire, module, __dirname, process, console: { warn() {}, log() {} }, setTimeout, URL });
  await assert.rejects(module.exports.downloadMedia("https://www.instagram.com/reel/EXACT/", { signal: controller.signal }), error => error === timeout);
  assert.equal(commands, 1);
});

test("silent large rendition is deleted before smaller muxed rendition is kept", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-reel-candidates-"));
  const urls = ["https://scontent-a.fbcdn.net/large.mp4", "https://scontent-a.fbcdn.net/small.mp4"];
  const fetched = [];
  try {
    const files = await saveVerifiedReel({ code: "EXACT", videos: urls }, "EXACT", dir, {
      fetch: async (url, config) => {
        assert.deepEqual(await fs.readdir(dir), []);
        assert.equal(config.redirect, "error");
        fetched.push(url);
        return { ok: true, headers: new Headers({ "content-type": "video/mp4" }), body: [Buffer.alloc(2048, fetched.length)] };
      },
      exec: async () => fetched.length === 1 ? { stdout: '{"streams":[{"codec_type":"video"}]}' } : audioVideo,
    });
    assert.deepEqual(fetched, urls);
    assert.equal((await fs.readFile(files[0]))[0], 2);
    assert.equal((await fs.readdir(dir)).length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("all silent candidates are deleted and signed URLs are not leaked", () => runSave({ code: "EXACT", videos: [owned.video, "https://scontent-a.fbcdn.net/second.mp4"] }, { probe: { stdout: '{"streams":[{"codec_type":"video"}]}' }, reject: error => /could not verify/.test(error.message) && !error.message.includes("SIGNED") }));
