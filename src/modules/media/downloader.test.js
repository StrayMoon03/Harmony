const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  downloadInstagramWithFallbacks,
  isInstagramAuthenticationRequired,
  runInstagramYtDlp,
  downloadWithGalleryDl,
} = require("./downloader");

async function withJobDir(run) {
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-instagram-auth-test-"));
  try { await run(jobDir); }
  finally { await fs.rm(jobDir, { recursive: true, force: true }); }
}

function failed(message) { return Promise.reject(message instanceof Error ? message : new Error(message)); }

test("Instagram retrieval starts anonymously and stops on anonymous yt-dlp success", async () => {
  await withJobDir(async (jobDir) => {
    const calls = [];
    const result = await downloadInstagramWithFallbacks("https://www.instagram.com/p/EXACT/", jobDir, {
      downloadWithYtDlp: async (_url, _dir, options) => { calls.push(["yt-dlp", options.useCookies]); return { source: "anonymous" }; },
      cookiesAvailable: async () => { calls.push(["cookies-check"]); return true; },
    });
    assert.deepEqual(result, { source: "anonymous" });
    assert.deepEqual(calls, [["yt-dlp", false]]);
  });
});

test("successful anonymous gallery-dl retrieval never inspects Miss Harmony cookies", async () => {
  await withJobDir(async (jobDir) => {
    const calls = [];
    const result = await downloadInstagramWithFallbacks("https://www.instagram.com/p/EXACT/", jobDir, {
      downloadWithYtDlp: async (_url, _dir, options) => { calls.push(["yt-dlp", options.useCookies]); return failed("generic extraction failure"); },
      downloadWithGalleryDl: async (_url, _dir, options) => { calls.push(["gallery-dl", options.useCookies]); return { files: ["anonymous-image"] }; },
      cookiesAvailable: async () => { calls.push(["cookie-check"]); return true; },
    });
    assert.deepEqual(result, { files: ["anonymous-image"] });
    assert.deepEqual(calls, [["yt-dlp", false], ["gallery-dl", false]]);
  });
});

test("successful anonymous browser fallback stops before cookie availability is checked", async () => {
  await withJobDir(async (jobDir) => {
    const calls = [];
    const result = await downloadInstagramWithFallbacks("https://www.instagram.com/reel/EXACT/", jobDir, {
      downloadWithYtDlp: async (_url, _dir, options) => { calls.push(["yt-dlp", options.useCookies]); return failed("generic extraction failure"); },
      downloadWithGalleryDl: async (_url, _dir, options) => { calls.push(["gallery-dl", options.useCookies]); return failed("unsupported media"); },
      downloadInstagramReel: async (_url, _dir, options) => { calls.push(["browser", options.useCookies]); return { files: ["reel.mp4"], creator: "straykids" }; },
      cookiesAvailable: async () => { calls.push(["cookies-check"]); return true; },
    });
    assert.equal(result.creator, "straykids");
    assert.deepEqual(calls, [["yt-dlp", false], ["gallery-dl", false], ["browser", false]]);
  });
});

test("only a specific authentication-required failure enables one matching authenticated retry", async () => {
  await withJobDir(async (jobDir) => {
    const calls = [];
    const result = await downloadInstagramWithFallbacks("https://www.instagram.com/p/EXACT/", jobDir, {
      downloadWithYtDlp: async (_url, _dir, options) => {
        calls.push(["yt-dlp", options.useCookies]);
        return options.useCookies ? { source: "authenticated retry" } : failed("Sign in required to view this post");
      },
      downloadWithGalleryDl: async (_url, _dir, options) => { calls.push(["gallery-dl", options.useCookies]); return failed("generic extraction failure"); },
      downloadInstagramPhotos: async () => failed("Instagram browser could not verify a complete photo post"),
      cookiesAvailable: async () => { calls.push(["cookies-check"]); return true; },
    });
    assert.deepEqual(result, { source: "authenticated retry" });
    assert.deepEqual(calls, [["yt-dlp", false], ["gallery-dl", false], ["cookies-check"], ["yt-dlp", true]]);
  });
});

