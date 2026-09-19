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

test("falls back to a channel send when the source message disappeared", async () => {
  const payload = { files: ["video.mp4"] };
  let channelPayload;
  const message = {
    reply: async () => { throw missingReferenceError(); },
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

test("does not retry unrelated Discord errors", async () => {
  let channelSends = 0;
  const expected = { code: 50035, rawError: { errors: {} } };
  const message = {
    reply: async () => { throw expected; },
    channel: { send: async () => { channelSends += 1; } },
  };

  await assert.rejects(sendUploadBatch(message, {}, true), (error) => error === expected);
  assert.equal(channelSends, 0);
});

test("follow-up batches continue to use ordinary channel sends", async () => {
  let replies = 0;
  const message = {
    reply: async () => { replies += 1; },
    channel: { send: async () => ({ id: "follow-up" }) },
  };

  const result = await sendUploadBatch(message, {}, false);
  assert.equal(result.id, "follow-up");
  assert.equal(replies, 0);
});
