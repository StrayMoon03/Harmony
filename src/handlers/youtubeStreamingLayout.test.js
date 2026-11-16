const test = require("node:test");
const assert = require("node:assert/strict");
const { sendYouTubeStreamingPreview } = require("./mediaHandler");
const { formatMediaCard } = require("../modules/media/formatter");

test("long YouTube streaming preview uses Harmony header, player, and details layout", async () => {
  const sent = [];
  let originalEmbedsSuppressed = false;
  const originalUrl = "https://www.youtube.com/watch?v=abcdefghijk";
  const cardText = formatMediaCard({
    platform: "YouTube",
    creator: "DICON",
    originalDate: "2026-11-16T00:00:00.000Z",
    originalUrl,
    sharedById: "member-1",
    memberComment: "Today's video!",
  });
  const message = {
    channel: {
      id: "channel-1",
      send: async (payload) => {
        const output = { id: `output-${sent.length + 1}`, channelId: "channel-1", payload };
        sent.push(output);
        return output;
      },
    },
    reply: async () => assert.fail("streaming player should use a standalone message"),
    suppressEmbeds: async (value) => { originalEmbedsSuppressed = value; },
  };

  const ids = await sendYouTubeStreamingPreview(message, {
    originalUrl,
    cardText,
    durationMinutes: 42,
  });

  assert.deepEqual(sent.map((item) => item.payload.content || "player"), [
    cardText.header,
    originalUrl,
    "player",
  ]);
  assert.deepEqual(ids, ["output-1", "output-2", "output-3"]);
  assert.equal(sent[2].payload.embeds[0].data.color, 0xff0000);
  assert.match(sent[2].payload.embeds[0].data.description, /42-minute video plays through YouTube/);
  assert.match(sent[2].payload.embeds[0].data.description, /@DICON • Nov 16, 2026/);
  assert.match(sent[2].payload.embeds[0].data.description, /Shared by <@member-1>/);
  assert.match(sent[2].payload.embeds[0].data.description, /Today's video!/);
  assert.equal(sent[2].payload.components[0].components[0].data.url, originalUrl);
  assert.equal(originalEmbedsSuppressed, true);
});

test("YouTube streaming layout removes partial output if a later send fails", async () => {
  const deleted = [];
  let calls = 0;
  const message = {
    channel: {
      id: "channel-1",
      send: async () => {
        calls += 1;
        if (calls === 2) throw new Error("send failed");
        const id = `sent-${calls}`;
        return { id, delete: async () => { deleted.push(id); } };
      },
    },
    reply: async () => assert.fail("streaming player should use a standalone message"),
  };

  await assert.rejects(
    sendYouTubeStreamingPreview(message, {
      originalUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      cardText: { header: "YouTube", footer: "Shared by member", buttonUrl: null },
      durationMinutes: 42,
    }),
    /send failed/
  );
  assert.deepEqual(deleted, ["sent-1"]);
});
