const {
  FAILURE_TEXT,
  isHandledMediaTimeout,
  withMediaLifecycle,
  sendStandaloneNotice,
  deleteOriginalAfterSuccess,
} = require("../modules/media/messageLifecycle");
const fs = require("node:fs/promises");
const { EmbedBuilder } = require("discord.js");
const { getMediaInfo } = require("../services/ytDlp");
const { downloadMedia } = require("../modules/media/downloader");
const {
  downloadFacebookMedia,
} = require("../modules/media/facebookDownloader");
const {
  downloadTikTokMedia,
} = require("../modules/media/tiktokDownloader");
const { classify } = require("../modules/media/classifier");
const { formatMediaCard, extractOriginalDate, formatXTextPost } = require("../modules/media/formatter");
const { extractMemberComment } = require("../modules/media/memberComment");
const { platformHeart } = require("../modules/media/emojiConfig");
const { uploadMedia } = require("../modules/media/uploader");
const {
  findInstagramLinks,
  extractInstagramId,
  findInstagramPreviewUrl,
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
  isTikTokLiveUrl,
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
const {
  downloadYouTubeMedia,
  shouldKeepOriginalYouTubePreview,
} = require("../modules/media/youtubeDownloader");
const {
  findThreadsLinks,
  extractThreadsId,
  matchesThreadsPreview,
} = require("../modules/media/threads");
const {
  downloadThreadsMedia,
} = require("../modules/media/threadsDownloader");
const { resolveCreator } = require("../modules/media/creator");
const shareStore = require("../stores/shareStore");
const { formatDiscordTimestamp } = require("../utils/discordTimestamp");
const { logMediaError } = require("../services/errorInboxService");

function buildSuccessfulCard(message, processedUrl, options) {
  const preservation = extractMemberComment(message.content, processedUrl);
  return {
    cardText: formatMediaCard({
      ...options,
      sharedById: message.author.id,
      memberComment: preservation.comment,
    }),
    safeToDelete: preservation.safeToDelete,
  };
}

/**
 * Format a friendly "already shared" reply.
 *
 * @param {{ shared_by: string, shared_at: string }} record
 * @returns {string}
 */
function formatAlreadySharedReply(record, platform) {
  const dateLine = formatDiscordTimestamp(record.shared_at).replace(/:f>$/, ":D>");
  const member = record.shared_by_id
    ? `<@${record.shared_by_id}>`
    : `@${String(record.shared_by || "member").replace(/^@/, "")}`;
  return [
    "Already shared!",
    `By ${member} • ${dateLine}`,
    `Thank you, ${platformHeart(platform)} Harmony`,
  ].join("\n");
}

async function sendAlreadyShared(message, record, platform) {
  return sendStandaloneNotice(
    message,
    formatAlreadySharedReply(record, platform),
    "thanks",
    { autoDeleteMs: 5000 }
  );
}

async function markRetrievedOrCleanup(lifecycle, downloadResult) {
  try {
    await lifecycle.markRetrieved();
  } catch (error) {
    if (downloadResult?.rawDir) {
      await fs.rm(downloadResult.rawDir, { recursive: true, force: true }).catch(() => {});
    } else {
      await Promise.all((downloadResult?.files || []).map((file) =>
        fs.unlink(file.path).catch(() => {})
      ));
    }
    throw error;
  }
}

/**
 * Sends a friendly error reply while keeping
 * technical details in the terminal.
 *
 * @param {import("discord.js").Message} message
 * @param {unknown} error
 */
async function replyWithHarmonyError(message, error, lifecycle) {
  // The lifecycle cutoff already reports timeout failures. If a downloader
  // finishes just after that cutoff, markRetrieved() surfaces the same timeout
  // here; returning first prevents a duplicate private incident.
  if (isHandledMediaTimeout(error, lifecycle)) return;

  console.error("Harmony Error:", error);

  await logMediaError(message, error).catch((reportError) => {
    console.error("Could not send media failure to Harmony’s error inbox:", reportError);
  });

  if (lifecycle && !(await lifecycle.finishFailure())) return;
  await sendStandaloneNotice(message, FAILURE_TEXT, "failure", {
    autoDeleteMs: 5000,
  }).catch(() => {});
}

/**
 * Keeps Discord's typing indicator visible during longer media jobs.
 * Returns a function that stops future refreshes.
 *
 * @param {import("discord.js").Message} message
 * @returns {() => void}
 */
function startTypingIndicator(message) {
  let stopped = false;

  const refresh = () => {
    if (stopped) return;
    message.channel.sendTyping().catch((error) => {
      console.warn(
        "Could not refresh typing indicator:",
        error instanceof Error ? error.message : error
      );
    });
  };

  refresh();
  const timer = setInterval(refresh, 8000);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Sends a long YouTube video as two messages so Discord can generate its
 * native player without competing with Harmony's custom red card embed.
 *
 * @param {import("discord.js").Message} message
 * @param {{ originalUrl: string, cardText: string, durationMinutes: number|null }} options
 */
async function sendInstagramStreamingPreview(
  message,
  { originalUrl, cardText, previewUrl }
) {
  const linkMessage = await message.reply({
    content: originalUrl,
    allowedMentions: { repliedUser: false },
  });
  const embed = new EmbedBuilder()
    .setColor(0xfacc15)
    .setDescription([
      cardText,
      "",
      "This reel plays through Instagram so it keeps its original sound.",
    ].join("\n"));

  if (previewUrl) {
    embed.setImage(previewUrl);
  }

  const cardMessage = await message.channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });

  shareStore.addOutputMessage(message.id, linkMessage.id, linkMessage.channelId);
  shareStore.addOutputMessage(message.id, cardMessage.id, cardMessage.channelId);
  await suppressOriginalEmbeds(message);
}

