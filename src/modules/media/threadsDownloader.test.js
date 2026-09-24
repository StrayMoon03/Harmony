const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectPostScopedJsonMedia,
  exactThreadsPostUrl,
  resolveThreadsShareRedirect,
  shouldUseScopedBrowserDirectly,
} = require("./threadsDownloader");

test("sends resolved share aliases directly to scoped browser inspection", () => {
  assert.equal(shouldUseScopedBrowserDirectly(true), true);
  assert.equal(shouldUseScopedBrowserDirectly(false), false);
});

test("accepts only exact Threads post permalinks", () => {
  assert.equal(
    exactThreadsPostUrl(
      "https://www.threads.com/@chosen.4000/post/REAL123?xmt=abc"
    ),
    "https://www.threads.com/@chosen.4000/post/REAL123"
  );
  assert.equal(
    exactThreadsPostUrl("https://www.threads.com/share/BAWxLOKPbB/"),
    null
  );
  assert.equal(
    exactThreadsPostUrl("https://evil.example/@chosen.4000/post/REAL123"),
    null
  );
});

test("extracts every carousel item in order from the exact post record", () => {
  const payload = {
    unrelated: {
      code: "WRONG",
      image_versions2: {
        candidates: [{ url: "https://scontent-a.fbcdn.net/wrong.jpg", width: 900, height: 900 }],
      },
    },
    requested: {
      code: "REAL123",
      carousel_media: [
        {
          image_versions2: {
            candidates: [
              { url: "https://scontent-a.fbcdn.net/first-small.jpg", width: 300, height: 300 },
              { url: "https://scontent-a.fbcdn.net/first.jpg", width: 1200, height: 1200 },
            ],
          },
        },
        {
          image_versions2: {
            candidates: [{ url: "https://scontent-b.fbcdn.net/second.jpg", width: 1200, height: 1200 }],
          },
        },
      ],
    },
  };
  const html = `<script type="application/json">${JSON.stringify(payload)}</script>`;

  assert.deepEqual(
    collectPostScopedJsonMedia(
      html,
      "https://www.threads.com/@chosen.4000/post/REAL123"
    ),
    [
      "https://scontent-a.fbcdn.net/first.jpg",
      "https://scontent-b.fbcdn.net/second.jpg",
    ]
  );
});

test("uses quoted attachment media when the requested post has none", () => {
  const payload = {
    requested: {
      code: "REAL123",
      text_post_app_info: {
        share_info: {
          quoted_attachment_post: {
            image_versions2: {
              candidates: [
                { url: "https://scontent-a.fbcdn.net/quote.jpg", width: 1200, height: 1200 },
              ],
            },
          },
        },
      },
    },
  };
  const html = `<script type="application/json">${JSON.stringify(payload)}</script>`;

  assert.deepEqual(
    collectPostScopedJsonMedia(
      html,
      "https://www.threads.com/@chosen.4000/post/REAL123"
    ),
    ["https://scontent-a.fbcdn.net/quote.jpg"]
  );
});

test("extracts an inline Instagram reel only from the requested Threads post", () => {
  const reel = { code: "INSTAGRAM123", video_versions: [{ url: "https://scontent-a.cdninstagram.com/inline.mp4" }] };
  const payload = {
    requested: { code: "REAL123", media_type: 19, video_versions: null,
      text_post_app_info: { linked_inline_media: reel, share_info: { quoted_attachment_post: null } } },
    reply: { code: "OTHER123", text_post_app_info: { linked_inline_media: {
      video_versions: [{ url: "https://scontent-a.cdninstagram.com/wrong.mp4" }] } } },
  };
  const extract = () => collectPostScopedJsonMedia(`<script type="application/json">${JSON.stringify(payload)}</script>`, "https://www.threads.com/@chosen.4000/post/REAL123");
  assert.deepEqual(extract(), ["https://scontent-a.cdninstagram.com/inline.mp4"]);
  payload.requested.video_versions = [{ url: "https://scontent-a.cdninstagram.com/own.mp4" }];
  assert.deepEqual(extract(), ["https://scontent-a.cdninstagram.com/own.mp4"]);
  payload.requested.video_versions = null;
  reel.video_versions[0].url = "https://evil.example/inline.mp4";
  assert.deepEqual(extract(), []);
});

test("resolves a share alias from Threads' redirect Location", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => new Response(null, {
    status: 302,
    headers: {
      location: "https://www.threads.com/@chosen.4000/post/REAL123?xmt=abc",
    },
  });

  assert.equal(
    await resolveThreadsShareRedirect(
      "https://www.threads.com/share/BAWxLOKPbB/"
    ),
    "https://www.threads.com/@chosen.4000/post/REAL123"
  );
});
