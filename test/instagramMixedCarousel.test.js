const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { downloadMedia, downloadWithGalleryDl } = require("../src/modules/media/downloader");

const MIXED_POST = "https://www.instagram.com/p/DgILKnfktRw/?img_index=4";

test("gallery-dl keeps mixed Instagram photo and video files in order", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-instagram-gallery-mixed-"));
  try {
    const result = await downloadWithGalleryDl(MIXED_POST, dir, {
      execFileAsync: async (_binary, args) => {
        assert.ok(args.includes("extractor.instagram.videos=true"));
        assert.equal(args.at(-1), MIXED_POST);
        await fs.writeFile(path.join(dir, "01.jpg"), Buffer.alloc(2048));
        await fs.writeFile(path.join(dir, "02.mp4"), Buffer.alloc(2048));
        await fs.writeFile(path.join(dir, "03.jpg"), Buffer.alloc(2048));
        return { stdout: "" };
      },
      hasAudioStream: async () => true,
    });
    assert.deepEqual(result.files.map((file) => path.basename(file.path)), ["01.jpg", "02.mp4", "03.jpg"]);
    assert.deepEqual(result.files.map((file) => [file.isImage, file.isVideo]), [[true, false], [false, true], [true, false]]);
    assert.equal(result.hasAudio, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Instagram /p/ posts return mixed gallery-dl media without using the browser fallback", async () => {
  const order = [];
  const files = [
    { path: "01.jpg", isImage: true, isVideo: false },
    { path: "02.mp4", isImage: false, isVideo: true },
    { path: "03.jpg", isImage: true, isVideo: false },
  ];
  const result = await downloadMedia(MIXED_POST, {
    runInstagramYtDlpAttempts: async () => {
      order.push("yt-dlp");
      return { result: null, failures: [{ error: new Error("empty media response / 401"), useCookies: false }] };
    },
    downloadWithGalleryDl: async () => {
      order.push("gallery-dl");
      return { files, hasAudio: true, platform: "instagram" };
    },
    downloadInstagramPhotos: async () => {
      order.push("browser");
      throw new Error("browser fallback should not run when gallery-dl returns mixed media");
    },
  });
  try {
    assert.deepEqual(order, ["yt-dlp", "gallery-dl"]);
    assert.deepEqual(result.files, files);
    assert.equal(result.hasAudio, true);
  } finally {
    await fs.rm(result.rawDir, { recursive: true, force: true });
  }
});

test("Instagram /p/ posts accept mixed browser fallback media after gallery-dl fails", async () => {
  const order = [];
  const result = await downloadMedia(MIXED_POST, {
    runInstagramYtDlpAttempts: async () => {
      order.push("yt-dlp");
      return { result: null, failures: [{ error: new Error("empty media response / 401"), useCookies: false }] };
    },
    downloadWithGalleryDl: async () => {
      order.push("gallery-dl");
      throw new Error("401 Unauthorized");
    },
    downloadInstagramPhotos: async () => {
      order.push("browser");
      return {
        files: [
          "/tmp/instagram-media-000.jpg",
          "/tmp/instagram-media-001.mp4",
          "/tmp/instagram-media-002.jpg",
        ],
        creator: "example",
      };
    },
  });
  try {
    assert.deepEqual(order, ["yt-dlp", "gallery-dl", "browser"]);
    assert.equal(result.creator, "example");
    assert.deepEqual(result.files.map((file) => [path.basename(file.path), file.isImage, file.isVideo]), [
      ["instagram-media-000.jpg", true, false],
      ["instagram-media-001.mp4", false, true],
      ["instagram-media-002.jpg", true, false],
    ]);
  } finally {
    await fs.rm(result.rawDir, { recursive: true, force: true });
  }
});
