const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  galleryDlErrorMessage,
  summarizeXGalleryMetadata,
  isTrustedXMediaUrl,
  downloadFxTwitterMedia,
} = require("./xDownloader");

const KEYERROR_PAYLOAD = [
  [
    -1,
    {
      error: "KeyError",
      message: "'name'",
    },
  ],
];

const PHOTO_TWEET = [
  {
    author: { name: "StrayKidsGlobal", nick: "Stray Kids Global" },
    content: "Bang Chan interview",
    date: "2026-11-23 06:00:00",
    type: "photo",
  },
];

const TEXT_ONLY_TWEET = [
  {
    author: { name: "example", nick: "Example User" },
    content: "Just words, no photos.",
    date: "2026-11-22 12:00:00",
  },
];

test("gallery-dl KeyError JSON is a failed inspection, not a text-only post", () => {
  assert.equal(galleryDlErrorMessage(KEYERROR_PAYLOAD), "KeyError: 'name'");
  const summary = summarizeXGalleryMetadata(KEYERROR_PAYLOAD);
  assert.equal(summary.hasMedia, null);
  assert.equal(summary.text, null);
  assert.equal(summary.creator, null);
});

test("empty gallery-dl JSON is inconclusive rather than text-only", () => {
  assert.equal(galleryDlErrorMessage([]), null);
  const summary = summarizeXGalleryMetadata([]);
  assert.equal(summary.hasMedia, null);
  assert.equal(summary.text, null);
});

test("a photo tweet is reported as having media", () => {
  const summary = summarizeXGalleryMetadata(PHOTO_TWEET);
  assert.equal(summary.hasMedia, true);
  assert.equal(summary.creator, "Stray Kids Global");
  assert.equal(summary.text, "Bang Chan interview");
});

test("a tweet record with no photo, video, or GIF is text-only", () => {
  const summary = summarizeXGalleryMetadata(TEXT_ONLY_TWEET);
  assert.equal(summary.hasMedia, false);
  assert.equal(summary.creator, "Example User");
  assert.equal(summary.text, "Just words, no photos.");
});

test("only HTTPS twimg hosts are trusted for the FxTwitter fallback", () => {
  assert.equal(isTrustedXMediaUrl("https://pbs.twimg.com/media/abc.jpg?name=orig"), true);
  assert.equal(isTrustedXMediaUrl("https://video.twimg.com/tweet_video/abc.mp4"), true);
  assert.equal(isTrustedXMediaUrl("https://mosaic.fxtwitter.com/jpeg/1/abc"), false);
  assert.equal(isTrustedXMediaUrl("https://example.com/pbs.twimg.com/media/abc.jpg"), false);
  assert.equal(isTrustedXMediaUrl("http://pbs.twimg.com/media/abc.jpg"), false);
});

test("FxTwitter fallback downloads trusted photos from a failed gallery-dl inspection", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-x-fx-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const tweet = {
    text: "[mennoblesse_official IG UPDATE]\n\nBang Chan quote",
    created_timestamp: 1763876613,
    author: { name: "Stray Kids Global", screen_name: "StrayKidsGlobal" },
    media: {
      all: [
        { type: "photo", id: "1", url: "https://pbs.twimg.com/media/one.jpg?name=orig" },
        { type: "photo", id: "2", url: "https://pbs.twimg.com/media/two.jpg?name=orig" },
        { type: "photo", id: "3", url: "https://pbs.twimg.com/media/three.jpg?name=orig" },
        { type: "photo", id: "4", url: "https://pbs.twimg.com/media/four.jpg?name=orig" },
      ],
    },
  };

  const result = await downloadFxTwitterMedia(
    "https://x.com/StrayKidsGlobal/status/2124755481843442161?s=19",
    dir,
    {
      fetchImpl: async (url) => {
        if (String(url).startsWith("https://api.fxtwitter.com/status/2124755481843442161")) {
          return new Response(JSON.stringify({ code: 200, message: "OK", tweet }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (String(url).startsWith("https://pbs.twimg.com/media/")) {
          return new Response(Buffer.alloc(2048, 1), {
            headers: { "content-type": "image/jpeg" },
          });
        }
        return new Response("no", { status: 404 });
      },
    }
  );

  assert.equal(result.linkOnly, false);
  assert.equal(result.files.length, 4);
  assert.equal(result.creator, "Stray Kids Global");
  assert.match(result.text, /Bang Chan quote/);
  assert.equal(result.platform, "x");
});

test("FxTwitter fallback ignores media from an untrusted host", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-x-fx-bad-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const result = await downloadFxTwitterMedia(
    "https://x.com/example/status/1",
    dir,
    {
      fetchImpl: async (url) => {
        if (String(url).startsWith("https://api.fxtwitter.com/status/1")) {
          return new Response(JSON.stringify({
            code: 200,
            tweet: {
              text: "hi",
              author: { name: "Example", screen_name: "example" },
              media: { all: [{ type: "photo", id: "1", url: "https://evil.example/photo.jpg" }] },
            },
          }), { headers: { "content-type": "application/json" } });
        }
        assert.fail(`unexpected fetch: ${url}`);
      },
    }
  );

  assert.equal(result.linkOnly, true);
  assert.equal(result.text, "hi");
  assert.deepEqual(await fs.readdir(dir), []);
});

test("FxTwitter fallback returns a text-only result when the post has words and no media", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-x-fx-text-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const result = await downloadFxTwitterMedia(
    "https://twitter.com/example/status/99",
    dir,
    {
      fetchImpl: async () => new Response(JSON.stringify({
        code: 200,
        tweet: {
          text: "Hello from a text-only post",
          author: { name: "Example", screen_name: "example" },
        },
      }), { headers: { "content-type": "application/json" } }),
    }
  );

  assert.equal(result.linkOnly, true);
  assert.equal(result.files.length, 0);
  assert.equal(result.text, "Hello from a text-only post");
  assert.deepEqual(await fs.readdir(dir), []);
});