test("gallery, reel-browser, and photo-login signals retry only their designated authenticated method", async () => {
  const authRequired = () => Object.assign(new Error("Instagram login page"), { code: "INSTAGRAM_AUTH_REQUIRED" });
  const cases = [
    {
      url: "https://www.instagram.com/p/EXACT/",
      authMethod: "gallery-dl",
      retryMethod: "gallery-dl",
      fake: "downloadWithGalleryDl",
      expected: ["yt-dlp:false", "gallery-dl:false", "photo-browser:false", "gallery-dl:true"],
    },
    {
      url: "https://www.instagram.com/reel/EXACT/",
      authMethod: "browser",
      retryMethod: "browser",
      fake: "downloadInstagramReel",
      expected: ["yt-dlp:false", "gallery-dl:false", "reel-browser:false", "reel-browser:true"],
    },
    {
      url: "https://www.instagram.com/p/EXACT/",
      authMethod: "browser",
      retryMethod: "browser",
      fake: "downloadInstagramPhotos",
      expected: ["yt-dlp:false", "gallery-dl:false", "photo-browser:false", "photo-browser:true"],
    },
  ];

  for (const scenario of cases) {
    await withJobDir(async (jobDir) => {
      const calls = [];
      const deps = {
        downloadWithYtDlp: async (_url, _dir, options) => {
          calls.push(`yt-dlp:${options.useCookies}`);
          if (scenario.retryMethod === "yt-dlp" && options.useCookies) return { success: true };
          return failed(scenario.authMethod === "yt-dlp" ? "Login required" : "generic extraction error");
        },
        downloadWithGalleryDl: async (_url, _dir, options) => {
          calls.push(`gallery-dl:${options.useCookies}`);
          if (scenario.retryMethod === "gallery-dl" && options.useCookies) return { success: true };
          return failed(scenario.authMethod === "gallery-dl" ? "Authentication required" : "generic download error");
        },
        downloadInstagramReel: async (_url, _dir, options) => {
          calls.push(`reel-browser:${options.useCookies}`);
          if (scenario.authMethod === "browser" && scenario.fake === "downloadInstagramReel" && options.useCookies) return { files: ["reel.mp4"] };
          return failed(scenario.authMethod === "browser" && scenario.fake === "downloadInstagramReel" ? authRequired() : "generic reel error");
        },
        downloadInstagramPhotos: async (_url, _dir, options) => {
          calls.push(`photo-browser:${options?.useCookies === true}`);
          if (scenario.authMethod === "browser" && scenario.fake === "downloadInstagramPhotos") {
            return options?.useCookies ? { files: ["photo.jpg"] } : failed(authRequired());
          }
          return failed("generic photo error");
        },
        cookiesAvailable: async () => true,
      };
      const result = await downloadInstagramWithFallbacks(scenario.url, jobDir, deps);
      assert.ok(result.success || result.files?.length);
      assert.deepEqual(calls, scenario.expected);
    });
  }
});

test("explicit login failure without a cookie file does not attempt authenticated retrieval", async () => {
  await withJobDir(async (jobDir) => {
    const calls = [];
    await assert.rejects(downloadInstagramWithFallbacks("https://www.instagram.com/p/EXACT/", jobDir, {
      downloadWithYtDlp: async (_url, _dir, options) => { calls.push(options.useCookies); return failed("Login required"); },
      downloadWithGalleryDl: async (_url, _dir, options) => { calls.push(options.useCookies); return failed("generic extraction"); },
      downloadInstagramPhotos: async () => failed("generic browser extraction"),
      cookiesAvailable: async () => false,
    }), error => error.code === "INSTAGRAM_AUTH_REQUIRED");
    assert.deepEqual(calls, [false, false]);
  });
});

