const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { EmbedBuilder } = require("discord.js");

const execFileAsync = promisify(execFile);

/**
 * Default bot upload ceiling (bytes).
 * Discord bot REST uploads are often capped well below user nitro limits.
 * Override with DISCORD_MAX_UPLOAD_BYTES in the environment.
 */
const DEFAULT_MAX_UPLOAD_BYTES = 9 * 1024 * 1024;

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);

/**
 * Size tiers: width + relative video bitrate scale.
 * Outer loop tries these in order until the output fits maxBytes.
 */
const SIZE_ATTEMPTS = [
  { maxWidth: 1280, bitrateScale: 1.0 },
  { maxWidth: 960, bitrateScale: 0.7 },
  { maxWidth: 720, bitrateScale: 0.45 },
];

/**
 * @param {string} filePath
 * @returns {Promise<void>}
 */
async function safeUnlink(filePath) {
  if (!filePath) return;
  await fs.unlink(filePath).catch(() => {});
}

/**
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function runFfmpeg(args) {
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  await execFileAsync(ffmpegPath, args, {
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
}

/**
 * Probe duration in seconds (fallback 30s if unknown).
 * @param {string} filePath
 * @returns {Promise<number>}
 */
async function probeDurationSeconds(filePath) {
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    const n = Number.parseFloat(String(stdout).trim());
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // fall through
  }
  return 30;
}

/**
 * True if the file has at least one audio stream.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function hasAudioStream(filePath) {
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        filePath,
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    return String(stdout).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Single FFmpeg compression attempt (video + optional audio).
 * Input flags are placed before -i.
 * Stage 1 uses this with mode "with-audio" — behavior unchanged
 * (no -max_error_rate override).
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {number} videoBitrateKbps
 * @param {number} audioBitrateKbps
 * @param {number} maxWidth
 * @param {"with-audio"|"video-only"} mode
 */
async function runCompressionAttempt(
  inputPath,
  outputPath,
  videoBitrateKbps,
  audioBitrateKbps,
  maxWidth,
  mode = "with-audio"
) {
  await safeUnlink(outputPath);

  const vf = `scale='min(${maxWidth},iw)':-2`;
  const vBitrate = `${videoBitrateKbps}k`;
  const aBitrate = `${audioBitrateKbps}k`;

  /** @type {string[]} */
  const args = [
    "-y",
    "-loglevel",
    "error",
    "-fflags",
    "+genpts+igndts+discardcorrupt",
    "-err_detect",
    "ignore_err",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-b:v",
    vBitrate,
    "-maxrate",
    vBitrate,
    "-bufsize",
    `${videoBitrateKbps * 2}k`,
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
  ];

  if (mode === "with-audio") {
    args.push(
      "-map",
      "0:a:0?",
      "-af",
      "aresample=async=1:first_pts=0",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      "aac",
      "-b:a",
      aBitrate
    );
  } else {
    args.push("-an");
  }

  args.push(outputPath);
  await runFfmpeg(args);
}

/**
 * Recover audio by decoding to PCM WAV with a high error-rate tolerance,
 * then mux with re-encoded video and clean AAC.
 *
 * -max_error_rate 1.0 is applied ONLY here (not on stage 1).
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {number} videoBitrateKbps
 * @param {number} audioBitrateKbps
 * @param {number} maxWidth
 */
