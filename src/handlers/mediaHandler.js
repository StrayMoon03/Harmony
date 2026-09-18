const { withDelayedProgress, suppressOriginalEmbeds } = require("../modules/media/messageLifecycle");
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
const { formatMediaCard } = require("../modules/media/formatter");
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
const { logMediaError } = require("../services/errorInboxService");

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

  await logMediaError(message, error).catch((reportError) => {
    console.error("Could not send media failure to Harmony’s error inbox:", reportError);
  });

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
async function processMediaMessage(message) {
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
    let stopInstagramTyping = null;

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

      stopInstagramTyping = startTypingIndicator(message);

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
        {
          embedColor: 0xfacc15,
          ensureAppleCompatibleVideo: true,
        }
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
      const isAudioOnlyFailure = /INSTAGRAM_AUDIO_MISSING|did not expose a merged video with audio/i.test(
        String(error?.message || error)
      );

      if (isAudioOnlyFailure) {
        try {
          const creator = resolveCreator(info, []);
          const cardText = formatMediaCard({
            platform: "Instagram",
            mediaType: "Reel",
            creator,
            originalUrl,
            heart: "💛",
          });

          await sendInstagramStreamingPreview(message, {
            originalUrl,
            cardText,
            previewUrl: findInstagramPreviewUrl(info),
          });

          shareStore.insert({
            platform,
            mediaId,
            creator,
            sharedBy: message.member?.displayName ?? message.author.username,
            sharedById: message.author.id,
            messageId: message.id,
            channelId: message.channel.id,
            guildId: message.guild?.id ?? null,
            url: originalUrl,
          });

          console.log(
            `Instagram reel used sound-preserving embed fallback for ${message.author.username}`
          );
          return;
        } catch (fallbackError) {
          console.error(
            "Instagram sound-preserving fallback failed:",
            fallbackError
          );
        }
      }

      await replyWithHarmonyError(
        message,
        error
      );
    } finally {
      stopInstagramTyping?.();
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

      try {
        await message.channel.sendTyping();
      } catch {
        console.warn(
          "Facebook typing indicator unavailable. Continuing with media processing."
        );
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
        await logMediaError(
          message,
          new Error(
            downloadResult.failureReason ||
            "FACEBOOK_UNVERIFIED_MEDIA"
          )
        ).catch((reportError) => {
          console.error("Could not send Facebook failure to Harmony’s error inbox:", reportError);
        });
        await message.reply({
          content:
            "Facebook did not expose media that Harmony could verify belongs to this exact post, so I left the original link above instead of showing the wrong preview.\n\n💜 𝑯𝒂𝒓𝒎𝒐𝒏𝒚",
          allowedMentions: { repliedUser: false },
        });
        return;
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
      // Discord's typing endpoint can fail transiently (including HTTP 500).
      // A cosmetic indicator must never prevent the TikTok itself from being
      // normalized, downloaded, and posted.
      await message.channel.sendTyping().catch((error) => {
        console.warn(
          "Could not start TikTok typing indicator:",
          error instanceof Error ? error.message : error
        );
      });

      const normalizedUrl =
        await normalizeTikTokUrl(originalUrl);

      if (isTikTokLiveUrl(normalizedUrl)) {
        await message.reply({
          content: [
            "This TikTok link points to a live broadcast, so Harmony can’t archive it as a saved post.",
            "You can still watch it through the original TikTok link above.",
            "",
            "💜 𝑯𝒂𝒓𝒎𝒐𝒏𝒚",
          ].join("\n"),
          allowedMentions: {
            repliedUser: false,
          },
        });

        return;
      }

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

      const durationSeconds = Number(info?.duration || 0);
      const isPhotoPost =
        /\/photo\/\d+/i.test(normalizedUrl);

      // TikTok photo-mode posts can expose the soundtrack duration in
      // metadata. That duration does not make the post a long video.
      if (!isPhotoPost && durationSeconds >= 90) {
        const creator =
          info?.uploader ||
          info?.creator ||
          "Unknown creator";
        const cardText = formatMediaCard({
          platform: "TikTok",
          mediaType: "Video",
          creator,
          originalUrl: normalizedUrl,
          heart: "🩷",
        });

        await sendTikTokStreamingPreview(message, {
          originalUrl: normalizedUrl,
          cardText,
          durationMinutes: Math.ceil(durationSeconds / 60),
        });

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
          `TikTok long-video streaming card shared for ${message.author.username}`
        );
        return;
      }

      const downloadResult =
        await downloadTikTokMedia(
          normalizedUrl
        );

      // Photo-mode downloads intentionally have no video audio stream.
      // Keep their downloaded images and send them through the carousel
      // uploader instead of replacing them with a link-only video card.
      if (!isPhotoPost && !downloadResult.hasAudio) {
        const creator =
          downloadResult.creator ||
          info?.uploader ||
          info?.creator ||
          "Unknown creator";
        const cardText = formatMediaCard({
          platform: "TikTok",
          mediaType: "Video",
          creator,
          originalUrl: normalizedUrl,
          heart: "🩷",
        });

        await fs.rm(downloadResult.rawDir, {
          recursive: true,
          force: true,
        }).catch(() => {});

        await sendTikTokStreamingPreview(message, {
          originalUrl: normalizedUrl,
          cardText,
          durationMinutes: Math.max(
            1,
            Math.ceil(Number(info?.duration || 0) / 60)
          ),
        });

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
          `TikTok no-audio streaming fallback shared for ${message.author.username}`
        );
        return;
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
      // The shared helper verifies suppression after delayed preview updates.
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

      if (downloadResult.linkOnly) {
        const sharedBy =
          message.member?.displayName ??
          message.author.username;
        let cardMessage = null;

        if (downloadResult.postText) {
          const description = [
            `**${downloadResult.creator || "Unknown creator"}**`,
            "",
            downloadResult.postText.slice(0, 3600),
            "",
            `[Original Post](${originalUrl})`,
            "",
            `🖤 Shared by ${sharedBy}`,
          ].join("\n");

          cardMessage = await message.channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x000000)
                .setTitle("🖤 X — Text Post")
                .setDescription(description),
            ],
            allowedMentions: { parse: [] },
          });
          shareStore.addOutputMessage(
            message.id,
            cardMessage.id,
            cardMessage.channelId
          );
          await suppressOriginalEmbeds(message);
        }

        shareStore.insert({
          platform,
          mediaId,
          creator: downloadResult.creator || "Unknown creator",
          sharedBy,
          sharedById: message.author.id,
          messageId: message.id,
          channelId: message.channel.id,
          guildId: message.guild?.id ?? null,
          url: originalUrl,
        });
        console.log(
          cardMessage
            ? "X text-only post displayed in Harmony's full-text card."
            : "X text-only post preserved with its native preview."
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

      const cardText = formatMediaCard({
        platform: "X",
        mediaType,
        creator,
        originalUrl,
        heart: "🖤",
      });

      try {
        await uploadMedia(
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

        console.warn(
          "X attachment could not fit; preserving the original playable link."
        );
        const linkMessage = await message.reply({
          content: originalUrl,
          allowedMentions: { repliedUser: false },
        });
        const cardMessage = await message.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x000000)
              .setDescription(
                `${cardText}\n\nThis post plays through X so it can keep its original quality.`
              ),
          ],
          allowedMentions: { parse: [] },
        });
        shareStore.addOutputMessage(message.id, linkMessage.id, linkMessage.channelId);
        shareStore.addOutputMessage(message.id, cardMessage.id, cardMessage.channelId);
      }

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

      console.log(
        `YouTube link accepted: ${mediaId}`
      );

      const downloadResult =
        await downloadYouTubeMedia(originalUrl);

      if (downloadResult.linkOnly) {
        const creator =
          downloadResult.creator ||
          "Unknown creator";
        const durationMinutes = Math.ceil(
          downloadResult.durationSeconds / 60
        );
        const cardText = formatMediaCard({
          platform: "YouTube",
          mediaType: "Video",
          creator,
          originalUrl,
          heart: "❤️",
        });

        await sendYouTubeStreamingPreview(message, {
          originalUrl,
          cardText,
          durationMinutes,
        });
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
          `YouTube long video card shared for ${message.author.username}`
        );
        return;
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

      const cardText = formatMediaCard({
        platform: "YouTube",
        mediaType,
        creator,
        originalUrl,
        heart: "❤️",
      });

      try {
        await uploadMedia(
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

        const durationMinutes = Number.isFinite(
          downloadResult.durationSeconds
        )
          ? Math.ceil(downloadResult.durationSeconds / 60)
          : null;

        await sendYouTubeStreamingPreview(message, {
          originalUrl,
          cardText,
          durationMinutes,
        });
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
          `YouTube streaming fallback shared for ${message.author.username}`
        );
        return;
      }

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

    let stopThreadsTyping = null;

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

      stopThreadsTyping = startTypingIndicator(message);
      console.log(
        `Threads link accepted: ${mediaId}`
      );

      const downloadResult =
        await downloadThreadsMedia(originalUrl, {
          getDiscordEmbedFallback: (resolvedUrl) =>
            getThreadsDiscordEmbedFallback(message, originalUrl, resolvedUrl),
        });

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

      const cardText = formatMediaCard({
        platform: "Threads",
        mediaType: classification.label,
        creator,
        originalUrl,
        heart: "🤍",
      });

      await uploadMedia(
        message,
        classification.files,
        cardText,
        downloadResult.rawDir,
        { embedColor: 0xffffff }
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
        `Threads ${classification.label} ` +
          `(${classification.files.length} file(s)) ` +
          `shared for ${message.author.username}`
      );
    } catch (error) {
      await replyWithHarmonyError(
        message,
        error
      );
    } finally {
      stopThreadsTyping?.();
    }

    return;
  }
}

async function handleMediaMessage(message) {
  if (message.author.bot) return;
  const finders = [findInstagramLinks, findFacebookLinks, findTikTokLinks, findXLinks, findYouTubeLinks, findThreadsLinks];
  if (!finders.some((find) => find(message.content).length)) return;
  return withDelayedProgress(message, () => processMediaMessage(message));
}

module.exports = {
  handleMediaMessage,
};
