const { getMediaInfo } = require("../services/ytDlp");
const { downloadMedia } = require("../modules/media/downloader");
const { classify } = require("../modules/media/classifier");
const { formatMediaCard } = require("../modules/media/formatter");
const { uploadMedia } = require("../modules/media/uploader");
const {
  findInstagramLinks,
  extractInstagramId,
} = require("../modules/media/instagram");
const { resolveCreator } = require("../modules/media/creator");
const shareStore = require("../stores/shareStore");

/**
 * Format a friendly "already shared" reply.
 *
 * @param {{ shared_by: string, shared_at: string }} record
 * @returns {string}
 */
function formatAlreadySharedReply(record) {
  let dateLine = record.shared_at;
  try {
    const d = new Date(record.shared_at);
    dateLine = d.toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    // keep raw ISO string
  }

  return [
    "Thank you for helping keep our collection growing!",
    "",
    "It looks like this post has already been added.",
    "",
    `Originally shared by ${record.shared_by}`,
    dateLine,
    "",
    "💜 Harmony",
  ].join("\n");
}

/**
 * Handles supported social-media links in a Discord message.
 *
 * @param {import("discord.js").Message} message
 */
async function handleMediaMessage(message) {
  if (message.author.bot) return;

  const instagramLinks = findInstagramLinks(message.content);
  if (instagramLinks.length === 0) return;

  const originalUrl = instagramLinks[0];
  const mediaId = extractInstagramId(originalUrl);

  if (!mediaId) {
    console.warn("Could not extract Instagram media id from:", originalUrl);
    return;
  }

  const platform = "instagram";

  try {
    // --- Duplicate check BEFORE any download ---
    const existing = shareStore.find(platform, mediaId);
    if (existing) {
      await message.reply({
        content: formatAlreadySharedReply(existing),
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    await message.channel.sendTyping();

    let info = null;
    try {
      info = await getMediaInfo(originalUrl);
    } catch {
      console.warn("Metadata unavailable. Continuing with download only.");
    }

    const downloadResult = await downloadMedia(originalUrl);
    const classification = classify(downloadResult.files, originalUrl);

    if (classification.files.length === 0) {
      throw new Error("No media files were downloaded.");
    }

    const creator = resolveCreator(info, classification.files);

    const cardText = formatMediaCard({
      platform: "Instagram",
      mediaType: classification.label,
      creator,
      originalUrl,
      heart: "💗",
    });

    await uploadMedia(
      message,
      classification.files,
      cardText,
      downloadResult.rawDir
    );

    // --- Record only after successful upload ---
    shareStore.insert({
      platform,
      mediaId,
      creator,
      sharedBy: message.member?.displayName || message.author.username,
      sharedById: message.author.id,
      messageId: message.id,
      channelId: message.channel.id,
      guildId: message.guild?.id ?? null,
      url: originalUrl,
    });

    console.log(
      `Instagram ${classification.label} (${classification.files.length} file(s)) shared for ${message.author.username}`
    );
  } catch (error) {
    console.error("Harmony Error:", error);

    await message
      .reply({
        content:
          "❌ Harmony encountered an error.\n\n```" +
          error.message +
          "```",
        allowedMentions: { repliedUser: false },
      })
      .catch(() => {});
  }
}

module.exports = {
  handleMediaMessage,
};