async function runCompressionViaPcmAudio(
  inputPath,
  outputPath,
  videoBitrateKbps,
  audioBitrateKbps,
  maxWidth
) {
  await safeUnlink(outputPath);

  const wavPath = `${outputPath}.recover.wav`;
  const vf = `scale='min(${maxWidth},iw)':-2`;
  const vBitrate = `${videoBitrateKbps}k`;
  const aBitrate = `${audioBitrateKbps}k`;

  try {
    await safeUnlink(wavPath);

    // Extract whatever PCM samples FFmpeg can salvage from malformed AAC.
    await runFfmpeg([
      "-y",
      "-loglevel",
      "error",
      "-fflags",
      "+genpts+igndts+discardcorrupt",
      "-err_detect",
      "ignore_err",
      "-max_error_rate",
      "1.0",
      "-i",
      inputPath,
      "-vn",
      "-af",
      "aresample=async=1:first_pts=0",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-f",
      "wav",
      wavPath,
    ]);

    // Re-encode video; audio comes from the clean WAV → clean AAC.
    await runFfmpeg([
      "-y",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-i",
      wavPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-b:v",
      vBitrate,
      "-maxrate",
      vBitrate,
      "-bufsize",
      `${videoBitrateKbps * 2}k`,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      aBitrate,
      "-ar",
      "44100",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      "-shortest",
      outputPath,
    ]);
  } finally {
    await safeUnlink(wavPath);
  }
}

/**
 * Recovery ladder for one size tier:
 * 1) normal video+audio (truthful: only if source and output have audio)
 * 2) PCM audio recovery (-max_error_rate 1.0)
 * 3) video-only
 *
 * Modes:
 * - with-audio          source AND output contain audio
 * - video-only-source   source had no audio track
 * - pcm-recovered-audio malformed audio recovered via PCM
 * - video-only          source had audio but recovery failed
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {number} videoBitrateKbps
 * @param {number} audioBitrateKbps
 * @param {number} maxWidth
 * @returns {Promise<{ path: string, mode: string }>}
 */
async function compressForDiscord(
  inputPath,
  outputPath,
  videoBitrateKbps,
  audioBitrateKbps,
  maxWidth
) {
  const sourceHasAudio = await hasAudioStream(inputPath);

  // Source genuinely has no audio track — do not claim with-audio.
  if (!sourceHasAudio) {
    try {
      await runCompressionAttempt(
        inputPath,
        outputPath,
        videoBitrateKbps,
        audioBitrateKbps,
        maxWidth,
        "video-only"
      );
      console.log(
        `Compression mode: video-only-source (${maxWidth}p, ~${videoBitrateKbps}k) — download had no audio track`
      );
      return { path: outputPath, mode: "video-only-source" };
    } catch (err) {
      console.warn(
        "Compression (video-only-source) failed:",
        err.message || err
      );
      await safeUnlink(outputPath);
      throw err;
    }
  }

  // Stage 1 — normal tolerant encode (no -max_error_rate)
  try {
    await runCompressionAttempt(
      inputPath,
      outputPath,
      videoBitrateKbps,
      audioBitrateKbps,
      maxWidth,
      "with-audio"
    );
    const outHasAudio = await hasAudioStream(outputPath);
    if (outHasAudio) {
      console.log(
        `Compression mode: with-audio (${maxWidth}p, ~${videoBitrateKbps}k)`
      );
      return { path: outputPath, mode: "with-audio" };
    }
    console.warn(
      "Stage 1 finished but output has no audio stream — trying PCM recovery"
    );
    await safeUnlink(outputPath);
  } catch (err) {
    console.warn(
      "Compression attempt 1 (with-audio) failed:",
      err.message || err
    );
    await safeUnlink(outputPath);
  }

  // Stage 2 — PCM recovery (max_error_rate 1.0)
  try {
    await runCompressionViaPcmAudio(
      inputPath,
      outputPath,
      videoBitrateKbps,
      audioBitrateKbps,
      maxWidth
    );
    const outHasAudio = await hasAudioStream(outputPath);
    if (outHasAudio) {
      console.log(
        `Compression mode: pcm-recovered-audio (${maxWidth}p, ~${videoBitrateKbps}k)`
      );
      return { path: outputPath, mode: "pcm-recovered-audio" };
    }
    console.warn("PCM recovery produced no audio stream — falling back");
    await safeUnlink(outputPath);
  } catch (err) {
    console.warn(
      "Compression attempt 2 (pcm audio) failed:",
      err.message || err
    );
    await safeUnlink(outputPath);
  }

  // Stage 3 — silent video (decode/recovery failed despite source audio)
  await runCompressionAttempt(
    inputPath,
    outputPath,
    videoBitrateKbps,
    audioBitrateKbps,
    maxWidth,
    "video-only"
  );
  console.warn(
    `Compression mode: video-only (${maxWidth}p, ~${videoBitrateKbps}k) — no usable audio`
  );
  return { path: outputPath, mode: "video-only" };
}

