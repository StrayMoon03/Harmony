const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { downloadMedia, downloadWithYtDlp, downloadWithGalleryDl, parseInstagramYtDlpOutput } = require("../src/modules/media/downloader");

async function runSilentRetryScenario(retryBehavior) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-instagram-ytdlp-"));
  const calls = [];
  const execute = async (_binary, args) => {
    calls.push(args);
    if (calls.length === 2 && retryBehavior === "fail") throw new Error("simulated merge failure");
    const template = args[args.indexOf("-o") + 1];
    const output = template.replace("%(id)s", "EXACT").replace("%(ext)s", "mp4");
    await fs.writeFile(output, Buffer.alloc(2048));
    return {
      stdout: `HARMONY_FORMATS:${JSON.stringify([{ format_id: calls.length === 1 ? "video-only" : "retry-video", ext: "mp4", height: 720, vcodec: "h264", acodec: "none", url: "SIGNED_URL_MUST_NOT_BE_LOGGED" }])}\nHARMONY_FILE:${output}\n`,
    };
  };

  try {
    const result = await downloadWithYtDlp("https://www.instagram.com/reel/EXACT/", dir, {
      useCookies: false,
      execFileAsync: execute,
      hasAudioStream: async () => false,
    });
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].isVideo, true);
    assert.equal(calls.length, 2);
    for (const args of calls) {
      assert.ok(args.includes("--force-ipv4"));
      assert.equal(args.at(-1), "https://www.instagram.com/reel/EXACT/");
    }
    assert.equal(calls[0][calls[0].indexOf("-f") + 1], "bv+ba/b");
    assert.equal(calls[1][calls[1].indexOf("-f") + 1], "bv+ba/b[acodec!=none]");
    assert.ok(calls.every((args) => args.includes("--merge-output-format")));
    assert.ok(calls.every((args) => args.includes("--keep-video")));
    return { result, dir, calls };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