test("rate limits, removed posts, network, unsupported and generic extraction failures never use cookies", async () => {
  const messages = [
    "HTTP Error 429: Too Many Requests; login required",
    "This post is unavailable or has been deleted",
    "ECONNRESET network error",
    "Unsupported URL: instagram post format",
    "Unable to extract media: generic failure",
    "Please log in to confirm you are not a bot",
    "Instagram checkpoint challenge required",
  ];
  for (const message of messages) assert.equal(isInstagramAuthenticationRequired(new Error(message)), false, message);

  for (const message of ["Login required", "Sign in required to view this post", "HTTP Error 401: authentication required", "This content is only available to logged-in users"]) {
    assert.equal(isInstagramAuthenticationRequired(new Error(message)), true, message);
  }
  assert.equal(isInstagramAuthenticationRequired(new Error("This content is only available to followers")), false);

  for (const message of messages) {
    await withJobDir(async (jobDir) => {
      const calls = [];
      await assert.rejects(downloadInstagramWithFallbacks("https://www.instagram.com/p/EXACT/", jobDir, {
        downloadWithYtDlp: async (_url, _dir, options) => { calls.push(["yt-dlp", options.useCookies]); return failed(message); },
        downloadWithGalleryDl: async (_url, _dir, options) => { calls.push(["gallery-dl", options.useCookies]); return failed("generic download error"); },
        downloadInstagramPhotos: async () => failed("generic browser extraction failure"),
        cookiesAvailable: async () => { calls.push(["cookies-check"]); return true; },
      }));
      const shouldStop = /429|too many requests|rate.?limit|checkpoint|challenge|not a bot/i.test(message);
      assert.deepEqual(calls, shouldStop
        ? [["yt-dlp", false]]
        : [["yt-dlp", false], ["gallery-dl", false]], message);
    });
  }
});

test("a rate limit or security challenge from any anonymous method blocks cookie retry", async () => {
  for (const blocker of ["HTTP 429: too many requests", "Instagram checkpoint challenge required", "Security verification required"]) {
    await withJobDir(async (jobDir) => {
      const calls = [];
      await assert.rejects(downloadInstagramWithFallbacks("https://www.instagram.com/p/EXACT/", jobDir, {
        downloadWithYtDlp: async (_url, _dir, options) => {
          calls.push(["yt-dlp", options.useCookies]);
          return failed("Login required to view post");
        },
        downloadWithGalleryDl: async (_url, _dir, options) => {
          calls.push(["gallery-dl", options.useCookies]);
          return failed(blocker);
        },
        downloadInstagramPhotos: async () => failed("generic browser extraction failure"),
        cookiesAvailable: async () => { calls.push(["cookie-check"]); return true; },
      }));
      assert.deepEqual(calls, [["yt-dlp", false], ["gallery-dl", false]]);
    });
  }
});

test("authenticated retry failures do not expose downloader output or cascade", async () => {
  await withJobDir(async (jobDir) => {
    const calls = [];
    await assert.rejects(downloadInstagramWithFallbacks("https://www.instagram.com/p/EXACT/", jobDir, {
      downloadWithYtDlp: async (_url, _dir, options) => {
        calls.push(["yt-dlp", options.useCookies]);
        return failed(options.useCookies ? "private username and cookie secret" : "Login required");
      },
      downloadWithGalleryDl: async (_url, _dir, options) => { calls.push(["gallery-dl", options.useCookies]); return failed("generic error"); },
      downloadInstagramPhotos: async () => failed("generic browser error"),
      cookiesAvailable: async () => true,
    }), error => {
      assert.equal(error.code, "INSTAGRAM_AUTH_REQUIRED");
      assert.doesNotMatch(error.message, /username|cookie secret/i);
      return true;
    });
    assert.deepEqual(calls, [["yt-dlp", false], ["gallery-dl", false], ["yt-dlp", true]]);
  });
});