/**
 * If file is over the bot upload ceiling and is video, compress through size tiers.
 * Each tier runs the full recovery ladder, then size is checked again.
 * Normal-sized files are returned unchanged.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<string>} path to upload
 */
async function ensureUnderSizeLimit(filePath, maxBytes) {
  const stat = await fs.stat(filePath);
  const sizeMb = stat.size / (1024 * 1024);
  const limitMb = maxBytes / (1024 * 1024);
  const underLimit = stat.size <= maxBytes;

  console.log(
    `Upload size check: file=${path.basename(filePath)} ` +
      `size=${sizeMb.toFixed(3)} MB (${stat.size} bytes) ` +
      `limit=${limitMb.toFixed(3)} MB (${maxBytes} bytes) ` +
      `underLimit=${underLimit}`
  );

  if (underLimit) {
    return filePath;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!VIDEO_EXT.has(ext)) {
    console.warn(
      `File exceeds Discord limit and is not a video; uploading as-is may fail (${sizeMb.toFixed(
        1
      )} MB)`
    );
    return filePath;
  }

  const duration = await probeDurationSeconds(filePath);
  const targetBits = maxBytes * 8 * 0.9;
  const audioBitrateKbps = 96;

  let baseVideoBitrateKbps = Math.floor(
    targetBits / duration / 1000 - audioBitrateKbps
  );
  baseVideoBitrateKbps = Math.max(250, Math.min(baseVideoBitrateKbps, 4000));

  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath, ext);

  console.log(
    `Compressing oversized video (${sizeMb.toFixed(
      1
    )} MB, ~${duration.toFixed(1)}s) through size tiers…`
  );

  for (const tier of SIZE_ATTEMPTS) {
    const videoBitrateKbps = Math.max(
      200,
      Math.floor(baseVideoBitrateKbps * tier.bitrateScale)
    );
    const outputPath = path.join(
      dir,
      `${baseName}-discord-w${tier.maxWidth}-br${videoBitrateKbps}.mp4`
    );

    await safeUnlink(outputPath);

    try {
      const result = await compressForDiscord(
        filePath,
        outputPath,
        videoBitrateKbps,
        audioBitrateKbps,
        tier.maxWidth
      );

      const outStat = await fs.stat(result.path);
      const outMb = outStat.size / (1024 * 1024);

      console.log(
        `Upload size check (compressed): file=${path.basename(
          result.path
        )} ` +
          `size=${outMb.toFixed(3)} MB (${outStat.size} bytes) ` +
          `limit=${limitMb.toFixed(3)} MB (${maxBytes} bytes) ` +
          `underLimit=${outStat.size <= maxBytes} ` +
          `mode=${result.mode}`
      );

      if (outStat.size <= maxBytes) {
        console.log(
          `Size OK after ${result.mode}: ${outMb.toFixed(
            1
          )} MB (limit ${limitMb.toFixed(1)} MB)`
        );
        await safeUnlink(filePath);
        return result.path;
      }

      console.warn(
        `Still too large after ${result.mode} @ ${tier.maxWidth}p: ${outMb.toFixed(
          1
        )} MB — trying next tier`
      );
      await safeUnlink(result.path);
    } catch (err) {
      console.warn(
        `Size tier ${tier.maxWidth}p failed:`,
        err.message || err
      );
      await safeUnlink(outputPath);
    }
  }

  throw new Error(
    `Could not compress video under Discord limit (${limitMb.toFixed(
      0
    )} MB) after all size tiers`
  );
}

