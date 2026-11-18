const test = require("node:test");
const assert = require("node:assert/strict");
const { sendTextPostCard } = require("./mediaHandler");
const shareStore = require("../stores/shareStore");

test("text-only posts are shared as a card and recorded as a successful share", async (t) => {
  const inserted = [];
  const originalInsert = shareStore.insert;
  shareStore.insert = (row) => inserted.push(row);
  t.after(() => { shareStore.insert = originalInsert; });
  const url = "https://www.threads.com/@author/post/TEXT123";
  const sent = [];
  let retrieved = false;
  let deleted = false;
  const message = {
    id: "source-1",
    content: url,
    author: { id: "member-1", username: "member" },
    member: { displayName: "Member" },
    guild: { id: "guild-1" },
    channel: {
      id: "channel-1",
      send: async (payload) => { sent.push(payload); return { id: "card-1" }; },
    },
    delete: async () => { deleted = true; },
  };
  const lifecycle = {
    markRetrieved: async () => { retrieved = true; },
    finishFailure: async () => assert.fail("text card must not report a failure"),
  };

  await sendTextPostCard(message, lifecycle, {
    platform: "threads",
    platformName: "Threads",
    mediaId: "TEXT123",
    originalUrl: url,
    textPost: { text: "Only words here", handle: "author", displayName: "Author", originalDate: null },
  });

  assert.equal(retrieved, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].embeds[0].data.description, "Only words here");
  assert.equal(sent[0].embeds[0].data.footer.text, "Text-only post from Threads");
  assert.equal(deleted, true);
  assert.equal(inserted[0].messageId, "card-1");
  assert.equal(inserted[0].creator, "@author");
  assert.equal(inserted[0].mediaId, "TEXT123");
});
