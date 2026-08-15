const { getMediaInfo } = require("../services/ytDlp");
const { downloadMedia } = require("../modules/media/downloader");
const {
  downloadFacebookMedia,
} = require("../modules/media/facebookDownloader");
const {
  downloadTikTokMedia,
} = require("../modules/media/tiktokDownloader");
const { classify } = require("../modules/media/classifier");
const { formatMediaCard } = require("../modules/media/formatter");
const { uploadMedia } = require("../modules/media/uploader");
const {
  findInstagramLinks,
  extractInstagramId,
} = require("../modules/media/instagram");
const {
  findFacebookLinks,
  extractFacebookId,
} = require("../modules/media/facebook");
const {
  normalizeFacebookUrl,
} = require("../modules/media/facebookNormalize");
const {
  findTikTokLinks,
  extractTikTokId,
} = require("../modules/media/tiktok");
const {
  normalizeTikTokUrl,
} = require("../modules/media/tiktokNormalize");
const {
  findXLinks,
  extractXId,
} = require("../modules/media/x");
const {
  downloadXMedia,
} = require("../modules/media/xDownloader");
const {
  findYouTubeLinks,
  extractYouTubeId,
  isYouTubeShort,
} = require("../modules/media/youtube");
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
    // Keep the raw value if parsing fails.
  }

  return [
    "Thank you for helping keep our collection growing!",
    "",
    "It looks like this post has already been added.",
    "",
    `Originally shared on ${dateLine}`,
    `by ${record.shared_by}`,
    "",
    "💜 𝑯𝒂𝒓𝒎𝒐𝒏𝒚",
  ].join("\n");
}

/**
 * Sends a friendly error reply while keeping
 * technical details in the terminal.
 *
 * @param {import("discord.js").Message} message
 * @param {unknown} error
 */
async function replyWithHarmonyError(message, error) {
  console.error("Harmony Error:", error);

  await message
    .reply({
      content: [
        "I’m sorry, I couldn’t retrieve that post right now.",
        "The original link is still available above.",
        "",
        "💜 𝑯𝒂𝒓𝒎𝒐𝒏𝒚",
      ].join("\n"),
      allowedMentions: {
        repliedUser: false,
      },
    })
    .catch(() => {});
}

/**
 * Suppress embeds on the user's original message.
 * Logs permission failures instead of failing silently.
 *
 * @param {import("discord.js").Message} message
 */
