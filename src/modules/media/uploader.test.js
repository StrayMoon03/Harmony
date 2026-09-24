const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { sendUploadBatch, uploadMedia } = require("./uploader");

function missingReferenceError() {
  return {
    code: 50035,
    rawError: {
      errors: {
        message_reference: {
          _errors: [{ code: "MESSAGE_REFERENCE_UNKNOWN_MESSAGE" }],
        },
      },
    },
  };
}

test("first upload batch is a standalone channel send", async () => {
  const payload = { files: ["video.mp4"] };
  let channelPayload;
  const message = {
    channel: {
      send: async (value) => {
        channelPayload = value;
        return { id: "sent" };
      },
    },
  };

  const result = await sendUploadBatch(message, payload, true);
  assert.equal(result.id, "sent");
  assert.equal(channelPayload, payload);
});

test("follow-up batches continue to use ordinary channel sends", async () => {
  let replies = 0;
  const message = {
    channel: { send: async () => ({ id: "follow-up" }) },
  };

  const result = await sendUploadBatch(message, {}, false);
  assert.equal(result.id, "follow-up");
  assert.equal(replies, 0);
});

test("successful structured post sends header, media, then footer/comment", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-layout-"));
  const mediaPath = path.join(tempDir, "photo.jpg");
  await fs.writeFile(mediaPath, "test image bytes");
  const sent = [];
  const message = {
    channel: {
      send: async (payload) => {
        sent.push(payload);
        return { id: `sent-${sent.length}` };
      },
    },
  };
  const card = {
    header: "TikTok",
    footer: "Shared by <@123> • Sep 23, 2026\n<@123>: OMG HIS HAIR 😂",
    buttonLabel: "View on TikTok",
    buttonUrl: "https://example.com",
  };

  const ids = await uploadMedia(message, [{ path: mediaPath }], card);

  assert.deepEqual(ids, ["sent-1", "sent-2", "sent-3"]);
  assert.equal(sent[0].content, card.header);
  assert.equal(sent[0].embeds, undefined);
  assert.deepEqual(sent[1].files, [mediaPath]);
  assert.equal(sent[2].embeds[0].data.description, card.footer);
  assert.equal(sent[2].components[0].components[0].data.label, card.buttonLabel);
  assert.equal(sent[2].components[0].components[0].data.url, card.buttonUrl);
  assert.equal(sent[2].components[0].components[0].data.style, 5);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.deepEqual(sent[2].allowedMentions, { parse: [] });
  await fs.rm(tempDir, { recursive: true, force: true });
});
