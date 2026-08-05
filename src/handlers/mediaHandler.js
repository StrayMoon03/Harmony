const { getMediaInfo } = require("../services/ytDlp");
const { downloadMedia } = require("../modules/media/downloader");
const { classify } = require("../modules/media/classifier");
const { formatMediaCard } = require("../modules/media/formatter");
const { uploadMedia } = require("../modules/media/uploader");
const { findInstagramLinks } = require("../modules/media/instagram");

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

    // Metadata is optional.
    let info = null;

    try {
      info = await getMediaInfo(originalUrl);
    } catch (err) {
      console.warn("Metadata unavailable. Continuing with download only.");
    }

    // Download the actual media.
    const downloadResult = await downloadMedia(originalUrl);

    // Classify based on what was actually downloaded.
    const classification = classify(downloadResult.files, originalUrl);

    if (classification.files.length === 0) {
      throw new Error("No media files were downloaded.");
    }

    const creator = info?.uploader || "Unknown creator";

    const cardText = formatMediaCard({
      platform: "Instagram",
      mediaType: classification.label,
      creator,
      originalUrl,
      heart: "💗",
    });

    await uploadMedia(message, classification.files, cardText);

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
        allowedMentions: {
          repliedUser: false,
        },
      })
      .catch(() => {});
  }
}

module.exports = {
  handleMediaMessage,
};