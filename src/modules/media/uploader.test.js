const test = require("node:test");
const assert = require("node:assert/strict");
const { sendUploadBatch } = require("./uploader");

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