async function sendYouTubeStreamingPreview(
  message,
  { originalUrl, cardText, durationMinutes }
) {
  const linkMessage = await message.reply({
    content: originalUrl,
    allowedMentions: {
      repliedUser: false,
    },
  });

  const cardMessage = await message.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xff0000)
        .setDescription(
          [
            cardText,
            "",
            durationMinutes
              ? `This ${durationMinutes}-minute video plays through YouTube so it can remain full length.`
              : "This video plays through YouTube so it can remain full length.",
          ].join("\n")
        ),
    ],
    allowedMentions: {
      parse: [],
    },
  });

  shareStore.addOutputMessage(message.id, linkMessage.id, linkMessage.channelId);
  shareStore.addOutputMessage(message.id, cardMessage.id, cardMessage.channelId);

  await suppressOriginalEmbeds(message);
}

/**
 * Keeps long TikTok videos at their original quality instead of crushing
 * several minutes of video into Discord's small attachment limit.
 *
 * @param {import("discord.js").Message} message
 * @param {{ originalUrl: string, cardText: string, durationMinutes: number }} options
 */
async function sendTikTokStreamingPreview(
  message,
  { originalUrl, cardText, durationMinutes }
) {
  const linkMessage = await message.reply({
    content: originalUrl,
    allowedMentions: { repliedUser: false },
  });

  const cardMessage = await message.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xff4fa3)
        .setDescription(
          [
            cardText,
            "",
            `This ${durationMinutes}-minute video plays through TikTok so it keeps its original quality and sound.`,
          ].join("\n")
        ),
    ],
    allowedMentions: { parse: [] },
  });

  shareStore.addOutputMessage(message.id, linkMessage.id, linkMessage.channelId);
  shareStore.addOutputMessage(message.id, cardMessage.id, cardMessage.channelId);

  await suppressOriginalEmbeds(message);
}