test("authentication retry does not bypass Instagram permissions or cascade to other cookie tools", async () => {
  await withJobDir(async (jobDir) => {
    const calls = [];
    await assert.rejects(downloadInstagramWithFallbacks("https://www.instagram.com/p/PRIVATE/", jobDir, {
      downloadWithYtDlp: async (_url, _dir, options) => {
        calls.push(["yt-dlp", options.useCookies]);
        return options.useCookies ? failed("This content is only available to followers") : failed("Login required");
      },
      downloadWithGalleryDl: async (_url, _dir, options) => { calls.push(["gallery-dl", options.useCookies]); return failed("generic error"); },
      downloadInstagramPhotos: async () => failed("generic browser error"),
      cookiesAvailable: async () => true,
    }), (error) => {
      assert.equal(error.code, "INSTAGRAM_AUTH_REQUIRED");
      return true;
    });
    assert.deepEqual(calls, [["yt-dlp", false], ["gallery-dl", false], ["yt-dlp", true]]);
  });
});

test("actual yt-dlp and gallery-dl invocations ignore defaults and add cookies only when explicitly requested", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-instagram-cli-test-"));
  const previousYt = process.env.YTDLP_PATH;
  const previousGallery = process.env.GALLERYDL_PATH;
  const previousCookies = process.env.INSTAGRAM_COOKIES;
  const cookiePath = path.join(dir, "cookies.txt");
  const argsPath = path.join(dir, "args.json");
  const commandPath = path.join(dir, "fake-downloader.js");
  const script = `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst args = process.argv.slice(2);\nfs.writeFileSync(process.env.TEST_ARGS_PATH, JSON.stringify(args));\nif (args.includes('-d')) fs.writeFileSync(path.join(args[args.indexOf('-d') + 1], 'image.jpg'), 'test');\nelse console.log('/tmp/fake-image.jpg');\n`;
  try {
    await fs.writeFile(commandPath, script, { mode: 0o700 });
    await fs.writeFile(cookiePath, "# test-only dummy cookie file\n");
    process.env.INSTAGRAM_COOKIES = cookiePath;
    process.env.TEST_ARGS_PATH = argsPath;

    process.env.YTDLP_PATH = commandPath;
    await runInstagramYtDlp("https://www.instagram.com/p/EXACT/", path.join(dir, "out-%(id)s.%(ext)s"), "bv*+ba/b", { useCookies: false });
    let args = JSON.parse(await fs.readFile(argsPath, "utf8"));
    assert.ok(args.includes("--ignore-config"));
    assert.equal(args.includes("--cookies"), false);

    await runInstagramYtDlp("https://www.instagram.com/p/EXACT/", path.join(dir, "out-%(id)s.%(ext)s"), "bv*+ba/b", { useCookies: true });
    args = JSON.parse(await fs.readFile(argsPath, "utf8"));
    assert.ok(args.includes("--cookies"));
    assert.ok(args.includes(cookiePath));

    process.env.GALLERYDL_PATH = commandPath;
    await downloadWithGalleryDl("https://www.instagram.com/p/EXACT/", dir, { useCookies: false });
    args = JSON.parse(await fs.readFile(argsPath, "utf8"));
    assert.ok(args.includes("--config-ignore"));
    assert.equal(args.includes("--cookies"), false);

    await downloadWithGalleryDl("https://www.instagram.com/p/EXACT/", dir, { useCookies: true });
    args = JSON.parse(await fs.readFile(argsPath, "utf8"));
    assert.ok(args.includes("--cookies"));
    assert.ok(args.includes(cookiePath));
  } finally {
    for (const [name, value] of [["YTDLP_PATH", previousYt], ["GALLERYDL_PATH", previousGallery], ["INSTAGRAM_COOKIES", previousCookies]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    delete process.env.TEST_ARGS_PATH;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
