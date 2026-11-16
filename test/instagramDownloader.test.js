const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { runInstagramYtDlpAttempts } = require("../src/modules/media/downloader");

test("a cookie-authenticated Instagram result is preferred when a cookie file exists", async () => {
  const originalCookiePath = process.env.INSTAGRAM_COOKIES;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instagram-public-first-"));
  const cookiePath = path.join(root, "cookies.txt");
  await fs.writeFile(cookiePath, "test-only cookie fixture");
  process.env.INSTAGRAM_COOKIES = cookiePath;
  const jobDir = path.join(root, "job");
  await fs.mkdir(jobDir);
  const calls = [];

  try {
    const outcome = await runInstagramYtDlpAttempts("https://www.instagram.com/reel/abc123/", jobDir, {
      download: async (_url, _dir, options) => {
        calls.push(options.useCookies);
        return { files: [options.useCookies ? "authenticated.mp4" : "public.mp4"], platform: "instagram" };
      },
    });
    assert.deepEqual(calls, [true]);
    assert.equal(outcome.result.files[0], "authenticated.mp4");
    assert.deepEqual(outcome.failures, []);
  } finally {
    if (originalCookiePath === undefined) delete process.env.INSTAGRAM_COOKIES;
    else process.env.INSTAGRAM_COOKIES = originalCookiePath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("non-Reel Instagram media keeps its existing public-first order", async () => {
  const originalCookiePath = process.env.INSTAGRAM_COOKIES;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instagram-photo-public-first-"));
  const cookiePath = path.join(root, "cookies.txt");
  await fs.writeFile(cookiePath, "test-only cookie fixture");
  process.env.INSTAGRAM_COOKIES = cookiePath;
  const jobDir = path.join(root, "job");
  await fs.mkdir(jobDir);
  const calls = [];
  try {
    const outcome = await runInstagramYtDlpAttempts("https://www.instagram.com/p/abc123/", jobDir, {
      download: async (_url, _dir, options) => {
        calls.push(options.useCookies);
        return { files: ["public-photo.jpg"], platform: "instagram" };
      },
    });
    assert.deepEqual(calls, [false]);
    assert.equal(outcome.result.files[0], "public-photo.jpg");
  } finally {
    if (originalCookiePath === undefined) delete process.env.INSTAGRAM_COOKIES;
    else process.env.INSTAGRAM_COOKIES = originalCookiePath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Instagram falls back to public retrieval when the cookie attempt fails", async () => {
  const originalCookiePath = process.env.INSTAGRAM_COOKIES;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instagram-cookie-fallback-"));
  const cookiePath = path.join(root, "cookies.txt");
  const jobDir = path.join(root, "job");
  await fs.writeFile(cookiePath, "test-only cookie fixture");
  await fs.mkdir(jobDir);
  process.env.INSTAGRAM_COOKIES = cookiePath;
  const calls = [];

  try {
    const outcome = await runInstagramYtDlpAttempts("https://www.instagram.com/reel/abc123/", jobDir, {
      download: async (_url, _dir, options) => {
        calls.push(options.useCookies);
        if (options.useCookies) throw new Error("cookie retrieval failed");
        return { files: ["public.mp4"], platform: "instagram" };
      },
    });
    assert.deepEqual(calls, [true, false]);
    assert.equal(outcome.result.files[0], "public.mp4");
    assert.equal(outcome.failures.length, 1);
    assert.equal(outcome.failures[0].useCookies, true);
  } finally {
    if (originalCookiePath === undefined) delete process.env.INSTAGRAM_COOKIES;
    else process.env.INSTAGRAM_COOKIES = originalCookiePath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Instagram does not attempt a cookie fallback when no cookie file is available", async () => {
  const originalCookiePath = process.env.INSTAGRAM_COOKIES;
  process.env.INSTAGRAM_COOKIES = path.join(os.tmpdir(), `missing-instagram-cookies-${process.pid}`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instagram-no-cookie-fallback-"));
  const jobDir = path.join(root, "job");
  await fs.mkdir(jobDir);
  const calls = [];

  try {
    const outcome = await runInstagramYtDlpAttempts("https://www.instagram.com/reel/abc123/", jobDir, {
      download: async (_url, _dir, options) => {
        calls.push(options.useCookies);
        throw new Error("public retrieval failed");
      },
    });
    assert.deepEqual(calls, [false]);
    assert.equal(outcome.result, null);
    assert.equal(outcome.failures.length, 1);
  } finally {
    if (originalCookiePath === undefined) delete process.env.INSTAGRAM_COOKIES;
    else process.env.INSTAGRAM_COOKIES = originalCookiePath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Instagram tries public retrieval after cookie output has no audio", async () => {
  const originalCookiePath = process.env.INSTAGRAM_COOKIES;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instagram-silent-cookie-recovery-"));
  const cookiePath = path.join(root, "cookies.txt");
  const jobDir = path.join(root, "job");
  await fs.writeFile(cookiePath, "test-only cookie fixture");
  await fs.mkdir(jobDir);
  process.env.INSTAGRAM_COOKIES = cookiePath;
  const calls = [];

  try {
    const outcome = await runInstagramYtDlpAttempts("https://www.instagram.com/reel/abc123/", jobDir, {
      download: async (_url, attemptDir, options) => {
        calls.push({ useCookies: options.useCookies, attemptDir });
        return options.useCookies
          ? { files: ["cookie-silent.mp4"], hasAudio: false }
          : { files: ["public-audio.mp4"], hasAudio: true };
      },
    });
    assert.deepEqual(calls.map((call) => call.useCookies), [true, false]);
    assert.notEqual(calls[0].attemptDir, calls[1].attemptDir);
    assert.equal(outcome.result.files[0], "public-audio.mp4");
    assert.equal(outcome.result.hasAudio, true);
    assert.equal(outcome.cookieAttempted, true);
  } finally {
    if (originalCookiePath === undefined) delete process.env.INSTAGRAM_COOKIES;
    else process.env.INSTAGRAM_COOKIES = originalCookiePath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