test("Instagram keeps exact video when the IPv4 video+audio retry fails", async () => {
  const { result, dir } = await runSilentRetryScenario("fail");
  try {
    assert.match(result.files[0].path, /harmony-EXACT\.mp4$/);
    assert.deepEqual((await fs.readdir(dir)).sort(), ["harmony-EXACT.mp4"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Instagram /p/ posts keep the original video when a silent audio retry fails", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-instagram-post-retry-"));
  const original = path.join(dir, "harmony-Dfv8-spDFgX.mp4");
  const calls = [];
  const execute = async (_binary, args) => {
    calls.push(args);
    if (calls.length === 1) {
      await fs.writeFile(original, Buffer.alloc(2048));
      return {
        stdout: `HARMONY_FORMATS:${JSON.stringify([{ format_id: "video-only", ext: "mp4", height: 720, vcodec: "h264", acodec: "none" }])}\nHARMONY_FILE:${original}\n`,
      };
    }
    throw new Error("simulated merge failure");
  };

  try {
    const result = await downloadWithYtDlp("https://www.instagram.com/p/Dfv9B1ajDJk/", dir, {
      useCookies: false,
      execFileAsync: execute,
      hasVideoStream: async () => true,
      hasAudioStream: async () => false,
    });
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, original);
    assert.equal(result.files[0].isVideo, true);
    assert.equal(result.hasAudio, false);
    await fs.stat(original);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((args) => args.includes("--force-ipv4")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Instagram accepts a video-only output from the IPv4 video+audio retry", async () => {
  const { result, dir } = await runSilentRetryScenario("silent");
  try {
    assert.match(result.files[0].path, /harmony-with-audio-EXACT\.mp4$/);
    assert.deepEqual((await fs.readdir(dir)).sort(), ["harmony-with-audio-EXACT.mp4"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Instagram keeps a verified retained video when yt-dlp merge fails", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-instagram-merge-failure-"));
  const calls = [];
  const execute = async (_binary, args) => {
    calls.push(args);
    if (calls.length === 1) {
      const partial = path.join(dir, "harmony-EXACT.fvideo.mp4");
      await fs.writeFile(partial, Buffer.alloc(2048));
      const error = new Error("simulated ffmpeg merge failure");
      error.stdout = `HARMONY_FORMATS:${JSON.stringify([{ format_id: "video", ext: "mp4", height: 720, vcodec: "h264", acodec: "none" }])}`;
      throw error;
    }
    throw new Error("simulated retry failure");
  };

  try {
    const result = await downloadWithYtDlp("https://www.instagram.com/reel/EXACT/", dir, {
      useCookies: false,
      execFileAsync: execute,
      hasVideoStream: async () => true,
      hasAudioStream: async () => false,
    });
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, path.join(dir, "harmony-EXACT.fvideo.mp4"));
    assert.equal(result.hasAudio, false);
    assert.ok(calls.every((args) => args.includes("--force-ipv4") && args.includes("--keep-video")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Instagram rejects yt-dlp output whose filename does not match the requested shortcode", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-instagram-wrong-id-"));
  try {
    await assert.rejects(downloadWithYtDlp("https://www.instagram.com/reel/EXPECTED/", dir, {
      useCookies: false,
      execFileAsync: async () => ({ stdout: "HARMONY_FILE:/tmp/harmony-OTHER.mp4\n" }),
    }), /did not produce any supported media files/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Instagram gallery-dl recovery also accepts a usable video without audio", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-instagram-gallery-"));
  try {
    const result = await downloadWithGalleryDl("https://www.instagram.com/reel/EXACT/", dir, {
      execFileAsync: async (_binary, args) => {
        assert.ok(args.includes("extractor.instagram.videos=true"));
        await fs.writeFile(path.join(dir, "gallery-video.mp4"), Buffer.alloc(2048));
        return { stdout: "" };
      },
      hasAudioStream: async () => false,
    });
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].isVideo, true);
    assert.match(result.files[0].path, /gallery-video\.mp4$/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Instagram uses gallery-dl video when yt-dlp has no usable video", async () => {
  const order = [];
  const result = await downloadMedia("https://www.instagram.com/reel/EXACT/", {
    runInstagramYtDlpAttempts: async () => {
      order.push("yt-dlp");
      return { result: null, failures: [new Error("no usable video")] };
    },
    downloadWithGalleryDl: async () => {
      order.push("gallery-dl");
      return { files: [{ path: "gallery-silent.mp4", isVideo: true }], hasAudio: false };
    },
    downloadInstagramReel: async () => {
      order.push("browser");
      return { files: ["browser-silent.mp4"], hasAudio: false };
    },
  });
  try {
    assert.deepEqual(order, ["yt-dlp", "gallery-dl", "browser"]);
    assert.equal(result.hasAudio, false);
    assert.equal(result.files[0].path, "gallery-silent.mp4");
  } finally {
    await fs.rm(result.rawDir, { recursive: true, force: true });
  }
});

test("yt-dlp format diagnostics expose only safe format fields, never media URLs", () => {
  const parsed = parseInstagramYtDlpOutput(
    'HARMONY_FORMATS:[{"format_id":"v1","ext":"mp4","height":720,"vcodec":"h264","acodec":"none","url":"SIGNED_SECRET"}]\nHARMONY_FILE:/tmp/harmony.mp4\n'
  );
  assert.deepEqual(parsed.paths, ["/tmp/harmony.mp4"]);
  assert.deepEqual(parsed.formats, [{ id: "v1", ext: "mp4", height: 720, video: "h264", audio: "none" }]);
  assert.ok(!JSON.stringify(parsed).includes("SIGNED_SECRET"));
});

test("Instagram proceeds from silent yt-dlp and gallery results to exact browser audio recovery", async () => {
  const order = [];
  const result = await downloadMedia("https://www.instagram.com/reel/EXACT/", {
    runInstagramYtDlpAttempts: async () => {
      order.push("yt-dlp");
      return { result: { files: [{ path: "yt.mp4", isVideo: true }], hasAudio: false }, failures: [] };
    },
    downloadWithGalleryDl: async () => {
      order.push("gallery-dl");
      return { files: [{ path: "gallery.mp4", isVideo: true }], hasAudio: false };
    },
    downloadInstagramReel: async () => {
      order.push("browser");
      return { files: ["browser.mp4"], hasAudio: true };
    },
  });
  try {
    assert.deepEqual(order, ["yt-dlp", "gallery-dl", "browser"]);
    assert.equal(result.hasAudio, true);
    assert.equal(result.files[0].path, "browser.mp4");
  } finally {
    await fs.rm(result.rawDir, { recursive: true, force: true });
  }
});

test("Instagram returns the first verified silent video only after all audio recovery paths fail", async () => {
  const order = [];
  const result = await downloadMedia("https://www.instagram.com/reel/EXACT/", {
    runInstagramYtDlpAttempts: async () => {
      order.push("yt-dlp");
      return { result: { files: [{ path: "yt.mp4", isVideo: true }], hasAudio: false }, failures: [] };
    },
    downloadWithGalleryDl: async () => {
      order.push("gallery-dl");
      return { files: [{ path: "gallery.mp4", isVideo: true }], hasAudio: false };
    },
    downloadInstagramReel: async () => {
      order.push("browser");
      return { files: ["browser.mp4"], hasAudio: false };
    },
  });
  try {
    assert.deepEqual(order, ["yt-dlp", "gallery-dl", "browser"]);
    assert.equal(result.hasAudio, false);
    assert.equal(result.files[0].path, "yt.mp4");
  } finally {
    await fs.rm(result.rawDir, { recursive: true, force: true });
  }
});

test("Instagram reel login/audience walls keep socialAuthFailureKind after later fallbacks fail", async () => {
  const audienceWall = new Error("ERROR: [Instagram] DfdPSrShNtb: This content isn't available to everyone: It can't be seen by certain audiences.");
  await assert.rejects(async () => {
    try {
      await downloadMedia("https://www.instagram.com/reel/DfdPSrShNtb/", {
        runInstagramYtDlpAttempts: async () => ({
          result: null,
          cookieAttempted: true,
          failures: [
            { error: audienceWall, useCookies: true },
            { error: audienceWall, useCookies: false },
          ],
        }),
        downloadWithGalleryDl: async () => {
          throw new Error("[instagram][info] Waiting for 1 minutes until 05:15:11 (429 Too Many Requests)");
        },
        downloadInstagramReel: async () => {
          throw new Error("Instagram browser could not verify the requested reel");
        },
      });
    } catch (error) {
      assert.equal(error.socialAuthFailureKind, "session");
      assert.equal(error.socialAuthFailureCategory, "login_required");
      assert.match(error.message, /isn't available to everyone/);
      assert.match(error.message, /429 Too Many Requests/);
      assert.match(error.message, /could not verify the requested reel/);
      throw error;
    }
  }, /exhausted its safe download methods/);
});

test("Instagram reel rate limits alone do not become cookie auth failures", async () => {
  await assert.rejects(async () => {
    try {
      await downloadMedia("https://www.instagram.com/reel/DfdPSrShNtb/", {
        runInstagramYtDlpAttempts: async () => ({
          result: null,
          cookieAttempted: true,
          failures: [
            { error: new Error("[instagram][info] Waiting for 1 minutes until 05:15:11 (429 Too Many Requests)"), useCookies: true },
          ],
        }),
        downloadWithGalleryDl: async () => {
          throw new Error("[instagram][info] Waiting for 1 minutes until 05:15:11 (429 Too Many Requests)");
        },
        downloadInstagramReel: async () => {
          throw new Error("Instagram browser could not verify the requested reel");
        },
      });
    } catch (error) {
      assert.equal(error.socialAuthFailureKind, undefined);
      throw error;
    }
  }, /exhausted its safe download methods/);
});