/** Default Harmony accent (blue left bar on the media card embed). */
const DEFAULT_EMBED_COLOR = 0x3b82f6;

/** Discord allows at most 10 attachments per message. */
const DISCORD_MAX_ATTACHMENTS = 10;

/**
 * Uploads one or more media files to Discord.
 * Oversized videos are compressed first (AAC-tolerant recovery ladder).
 * Temp files and job directories are cleaned up afterward.
 *
 * Card text is placed in a colored embed so Discord shows one integrated
 * left accent bar (not a detached empty embed under plain content).
 *
 * When more than 10 files are present, Harmony sends the card + first 10
 * in the initial reply, then follow-up messages with the remaining files
 * in batches of 10 (Discord attachment limit).
 *
 * @param {import("discord.js").Message} message
 * @param {Array<{ path: string }>} files
 * @param {string} cardText
 * @param {string|number} [rawDirOrColor]
 * @param {{ embedColor?: number }} [options]
 */
async function uploadMedia(
  message,
  files,
  cardText,
  rawDirOrColor,
  options = {}
) {
  const maxBytes = Number(
    process.env.DISCORD_MAX_UPLOAD_BYTES || DEFAULT_MAX_UPLOAD_BYTES
  );

  // Support both legacy call shapes:
  //   uploadMedia(msg, files, text, rawDir)
  //   uploadMedia(msg, files, text, 0xCOLOR)
  //   uploadMedia(msg, files, text, rawDir, { embedColor })
  let rawDir = undefined;
  let embedColor = options.embedColor;

  if (typeof rawDirOrColor === "number") {
    embedColor = rawDirOrColor;
  } else if (typeof rawDirOrColor === "string") {
    rawDir = rawDirOrColor;
  }

  if (
    embedColor === undefined ||
    embedColor === null ||
    !Number.isFinite(embedColor)
  ) {
    embedColor = DEFAULT_EMBED_COLOR;
  }

  /** @type {string[]} */
  const paths = [];

  try {
    for (const file of files) {
      const ready = await ensureUnderSizeLimit(file.path, maxBytes);
      paths.push(ready);
    }

    if (paths.length === 0) {
      throw new Error("No media files available to upload.");
    }

    // Batch into groups of 10 (Discord hard limit per message).
    /** @type {string[][]} */
    const batches = [];
    for (let i = 0; i < paths.length; i += DISCORD_MAX_ATTACHMENTS) {
      batches.push(paths.slice(i, i + DISCORD_MAX_ATTACHMENTS));
    }

    console.log(
      `Upload: ${paths.length} file(s) in ${batches.length} message(s)`
    );

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const isFirst = i === 0;

      /** @type {import("discord.js").MessageReplyOptions} */
      const payload = {
        files: batch,
        allowedMentions: { repliedUser: false },
      };

      if (isFirst) {
        payload.embeds = [
          new EmbedBuilder()
            .setColor(embedColor)
            .setDescription(cardText || "\u200b"),
        ];
      }

      if (isFirst) {
        await message.reply(payload);
      } else {
        // Follow-up messages for remaining carousel images.
        await message.channel.send(payload);
      }
    }
  } finally {
    await Promise.all(paths.map((p) => safeUnlink(p)));

    if (rawDir) {
      await fs.rm(rawDir, { recursive: true, force: true }).catch(() => {});
    } else {
      await Promise.all(files.map((f) => safeUnlink(f.path)));
    }
  }
}

module.exports = {
  uploadMedia,
  compressForDiscord,
  runCompressionAttempt,
  runCompressionViaPcmAudio,
  ensureUnderSizeLimit,
  safeUnlink,
  hasAudioStream,
  SIZE_ATTEMPTS,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_EMBED_COLOR,
  DISCORD_MAX_ATTACHMENTS,
};