async function suppressOriginalEmbeds(message) {
  try {
    await message.suppressEmbeds(true);
    console.log("Original message embeds suppressed.");
  } catch (err) {
    console.warn(
      "suppressEmbeds failed (bot needs Manage Messages in this channel?):",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Handles supported social-media links
 * in a Discord message.
 *
 * @param {import("discord.js").Message} message
 */
async function handleMediaMessage(message) {
  if (message.author.bot) return;

  const instagramLinks =
    findInstagramLinks(message.content);

  const facebookLinks =
    findFacebookLinks(message.content);

  const tiktokLinks =
    findTikTokLinks(message.content);

  const xLinks =
    findXLinks(message.content);

  const youtubeLinks =
    findYouTubeLinks(message.content);

  console.log("TikTok detection:", {
    content: message.content,
    tiktokLinks,
  });

  // =========================
  // Instagram
  // =========================

  if (instagramLinks.length > 0) {
    const originalUrl = instagramLinks[0];
    const mediaId = extractInstagramId(originalUrl);

    if (!mediaId) {
      console.warn(
        "Could not extract Instagram media id from:",
        originalUrl
      );
      return;
    }

    const platform = "instagram";

    try {
      const existing =
        shareStore.find(platform, mediaId);

      if (existing) {
        await message.reply({
          content:
            formatAlreadySharedReply(existing),
          allowedMentions: {
            repliedUser: false,
          },
        });

        return;
      }

      await message.channel.sendTyping();

      let info = null;

      try {
        info = await getMediaInfo(originalUrl);
      } catch {
        console.warn(
          "Metadata unavailable. Continuing with download only."
        );
      }

      const downloadResult =
        await downloadMedia(originalUrl);

      const classification = classify(
        downloadResult.files,
        originalUrl
      );

      if (classification.files.length === 0) {
        throw new Error(
          "No media files were downloaded."
        );
      }

      const creator = resolveCreator(
        info,
        classification.files
      );

      const cardText = formatMediaCard({
        platform: "Instagram",
        mediaType: classification.label,
        creator,
        originalUrl,
        heart: "💛",
      });

      await uploadMedia(
        message,
        classification.files,
        cardText,
        downloadResult.rawDir,
        { embedColor: 0xfacc15 }
      );

      await suppressOriginalEmbeds(message);

      shareStore.insert({
        platform,
        mediaId,
        creator,
        sharedBy:
          message.member?.displayName ??
          message.author.username,
        sharedById: message.author.id,
        messageId: message.id,
        channelId: message.channel.id,
        guildId: message.guild?.id ?? null,
        url: originalUrl,
      });

      console.log(
        `Instagram ${classification.label} ` +
          `(${classification.files.length} file(s)) ` +
          `shared for ${message.author.username}`
      );
    } catch (error) {
      await replyWithHarmonyError(
        message,
        error
      );
    }

    return;
  }

  // =========================
  // Facebook
  // =========================

  if (facebookLinks.length > 0) {
    const originalUrl = facebookLinks[0];

    const normalizedUrl =
      await normalizeFacebookUrl(originalUrl);

    let mediaId =
      extractFacebookId(normalizedUrl) ||
      extractFacebookId(originalUrl);

    if (!mediaId) {
      mediaId = `url:${normalizedUrl}`;
      console.warn(
        "Facebook media id weak fallback for:",
        normalizedUrl
      );
    }

    const platform = "facebook";

    try {
      const existing =
        shareStore.find(platform, mediaId);

      if (existing) {
        await message.reply({
          content:
            formatAlreadySharedReply(existing),
          allowedMentions: {
            repliedUser: false,
          },
        });
        await suppressOriginalEmbeds(message);
        return;
      }

      await message.channel.sendTyping();

      let info = null;

      try {
        info =
          await getMediaInfo(normalizedUrl);
      } catch {
        console.warn(
          "Facebook metadata unavailable. Continuing with download only."
        );
      }

      const downloadResult =
        await downloadFacebookMedia(
          normalizedUrl,
          originalUrl
        );

      const classification = classify(
        downloadResult.files,
        normalizedUrl
      );

      if (classification.files.length === 0) {
        throw new Error(
          "No media files were downloaded."
        );
      }

      const creator =
        downloadResult.creator ||
        info?.uploader ||
        info?.creator ||
        "Unknown creator";

      const cardText = formatMediaCard({
        platform: "Facebook",
        mediaType: classification.label,
        creator,
        originalUrl: normalizedUrl,
        heart: "💙",
      });

      await uploadMedia(
        message,
        classification.files,
        cardText,
        downloadResult.rawDir
      );

      await suppressOriginalEmbeds(message);
      setTimeout(() => {
        suppressOriginalEmbeds(message).catch(() => {});
      }, 2500);

      shareStore.insert({
        platform,
        mediaId,
        creator,
        sharedBy:
          message.member?.displayName ??
          message.author.username,
        sharedById: message.author.id,
        messageId: message.id,
        channelId: message.channel.id,
        guildId: message.guild?.id ?? null,
        url: normalizedUrl,
      });

      console.log(
        `Facebook ${classification.label} ` +
          `(${classification.files.length} file(s)) ` +
          `shared for ${message.author.username}`
      );
    } catch (error) {
      await replyWithHarmonyError(
        message,
        error
      );
    }

    return;
  }

  // =========================
  // TikTok
  // =========================

  if (tiktokLinks.length > 0) {
    const originalUrl = tiktokLinks[0];
    const platform = "tiktok";

    try {
      await message.channel.sendTyping();

      const normalizedUrl =
        await normalizeTikTokUrl(originalUrl);

      const mediaId =
        extractTikTokId(normalizedUrl);

      if (!mediaId) {
        throw new Error(
          "Harmony could not determine the TikTok video ID."
        );
      }

      const existing =
        shareStore.find(platform, mediaId);

      if (existing) {
        await message.reply({
          content:
            formatAlreadySharedReply(existing),
          allowedMentions: {
            repliedUser: false,
          },
        });

        return;
      }

      let info = null;

      try {
        info =
          await getMediaInfo(normalizedUrl);
      } catch {
        console.warn(
          "TikTok metadata unavailable. Continuing with download only."
        );
      }

      const downloadResult =
        await downloadTikTokMedia(
          normalizedUrl
        );

      const classification = classify(
        downloadResult.files,
        normalizedUrl
      );

      if (classification.files.length === 0) {
        throw new Error(
          "No TikTok media files were downloaded."
        );
      }

      const creator =
        downloadResult.creator ||
        info?.uploader ||
        info?.creator ||
        "Unknown creator";

      const cardText = formatMediaCard({
        platform: "TikTok",
        mediaType: classification.label,
        creator,
        originalUrl: normalizedUrl,
        heart: "🩷",
      });

      await uploadMedia(
        message,
        classification.files,
        cardText,
        downloadResult.rawDir,
        { embedColor: 0xff4fa3 }
      );

      // Hide Discord's native TikTok preview only after a successful upload.
      // TikTok embeds often load late, so suppress once now and once after a short delay.
      await suppressOriginalEmbeds(message);
      setTimeout(() => {
        suppressOriginalEmbeds(message).catch(() => {});
      }, 2500);

      shareStore.insert({
        platform,
        mediaId,
        creator,
        sharedBy:
          message.member?.displayName ??
          message.author.username,
        sharedById: message.author.id,
        messageId: message.id,
        channelId: message.channel.id,
        guildId: message.guild?.id ?? null,
        url: normalizedUrl,
      });

      console.log(
        `TikTok ${classification.label} ` +
          `(${classification.files.length} file(s)) ` +
          `shared for ${message.author.username}`
      );
    } catch (error) {
      await replyWithHarmonyError(
        message,
        error
      );
    }

    return;
  }

  // =========================
  // X
  // =========================

  if (xLinks.length > 0) {
    const originalUrl = xLinks[0];
    const mediaId = extractXId(originalUrl);
    const platform = "x";

    if (!mediaId) {
      console.warn(
        "Could not extract X status id from:",
        originalUrl
      );
      return;
    }

    try {
      const existing =
        shareStore.find(platform, mediaId);

      if (existing) {
        await message.reply({
          content:
            formatAlreadySharedReply(existing),
          allowedMentions: {
            repliedUser: false,
          },
        });

        return;
      }

      await message.channel.sendTyping();

      const downloadResult =
        await downloadXMedia(originalUrl);

      const classification = classify(
        downloadResult.files,
        originalUrl
      );

      if (classification.files.length === 0) {
        throw new Error(
          "No X media files were downloaded."
        );
      }

      const creator =
        downloadResult.creator ||
        "Unknown creator";

      // X serves animated GIFs as MP4; trust Twitter/X metadata only.
      let mediaType = classification.label;
      if (
        downloadResult.isGif &&
        classification.kind === "video"
      ) {
        mediaType = "GIF";
      }

      const cardText = formatMediaCard({
        platform: "X",
        mediaType,
        creator,
        originalUrl,
        heart: "🖤",
      });

      await uploadMedia(
        message,
        classification.files,
        cardText,
        downloadResult.rawDir,
        { embedColor: 0x000000 }
      );

      await suppressOriginalEmbeds(message);

      shareStore.insert({
        platform,
        mediaId,
        creator,
        sharedBy:
          message.member?.displayName ??
          message.author.username,
        sharedById: message.author.id,
        messageId: message.id,
        channelId: message.channel.id,
        guildId: message.guild?.id ?? null,
        url: originalUrl,
      });

      console.log(
        `X ${classification.label} ` +
          `(${classification.files.length} file(s)) ` +
          `shared for ${message.author.username}`
      );
    } catch (error) {
      await replyWithHarmonyError(
        message,
        error
      );
    }

    return;
  }

  // =========================
  // YouTube
  // =========================

  if (youtubeLinks.length > 0) {
    const originalUrl = youtubeLinks[0];
    const mediaId = extractYouTubeId(originalUrl);
    const platform = "youtube";

    if (!mediaId) {
      console.warn(
        "Could not extract YouTube video id from:",
        originalUrl
      );
      return;
    }

    try {
      const existing =
        shareStore.find(platform, mediaId);

      if (existing) {
        await message.reply({
          content:
            formatAlreadySharedReply(existing),
          allowedMentions: {
            repliedUser: false,
          },
        });

        await suppressOriginalEmbeds(message);
        return;
      }

      await message.channel.sendTyping();

      let info = null;

      try {
        info = await getMediaInfo(originalUrl);
      } catch {
        console.warn(
          "YouTube metadata unavailable. Continuing with download only."
        );
      }

      const downloadResult =
        await downloadMedia(originalUrl);

      const classification = classify(
        downloadResult.files,
        originalUrl
      );

      if (classification.files.length === 0) {
        throw new Error(
          "No YouTube media files were downloaded."
        );
      }

      const creator = resolveCreator(
        info,
        classification.files
      );

      const mediaType =
        isYouTubeShort(originalUrl)
          ? "Short"
          : classification.label;

      const cardText = formatMediaCard({
        platform: "YouTube",
        mediaType,
        creator,
        originalUrl,
        heart: "❤️",
      });

      await uploadMedia(
        message,
        classification.files,
        cardText,
        downloadResult.rawDir,
        { embedColor: 0xff0000 }
      );

      await suppressOriginalEmbeds(message);
      setTimeout(() => {
        suppressOriginalEmbeds(message).catch(() => {});
      }, 2500);

      shareStore.insert({
        platform,
        mediaId,
        creator,
        sharedBy:
          message.member?.displayName ??
          message.author.username,
        sharedById: message.author.id,
        messageId: message.id,
        channelId: message.channel.id,
        guildId: message.guild?.id ?? null,
        url: originalUrl,
      });

      console.log(
        `YouTube ${mediaType} ` +
          `(${classification.files.length} file(s)) ` +
          `shared for ${message.author.username}`
      );
    } catch (error) {
      await replyWithHarmonyError(
        message,
        error
      );
    }

    return;
  }
}

module.exports = {
  handleMediaMessage,
};
