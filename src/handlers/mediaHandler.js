const { getMediaInfo } = require("../services/ytDlp");
const { downloadMedia } = require("../modules/media/downloader");
const { classify } = require("../modules/media/classifier");
const { formatMediaCard } = require("../modules/media/formatter");
const { uploadMedia } = require("../modules/media/uploader");
const { findInstagramLinks } = require("../modules/media/instagram");
const { resolveCreator } = require("../modules/media/creator");

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

  try {
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

    // yt-dlp uploader when available; otherwise username from gallery-dl path.
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
