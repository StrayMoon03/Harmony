const fs = require("node:fs");
const path = require("node:path");

const WORKING_TEXT = "Hey! This one’s taking me a little longer than I’d like, but don’t worry. I’ve got it!";
const FAILURE_TEXT = "Well, that one didn’t quite cooperate! I’ve let my admin know so we can take a closer look.";
const STICKERS = {
  working: path.join(__dirname, "../../../assets/harmony/working.png"),
  failure: path.join(__dirname, "../../../assets/harmony/uh-oh.png"),
  thanks: path.join(__dirname, "../../../assets/harmony/thank-you.png"),
};

class MediaRetrievalTimeoutError extends Error {
  constructor() {
    super("Harmony stopped media retrieval after 15 seconds.");
    this.name = "MediaRetrievalTimeoutError";
    this.code = "HARMONY_RETRIEVAL_TIMEOUT";
  }
}

function stickerFiles(kind) {
  const file = STICKERS[kind];
  if (!file || !fs.existsSync(file)) return [];
  return [{ attachment: file, name: path.basename(file) }];
}

async function sendStandaloneNotice(message, content, stickerKind) {
  return message.channel.send({
    content,
    files: stickerFiles(stickerKind),
    allowedMentions: { parse: [] },
  });
}

async function withMediaLifecycle(message, work, options = {}) {
  const workingDelayMs = options.workingDelayMs ?? 5000;
  const cutoffMs = options.cutoffMs ?? 15000;
  let retrievalFinished = false;
  let timedOut = false;
  let workingMessagePromise = null;
  let workingMessage = null;
  let timeoutNoticePromise = null;

  await message.channel.sendTyping().catch((error) => {
    console.warn("Could not start Harmony typing indicator:", error?.message || error);
  });

  const removeWorking = async () => {
    const pending = workingMessage || (workingMessagePromise && await workingMessagePromise);
    if (pending) await pending.delete().catch(() => null);
    workingMessage = null;
  };

  const workingTimer = setTimeout(() => {
    if (retrievalFinished || timedOut) return;
    workingMessagePromise = sendStandaloneNotice(message, WORKING_TEXT, "working")
      .then((sent) => (workingMessage = sent))
      .catch(() => null);
  }, workingDelayMs);
  workingTimer.unref?.();

  const cutoffTimer = setTimeout(() => {
    if (retrievalFinished || timedOut) return;
    timedOut = true;
    const timeoutError = new MediaRetrievalTimeoutError();
    timeoutNoticePromise = (async () => {
      await removeWorking();
      const sent = await sendStandaloneNotice(message, FAILURE_TEXT, "failure").catch(() => null);
      Promise.resolve(options.onTimeout?.(timeoutError)).catch(() => null);
      return sent;
    })();
  }, cutoffMs);
  cutoffTimer.unref?.();

  const lifecycle = {
    markRetrieved() {
      if (timedOut) throw new MediaRetrievalTimeoutError();
      retrievalFinished = true;
      clearTimeout(workingTimer);
      clearTimeout(cutoffTimer);
    },
    assertCanPublish() {
      if (timedOut) throw new MediaRetrievalTimeoutError();
    },
    get timedOut() { return timedOut; },
  };

  try {
    const result = await work(lifecycle);
    if (timedOut) return undefined;
    lifecycle.assertCanPublish();
    return result;
  } finally {
    retrievalFinished = true;
    clearTimeout(workingTimer);
    clearTimeout(cutoffTimer);
    await timeoutNoticePromise;
    await removeWorking();
  }
}

async function deleteOriginalAfterSuccess(message, replacementMessageIds = []) {
  try {
    await message.delete();
    return true;
  } catch (error) {
    for (const id of replacementMessageIds) {
      const replacement = await message.channel.messages?.fetch(id).catch(() => null);
      if (replacement) await replacement.delete().catch(() => null);
    }
    throw error;
  }
}

const managedPreviews = new Map();
const suppressing = new Set();

async function hidePreview(message) {
  if (suppressing.has(message.id)) return;
  suppressing.add(message.id);
  try {
    await message.suppressEmbeds(true);
    console.log("Original preview suppression requested:", { messageId: message.id });
  } catch (error) {
    console.warn("Original preview suppression failed:", {
      messageId: message.id, code: error?.code || "unknown",
    });
  } finally {
    suppressing.delete(message.id);
  }
}

async function suppressOriginalEmbeds(message) {
  const first = !managedPreviews.has(message.id);
  managedPreviews.set(message.id, true);
  if (managedPreviews.size > 5000) managedPreviews.delete(managedPreviews.keys().next().value);
  await hidePreview(message);
  if (!first) return;
  // Check fresh server state after Discord's delayed link-preview updates.
  for (const delay of [2500, 10000, 30000]) {
    const timer = setTimeout(async () => {
      try {
        const fresh = await message.fetch(true);
        if (!fresh.flags?.has(4)) await hidePreview(fresh);
        else console.log("Original preview suppression verified:", { messageId: message.id });
      } catch {
        console.warn("Could not verify original preview suppression:", { messageId: message.id });
      }
    }, delay);
    timer.unref?.();
  }
}

async function handleOriginalPreviewUpdate(message) {
  if (!managedPreviews.has(message.id) || message.author?.bot) return;
  if (message.embeds?.length && !message.flags?.has(4)) await hidePreview(message);
}

module.exports = {
  WORKING_TEXT,
  FAILURE_TEXT,
  STICKERS,
  MediaRetrievalTimeoutError,
  withMediaLifecycle,
  sendStandaloneNotice,
  deleteOriginalAfterSuccess,
  suppressOriginalEmbeds,
  handleOriginalPreviewUpdate,
};
