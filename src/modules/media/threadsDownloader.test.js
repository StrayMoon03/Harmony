const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectPostScopedJsonMedia,
  exactThreadsPostUrl,
  resolveThreadsShareRedirect,
} = require("./threadsDownloader");

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

