const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchVerifiedFacebookAttachment } = require("./facebookDownloader");

test("retries a verified rendition after HTTP refusal or request failure", async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  for (const failure of [() => new Response(null, { status: 403 }), () => { throw new Error("secret URL"); }]) {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(url);
      return calls.length === 1 ? failure() : new Response(Buffer.alloc(60 * 1024), { headers: { "content-type": "video/mp4" } });
    };
    const media = await fetchVerifiedFacebookAttachment({ type: "video", url: "https://video-a.fbcdn.net/hd.mp4", fallbackUrls: ["https://evil.example/wrong.mp4", "https://video-a.fbcdn.net/sd.mp4"] }, "https://www.facebook.com/");
    assert.equal(media.bytes.length, 60 * 1024);
    assert.deepEqual(calls, ["https://video-a.fbcdn.net/hd.mp4", "https://video-a.fbcdn.net/sd.mp4"]);
  }
});

test("rejects HTML masquerading as a video and reports sanitized reasons", async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => new Response("x".repeat(60 * 1024), { headers: { "content-type": "text/html" } });
  await assert.rejects(fetchVerifiedFacebookAttachment({ type: "video", url: "https://video-a.fbcdn.net/a.mp4?secret=token" }, "https://www.facebook.com/", "private-cookie"), (error) => {
    assert.match(error.message, /unexpected content type/);
    assert.doesNotMatch(error.message, /token|private-cookie|https:/);
    return true;
  });
});
