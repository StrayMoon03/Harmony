const managedPreviews = new Map();
const suppressing = new Set();

async function withDelayedProgress(message, work, delayMs = 3000) {
  let finished = false;
  let pending;
  const timer = setTimeout(() => {
    if (finished) return;
    pending = Promise.resolve().then(() => message.reply({
      content: "-# Harmony is working on your post—just a moment…",
      allowedMentions: { repliedUser: false, parse: [] },
    })).catch(() => null);
  }, delayMs);
  try {
    return await work();
  } finally {
    finished = true;
    clearTimeout(timer);
    const status = await pending;
    if (status) await status.delete().catch(() => {
      console.warn("Could not remove Harmony processing message.");
    });
  }
}

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

module.exports = { withDelayedProgress, suppressOriginalEmbeds, handleOriginalPreviewUpdate };
