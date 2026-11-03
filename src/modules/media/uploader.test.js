const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { sendUploadBatch, uploadMedia } = require("./uploader");

function makeVideo(filePath, { compatible = false } = {}) {
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=44100",
    "-t", "0.7",
  ];
  if (compatible) {
    args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-crf", "30", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart");
  } else {
    args.push("-c:v", "mpeg4", "-q:v", "4", "-c:a", "libmp3lame");
  }
  args.push("-shortest", filePath);
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", args, { stdio: "ignore" });
}

function probe(filePath) {
  const output = execFileSync(process.env.FFPROBE_PATH || "ffprobe", [
    "-v", "error", "-show_entries", "format=format_name:stream=codec_type,codec_name,pix_fmt,width,height",
    "-of", "json", filePath,
  ], { encoding: "utf8" });
  return JSON.parse(output);
}

async function uploadAndCapture(filePath, options) {
  let uploaded;
  let uploadedMedia;
  let uploadedSize;
  const message = {
    channel: {
      send: async (payload) => {
        if (payload.files) {
          uploaded = payload.files[0];
          const uploadedPath = typeof uploaded === "string" ? uploaded : uploaded.attachment;
          uploadedMedia = probe(uploadedPath);
          uploadedSize = (await fs.stat(uploadedPath)).size;
        }
        return { id: `sent-${Math.random()}` };
      },
    },
  };
  const card = { header: "TikTok", footer: "Shared by member", buttonLabel: "View on TikTok", buttonUrl: "https://www.tiktok.com/@creator/video/123" };
  await uploadMedia(message, [{ path: filePath, isVideo: true }], card, undefined, options);
  return { attachment: uploaded, media: uploadedMedia, size: uploadedSize };
}

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

test("first upload batch is a standalone channel send", async () => {
  const payload = { files: ["video.mp4"] };
  let channelPayload;
  const message = {
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

test("follow-up batches continue to use ordinary channel sends", async () => {
  let replies = 0;
  const message = {
    channel: { send: async () => ({ id: "follow-up" }) },
  };

  const result = await sendUploadBatch(message, {}, false);
  assert.equal(result.id, "follow-up");
  assert.equal(replies, 0);
});

test("successful structured post sends header, media, then footer/comment", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-layout-"));
  const mediaPath = path.join(tempDir, "photo.jpg");
  await fs.writeFile(mediaPath, "test image bytes");
  const sent = [];
  const message = {
    channel: {
      send: async (payload) => {
        sent.push(payload);
        return { id: `sent-${sent.length}` };
      },
    },
  };
  const card = {
    header: "TikTok",
    footer: "Shared by <@123> • Sep 23, 2026\n<@123>: OMG HIS HAIR 😂",
    buttonLabel: "View on TikTok",
    buttonUrl: "https://example.com",
  };

  const ids = await uploadMedia(message, [{ path: mediaPath }], card);

  assert.deepEqual(ids, ["sent-1", "sent-2", "sent-3"]);
  assert.equal(sent[0].content, card.header);
  assert.equal(sent[0].embeds, undefined);
  assert.deepEqual(sent[1].files, [mediaPath]);
  assert.equal(sent[2].embeds[0].data.description, card.footer);
  assert.equal(sent[2].components[0].components[0].data.label, card.buttonLabel);
  assert.equal(sent[2].components[0].components[0].data.url, card.buttonUrl);
  assert.equal(sent[2].components[0].components[0].data.style, 5);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.deepEqual(sent[2].allowedMentions, { parse: [] });
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("incompatible TikTok video is normalized to playable H.264/AAC MP4 with a Harmony filename", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-tiktok-compat-"));
  const sourcePath = path.join(tempDir, "7703464447402102023 Minho is now purple hair!!.mov");
  makeVideo(sourcePath);
  const attachment = await uploadAndCapture(sourcePath, {
    ensureAppleCompatibleVideo: true,
    safeVideoFileNamePrefix: "harmony-tiktok-video",
  });

  assert.deepEqual(attachment.attachment, {
    attachment: path.join(tempDir, "7703464447402102023 Minho is now purple hair!!-iphone-compatible.mp4"),
    name: "harmony-tiktok-video-1.mp4",
  });
  const media = attachment.media;
  const video = media.streams.find((stream) => stream.codec_type === "video");
  const audio = media.streams.find((stream) => stream.codec_type === "audio");
  assert.match(media.format.format_name, /mp4|mov/);
  assert.equal(video.codec_name, "h264");
  assert.equal(video.pix_fmt, "yuv420p");
  assert.equal(audio.codec_name, "aac");
  assert.ok(Math.abs(video.width / video.height - 16 / 9) < 0.02);
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("compatible MP4 bypasses conversion and receives a Harmony-generated MP4 filename", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-tiktok-compatible-"));
  const sourcePath = path.join(tempDir, "raw-platform-name.mp4");
  makeVideo(sourcePath, { compatible: true });
  const attachment = await uploadAndCapture(sourcePath, {
    ensureAppleCompatibleVideo: true,
    safeVideoFileNamePrefix: "harmony-tiktok-video",
  });

  assert.deepEqual(attachment.attachment, {
    attachment: sourcePath,
    name: "harmony-tiktok-video-1.mp4",
  });
  const media = attachment.media;
  assert.equal(media.streams.find((stream) => stream.codec_type === "video").codec_name, "h264");
  assert.equal(media.streams.find((stream) => stream.codec_type === "audio").codec_name, "aac");
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("upload-size handling still leaves an under-limit video untouched", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-upload-size-"));
  const sourcePath = path.join(tempDir, "small.mp4");
  await fs.writeFile(sourcePath, Buffer.alloc(1024));
  const { ensureUnderSizeLimit } = require("./uploader");
  assert.equal(await ensureUnderSizeLimit(sourcePath, 1024 * 1024), sourcePath);
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("oversized TikTok video still goes through Discord size compression before upload", async () => {
  const previousLimit = process.env.DISCORD_MAX_UPLOAD_BYTES;
  const maxBytes = 42_000;
  process.env.DISCORD_MAX_UPLOAD_BYTES = String(maxBytes);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-tiktok-size-limit-"));
  const sourcePath = path.join(tempDir, "large-source.mov");
  makeVideo(sourcePath);

  try {
    assert.ok((await fs.stat(sourcePath)).size > maxBytes);
    const uploaded = await uploadAndCapture(sourcePath, {
      ensureAppleCompatibleVideo: true,
      safeVideoFileNamePrefix: "harmony-tiktok-video",
    });
    assert.ok(uploaded.size <= maxBytes, `uploaded size ${uploaded.size} exceeds ${maxBytes}`);
    assert.equal(uploaded.attachment.name, "harmony-tiktok-video-1.mp4");
    assert.equal(uploaded.media.streams.find((stream) => stream.codec_type === "video").codec_name, "h264");
    assert.equal(uploaded.media.streams.find((stream) => stream.codec_type === "audio").codec_name, "aac");
  } finally {
    if (previousLimit === undefined) delete process.env.DISCORD_MAX_UPLOAD_BYTES;
    else process.env.DISCORD_MAX_UPLOAD_BYTES = previousLimit;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