async function getThreadsDiscordEmbedFallback(message, originalUrl, resolvedUrl) {

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let current = message;
    let fetchFailed = false;
    if (attempt > 0) {
      try {
        current = await message.fetch(true);
      } catch (error) {
        fetchFailed = true;
        console.warn(
          `Threads Discord embed fetch attempt ${attempt} failed:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    const embed = current.embeds.find((item) => {
      const provider = String(item.provider?.name || "").toLowerCase();
      const url = String(item.url || "").toLowerCase();
      const belongsToPost = matchesThreadsPreview(item.url, originalUrl, resolvedUrl);
      return belongsToPost && (
        provider.includes("threads") ||
        url.includes("threads.com") ||
        url.includes("threads.net")
      );
    });

    if (embed) {
      const video = embed.video?.url || embed.video?.proxyURL;
      const image = embed.image?.url || embed.image?.proxyURL;
      const candidates = video ? [video] : image ? [image] : [];
      const titleCreator = String(embed.title || "")
        .replace(/\s+on Threads\s*$/i, "")
        .trim();

      if (candidates.length) {
        console.log("Threads Discord embed supplied exact-message media.");
        return {
          candidates,
          creator: embed.author?.name || titleCreator || null,
          finalUrl: embed.url || null,
        };
      }
    }

    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  console.warn("Threads Discord embed fallback found no usable video or image media.");
  return null;
}

/**
 * Handles supported social-media links
 * in a Discord message.
 *
 * @param {import("discord.js").Message} message
 */
async function processMediaMessage(message, lifecycle) {
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

  const threadsLinks =
    findThreadsLinks(message.content);

  console.log("YouTube detection:", {
    content: message.content,
    youtubeLinks,
  });

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
    let info = null;

    try {
      const existing =
        shareStore.find(platform, mediaId, message.guild?.id ?? null);

      if (existing) {
        await lifecycle.markRetrieved();
        await sendAlreadyShared(message, existing, platform);

        return;
      }

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

      const creator = downloadResult.creator || resolveCreator(
        info,
        classification.files
      );

      const { cardText, safeToDelete } = buildSuccessfulCard(message, originalUrl, {
        platform: "Instagram",
        mediaType: classification.label,
        creator,
        originalUrl,
        originalDate: extractOriginalDate(info),
      });

      await markRetrievedOrCleanup(lifecycle, downloadResult);
      const sentMessageIds = await uploadMedia(
        message,
        classification.files,
        cardText,
        downloadResult.rawDir,
        {
          embedColor: 0xfacc15,
          ensureAppleCompatibleVideo: true,
        }
      );
      await deleteOriginalAfterSuccess(message, sentMessageIds, safeToDelete);

      shareStore.insert({
        platform,
        mediaId,
        creator,
        sharedBy:
          message.member?.displayName ??
          message.author.username,
        sharedById: message.author.id,
        messageId: null,
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
        error,
        lifecycle
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
        shareStore.find(platform, mediaId, message.guild?.id ?? null);

      if (existing) {
        await lifecycle.markRetrieved();
        await sendAlreadyShared(message, existing, platform);
        return;
      }

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

      if (downloadResult.linkOnly) {
        throw new Error(downloadResult.failureReason || "FACEBOOK_UNVERIFIED_MEDIA");
      }

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

      const { cardText, safeToDelete } = buildSuccessfulCard(message, originalUrl, {
        platform: "Facebook",
        mediaType: classification.label,
        creator,
        originalUrl: normalizedUrl,
        originalDate: extractOriginalDate(info),
      });

      await markRetrievedOrCleanup(lifecycle, downloadResult);
      const sentMessageIds = await uploadMedia(
        message,
        classification.files,
        cardText,
        downloadResult.rawDir
      );

      await deleteOriginalAfterSuccess(message, sentMessageIds, safeToDelete);

      shareStore.insert({
        platform,
        mediaId,
        creator,
        sharedBy:
          message.member?.displayName ??
          message.author.username,
        sharedById: message.author.id,
        messageId: null,
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
        error,
        lifecycle
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
      const normalizedUrl =
        await normalizeTikTokUrl(originalUrl);

      if (isTikTokLiveUrl(normalizedUrl)) {
        throw new Error("TikTok live broadcasts cannot be archived as standalone media.");
      }

      const mediaId =
        extractTikTokId(normalizedUrl);

      if (!mediaId) {
        throw new Error(
          "Harmony could not determine the TikTok video ID."
        );
      }

      const existing =
        shareStore.find(platform, mediaId, message.guild?.id ?? null);

      if (existing) {
        await lifecycle.markRetrieved();
        await sendAlreadyShared(message, existing, platform);

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

      const durationSeconds = Number(info?.duration || 0);
      const isPhotoPost =
        /\/photo\/\d+/i.test(normalizedUrl);

      // TikTok photo-mode posts can expose the soundtrack duration in
      // metadata. That duration does not make the post a long video.
      if (!isPhotoPost && durationSeconds >= 90) {
        throw new Error("TikTok video requires its original platform link and cannot be replaced safely.");
      }

      const downloadResult =
        await downloadTikTokMedia(
          normalizedUrl
        );

      // Photo-mode downloads intentionally have no video audio stream.
      // Keep their downloaded images and send them through the carousel
      // uploader instead of replacing them with a link-only video card.
      if (!isPhotoPost && !downloadResult.hasAudio) {
        await fs.rm(downloadResult.rawDir, {
          recursive: true,
          force: true,
        }).catch(() => {});
        throw new Error("TikTok media did not contain a safe standalone video with audio.");
      }

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

      const { cardText, safeToDelete } = buildSuccessfulCard(message, originalUrl, {
        platform: "TikTok",
        mediaType: classification.label,
        creator,
        originalUrl: normalizedUrl,
        originalDate: extractOriginalDate(info),
      });

      await markRetrievedOrCleanup(lifecycle, downloadResult);
      const sentMessageIds = await uploadMedia(
        message,
        classification.files,
        cardText,
        downloadResult.rawDir,
        { embedColor: 0xff4fa3 }
      );
      await deleteOriginalAfterSuccess(message, sentMessageIds, safeToDelete);

      shareStore.insert({
        platform,
        mediaId,
        creator,
        sharedBy:
          message.member?.displayName ??
          message.author.username,
        sharedById: message.author.id,
        messageId: null,
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
        error,
        lifecycle
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
        shareStore.find(platform, mediaId, message.guild?.id ?? null);

      if (existing) {
        await lifecycle.markRetrieved();
        await sendAlreadyShared(message, existing, platform);

        return;
      }

      const [downloadResult, infoResult] = await Promise.all([
        downloadXMedia(originalUrl),
        getMediaInfo(originalUrl).catch(() => null),
      ]);
      const info = infoResult;

      if (downloadResult.linkOnly) {
        let replacementMessageId = null;
        if (downloadResult.text) {
          const preservation = extractMemberComment(message.content, originalUrl);
          const textCard = formatXTextPost({
            displayName: downloadResult.displayName,
            handle: downloadResult.creator,
            originalDate: downloadResult.originalDate || extractOriginalDate(info),
            text: downloadResult.text,
            originalUrl,
            sharedById: message.author.id,
            memberComment: preservation.comment,
          });
          await lifecycle.markRetrieved();
          const sent = await message.channel.send({
            content: textCard,
            allowedMentions: { parse: [] },
          });
          replacementMessageId = sent.id;
          await deleteOriginalAfterSuccess(
            message,
            [sent.id],
            preservation.safeToDelete
          );
        }
        shareStore.insert({
          platform,
          mediaId,
          creator: downloadResult.creator || "Unknown creator",
          sharedBy:
            message.member?.displayName ??
            message.author.username,
          sharedById: message.author.id,
          messageId: replacementMessageId || message.id,
          channelId: message.channel.id,
          guildId: message.guild?.id ?? null,
          url: originalUrl,
        });
        console.log(
          downloadResult.text
            ? "X text-only post replaced with Harmony's compact standalone post."
            : "X text-only post preserved because exact post text was unavailable."
        );
        return;
      }

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

      const { cardText, safeToDelete } = buildSuccessfulCard(message, originalUrl, {
        platform: "X",
        mediaType,
        creator,
        originalUrl,
        originalDate: downloadResult.originalDate || extractOriginalDate(info),
      });

      await markRetrievedOrCleanup(lifecycle, downloadResult);
      try {
        var sentMessageIds = await uploadMedia(
          message,
          classification.files,
          cardText,
          downloadResult.rawDir,
          { embedColor: 0x000000 }
        );
      } catch (uploadError) {
        const sizeFailure = /compress|too large|size limit|under discord limit/i.test(
          String(uploadError?.message || uploadError)
        );
        if (!sizeFailure) throw uploadError;
        throw new Error("X media could not fit safely in a standalone Discord replacement.");
      }

      await deleteOriginalAfterSuccess(message, sentMessageIds, safeToDelete);

      shareStore.insert({
        platform,
        mediaId,
        creator,
        sharedBy:
          message.member?.displayName ??
          message.author.username,
        sharedById: message.author.id,
        messageId: null,
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
        error,
        lifecycle
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
        shareStore.find(platform, mediaId, message.guild?.id ?? null);

      if (existing) {
        await lifecycle.markRetrieved();
        await sendAlreadyShared(message, existing, platform);
        return;
      }

      console.log(
        `YouTube link accepted: ${mediaId}`
      );

      const [downloadResult, info] = await Promise.all([
        downloadYouTubeMedia(originalUrl),
        getMediaInfo(originalUrl).catch(() => null),
      ]);

      if (downloadResult.linkOnly) {
        if (shouldKeepOriginalYouTubePreview(downloadResult)) {
          await lifecycle.markRetrieved();
          console.log(
            "YouTube long video left as its original streaming preview."
          );
          return;
        }
        throw new Error("YouTube media requires its original platform link and cannot be replaced safely.");
      }

      const classification = classify(
        downloadResult.files,
        originalUrl
      );

      if (classification.files.length === 0) {
        throw new Error(
          "No YouTube media files were downloaded."
        );
      }

      const creator =
        downloadResult.creator ||
        "Unknown creator";

      const mediaType =
        isYouTubeShort(originalUrl)
          ? "Short"
          : classification.label;

      const { cardText, safeToDelete } = buildSuccessfulCard(message, originalUrl, {
        platform: "YouTube",
        mediaType,
        creator,
        originalUrl,
        originalDate: extractOriginalDate(info),
      });

      await markRetrievedOrCleanup(lifecycle, downloadResult);
      try {
        var sentMessageIds = await uploadMedia(
          message,
          classification.files,
          cardText,
          downloadResult.rawDir,
          { embedColor: 0xff0000 }
        );
      } catch (uploadError) {
        console.warn(
          "YouTube attachment could not fit; switching to streaming preview:",
          uploadError instanceof Error
            ? uploadError.message
            : uploadError
        );

        throw new Error("YouTube media could not fit safely in a standalone Discord replacement.");
      }

      await deleteOriginalAfterSuccess(message, sentMessageIds, safeToDelete);

      shareStore.insert({
        platform,
        mediaId,
        creator,
        sharedBy:
          message.member?.displayName ??
          message.author.username,
        sharedById: message.author.id,
        messageId: null,
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
        error,
        lifecycle
      );
    }

    return;
  }

  // =========================
  // Threads
  // =========================

  if (threadsLinks.length > 0) {
    const originalUrl = threadsLinks[0];
    const mediaId = extractThreadsId(originalUrl);
    const platform = "threads";

    if (!mediaId) {
      console.warn(
        "Could not extract Threads post id from:",
        originalUrl
      );
      return;
    }

    try {
      const existing =
        shareStore.find(platform, mediaId, message.guild?.id ?? null);

      if (existing) {
        await lifecycle.markRetrieved();
        await sendAlreadyShared(message, existing, platform);
        return;
      }

      console.log(
        `Threads link accepted: ${mediaId}`
      );

      const [downloadResult, info] = await Promise.all([
        downloadThreadsMedia(originalUrl, {
          getDiscordEmbedFallback: (resolvedUrl) =>
            getThreadsDiscordEmbedFallback(message, originalUrl, resolvedUrl),
        }),
        getMediaInfo(originalUrl).catch(() => null),
      ]);

      const classification = classify(
        downloadResult.files,
        originalUrl
      );

      if (classification.files.length === 0) {
        throw new Error(
          "No Threads media files were downloaded."
        );
      }

      const creator =
        downloadResult.creator ||
        "Unknown creator";

      const { cardText, safeToDelete } = buildSuccessfulCard(message, originalUrl, {
        platform: "Threads",
        mediaType: classification.label,
        creator,
        originalUrl,
        originalDate: extractOriginalDate(info),
      });

      await markRetrievedOrCleanup(lifecycle, downloadResult);
      const sentMessageIds = await uploadMedia(
        message,
        classification.files,
        cardText,
        downloadResult.rawDir,
        { embedColor: 0xffffff }
      );

      await deleteOriginalAfterSuccess(message, sentMessageIds, safeToDelete);

      shareStore.insert({
        platform,
        mediaId,
        creator,
        sharedBy:
          message.member?.displayName ??
          message.author.username,
        sharedById: message.author.id,
        messageId: null,
        channelId: message.channel.id,
        guildId: message.guild?.id ?? null,
        url: originalUrl,
      });

      console.log(
        `Threads ${classification.label} ` +
          `(${classification.files.length} file(s)) ` +
          `shared for ${message.author.username}`
      );
    } catch (error) {
      await replyWithHarmonyError(
        message,
        error,
        lifecycle
      );
    }

    return;
  }
}

async function handleMediaMessage(message) {
  if (message.author.bot) return;
  const finders = [findInstagramLinks, findFacebookLinks, findTikTokLinks, findXLinks, findYouTubeLinks, findThreadsLinks];
  if (!finders.some((find) => find(message.content).length)) return;
  return withMediaLifecycle(
    message,
    (lifecycle) => processMediaMessage(message, lifecycle),
    { onTimeout: (error) => logMediaError(message, error) }
  );
}

module.exports = {
  handleMediaMessage,
};
