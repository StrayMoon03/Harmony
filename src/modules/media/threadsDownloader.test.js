const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectPostScopedJsonMedia,
  collectExactOpenGraphFallback,
  exactThreadsPostUrl,
  resolveThreadsShareRedirect,
  shouldUseScopedBrowserDirectly,
} = require("./threadsDownloader");

test("sends share aliases and exact posts directly to scoped browser inspection", () => {
  assert.equal(shouldUseScopedBrowserDirectly(true), true);
  assert.equal(
    shouldUseScopedBrowserDirectly(
      false,
      "https://www.threads.com/@chosen.4000/post/REAL123?xmt=abc"
    ),
    true
  );
  assert.equal(
    shouldUseScopedBrowserDirectly(false, "https://www.threads.com/"),
    false
  );
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

test("runs share alias resolution attempts concurrently", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let inFlight = 0;
  let peakInFlight = 0;
  global.fetch = async () => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return new Response(null, { status: 204 });
  };

  assert.equal(
    await resolveThreadsShareRedirect("https://www.threads.com/share/ALIAS/"),
    null
  );
  assert.equal(peakInFlight, 4);
});

function openGraphPage({
  url,
  description = "A year ago, Minsung skipped dinner.",
  video = null,
  image = "https://scontent-a.fbcdn.net/thumb.jpg",
  extra = "",
}) {
  const tags = [
    `<meta property="og:url" content="${url}">`,
    `<link rel="canonical" href="${url}">`,
    description ? `<meta property="og:description" content="${description}">` : "",
    video ? `<meta property="og:video" content="${video}">` : "",
    image ? `<meta property="og:image" content="${image}">` : "",
    extra,
  ].filter(Boolean);
  return `<html><head>${tags.join("")}</head></html>`;
}

test("prefers matching og:video then og:image and rejects a different post", () => {
  const requested = "https://www.threads.com/@agnieszka.jordan/post/DfueqT_ghKZ";
  const video = "https://scontent-a.fbcdn.net/exact.mp4";
  const image = "https://scontent-a.fbcdn.net/exact.jpg";
  const matched = collectExactOpenGraphFallback(
    openGraphPage({ url: requested, video, image }),
    requested
  );
  assert.equal(matched.canonicalUrl, requested);
  assert.deepEqual(matched.candidates, [video, image]);
  assert.equal(matched.videoPost, true);
  assert.equal(matched.creator, "@agnieszka.jordan");

  const imageOnly = collectExactOpenGraphFallback(
    openGraphPage({
      url: requested,
      video: null,
      image,
      extra: '"code":"DfueqT_ghKZ","media_type":2,"video_versions":[{"url":"https://scontent-a.fbcdn.net/hidden.mp4"}]',
    }),
    requested
  );
  assert.deepEqual(imageOnly.candidates, [image]);
  assert.equal(imageOnly.videoPost, true);

  assert.equal(
    collectExactOpenGraphFallback(
      openGraphPage({
        url: "https://www.threads.com/@other/post/NESTED999",
        video,
        image,
        extra: '<meta property="og:description" content="A year ago, Minsung skipped dinner.">',
      }),
      requested
    ),
    null
  );
  assert.equal(
    collectExactOpenGraphFallback(
      openGraphPage({ url: requested, image }),
      "https://www.threads.com/share/ALIAS/"
    ),
    null
  );
});

test("requires og:description to match known post text when both are available", () => {
  const requested = "https://www.threads.com/@author/post/REAL123";
  const html = openGraphPage({
    url: requested,
    description: "A year ago, Minsung skipped dinner.",
    image: "https://scontent-a.fbcdn.net/exact.jpg",
  });
  assert.equal(
    collectExactOpenGraphFallback(html, requested, {
      knownText: "Totally different caption about another post",
    }),
    null
  );
  assert.equal(
    collectExactOpenGraphFallback(html, requested, {
      knownText: "A year ago, Minsung skipped dinner.",
    })?.image,
    "https://scontent-a.fbcdn.net/exact.jpg"
  );
  assert.equal(
    collectExactOpenGraphFallback(html, requested)?.image,
    "https://scontent-a.fbcdn.net/exact.jpg"
  );
});

test("decodes entity-encoded @ in og:url before matching the requested shortcode", () => {
  const requested = "https://www.threads.com/@agnieszka.jordan/post/DfueqT_ghKZ";
  const html = [
    "<html><head>",
    '<meta property="og:url" content="https://www.threads.com/&#064;agnieszka.jordan/post/DfueqT_ghKZ">',
    '<link rel="canonical" href="https://www.threads.com/&#064;agnieszka.jordan/post/DfueqT_ghKZ">',
    '<meta property="og:description" content="A year ago, Minsung skipped &#xbc25;, and it was probably the only time we were actually proud of them for skipping one">',
    '<meta property="og:image" content="https://scontent-a.fbcdn.net/exact.jpg?foo=1&amp;bar=2">',
    '"code":"DfueqT_ghKZ","media_type":2,"video_versions":[{"url":"https://scontent-a.fbcdn.net/hidden.mp4"}]',
    "</head></html>",
  ].join("");
  const result = collectExactOpenGraphFallback(html, requested, {
    knownText: "A year ago, Minsung skipped 밥, and it was probably the only time we were actually proud of them for skipping one",
  });
  assert.equal(result.canonicalUrl, requested);
  assert.equal(result.image, "https://scontent-a.fbcdn.net/exact.jpg?foo=1&bar=2");
  assert.equal(result.videoPost, true);
  assert.match(result.description, /Minsung skipped 밥/);
});
