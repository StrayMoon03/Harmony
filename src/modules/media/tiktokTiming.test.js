const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TIKTOK_TIMING_PREFIX,
  createTikTokTiming,
  sanitizeTikTokTimingPayload,
} = require("./tiktokTiming");

function parseLine(line) {
  assert.equal(line.startsWith(TIKTOK_TIMING_PREFIX), true);
  return JSON.parse(line.slice(TIKTOK_TIMING_PREFIX.length));
}

test("timing run logs start and end without changing the result", async () => {
  const lines = [];
  let now = 1_000;
  const timing = createTikTokTiming({
    id: "abc12345",
    now: () => now,
    log: (line) => lines.push(line),
  });

  now = 1_000;
  const result = await timing.run("metadata_probe", async () => {
    now = 1_250;
    return "ok";
  }, { timeoutMs: 6000 });

  assert.equal(result, "ok");
  assert.deepEqual(parseLine(lines[0]), {
    v: 1,
    id: "abc12345",
    elapsedMs: 0,
    event: "step_start",
    step: "metadata_probe",
    timeoutMs: 6000,
  });
  assert.deepEqual(parseLine(lines[1]), {
    v: 1,
    id: "abc12345",
    elapsedMs: 250,
    event: "step_end",
    step: "metadata_probe",
    ok: true,
    ms: 250,
  });
});

test("timing run rethrows after logging a failed step", async () => {
  const lines = [];
  let now = 5_000;
  const timing = createTikTokTiming({
    id: "failstep",
    now: () => now,
    log: (line) => lines.push(line),
  });

  const error = new Error("probe failed");
  await assert.rejects(
    () => timing.run("download", async () => {
      now = 5_400;
      throw error;
    }),
    error
  );

  const end = parseLine(lines[1]);
  assert.equal(end.event, "step_end");
  assert.equal(end.step, "download");
  assert.equal(end.ok, false);
  assert.equal(end.ms, 400);
  assert.equal("message" in end, false);
});

test("timeout names the in-progress step and lists completed steps", async () => {
  const lines = [];
  let now = 0;
  const timing = createTikTokTiming({
    id: "timeout1",
    now: () => now,
    log: (line) => lines.push(line),
  });

  await timing.run("short_link_resolution", async () => {
    now = 800;
  }, { shortLink: true });

  timing.start("download", { isPhotoPost: false });
  now = 20_000;
  timing.timeout();

  const payload = parseLine(lines.at(-1));
  assert.deepEqual(payload, {
    v: 1,
    id: "timeout1",
    elapsedMs: 20000,
    event: "timeout",
    inProgress: "download",
    completed: [{ step: "short_link_resolution", ok: true, ms: 800 }],
  });
});

test("sanitize drops cookies, tokens, URLs, and command output", () => {
  const safe = sanitizeTikTokTimingPayload({
    event: "step_end",
    step: "download",
    ok: false,
    ms: 12,
    url: "https://www.tiktok.com/@x/video/1?sessionid=secret",
    cookie: "sessionid=abc",
    cookies: "sessionid=abc",
    token: "abc",
    authorization: "Bearer abc",
    message: "yt-dlp failed with cookie sessionid=abc",
    stderr: "sessionid=abc",
    completed: [
      {
        step: "metadata_probe",
        ok: true,
        ms: 10,
        url: "https://example.invalid",
      },
    ],
  });

  assert.deepEqual(safe, {
    event: "step_end",
    step: "download",
    ok: false,
    ms: 12,
    completed: [{ step: "metadata_probe", ok: true, ms: 10 }],
  });
});

test("asStepRunner without a timer just calls the function", async () => {
  const { asStepRunner } = require("./tiktokTiming");
  const result = await asStepRunner(null)("download", async () => 7);
  assert.equal(result, 7);
});
