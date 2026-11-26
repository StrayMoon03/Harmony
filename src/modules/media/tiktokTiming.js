const { randomUUID } = require("node:crypto");

const TIKTOK_TIMING_PREFIX = "HARMONY_TIKTOK_TIMING:";

const ALLOWED_FIELDS = new Set([
  "v",
  "id",
  "event",
  "step",
  "ms",
  "elapsedMs",
  "ok",
  "shortLink",
  "resolved",
  "skipped",
  "timeoutMs",
  "timedOut",
  "hasInfo",
  "hasAudio",
  "isPhotoPost",
  "fileCount",
  "tool",
  "inProgress",
  "completed",
  "durationSeconds",
]);

/**
 * Builds a log payload that never includes cookies, tokens, URLs, or
 * command output. Unknown keys are dropped.
 *
 * @param {object} payload
 * @returns {object}
 */
function sanitizeTikTokTimingPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  const safe = {};

  for (const [key, value] of Object.entries(payload)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (value === undefined) continue;

    if (key === "completed") {
      if (!Array.isArray(value)) continue;
      safe.completed = value.map((entry) => sanitizeTikTokTimingPayload(entry));
      continue;
    }

    if (value !== null && typeof value === "object") continue;

    safe[key] = value;
  }

  return safe;
}

function asStepRunner(timing) {
  if (timing && typeof timing.run === "function") {
    return (step, fn, extra) => timing.run(step, fn, extra);
  }
  return (_step, fn) => fn();
}

/**
 * Creates a log-only timer for one TikTok retrieval. Logging failures
 * never escape to the caller.
 *
 * @param {{ now?: () => number, log?: (...args: unknown[]) => void, id?: string }} [options]
 */
function createTikTokTiming(options = {}) {
  const now = options.now || Date.now;
  const log = options.log || ((line) => console.log(line));
  const id = options.id || randomUUID().slice(0, 8);
  const startedAt = now();
  /** @type {Array<{ step: string, ms: number, ok: boolean }>} */
  const completed = [];
  /** @type {string|null} */
  let inProgress = null;
  const startedAtByStep = new Map();

  function elapsedMs() {
    return Math.max(0, now() - startedAt);
  }

  function emit(payload) {
    try {
      log(
        TIKTOK_TIMING_PREFIX +
          JSON.stringify(
            sanitizeTikTokTimingPayload({
              v: 1,
              id,
              elapsedMs: elapsedMs(),
              ...payload,
            })
          )
      );
    } catch {
      // Log-only: never affect retrieval.
    }
  }

  function start(step, extra = {}) {
    inProgress = step;
    startedAtByStep.set(step, now());
    emit({ event: "step_start", step, ...extra });
  }

  function end(step, extra = {}) {
    const started = startedAtByStep.get(step);
    startedAtByStep.delete(step);
    const ms =
      Number.isFinite(extra.ms)
        ? extra.ms
        : started !== undefined
          ? Math.max(0, now() - started)
          : undefined;
    const ok = extra.ok !== false;
    const record = { step, ok };
    if (Number.isFinite(ms)) record.ms = ms;
    completed.push(record);
    if (inProgress === step) inProgress = null;
    emit({ event: "step_end", step, ...extra, ...(Number.isFinite(ms) ? { ms } : {}) });
  }

  async function run(step, fn, extra = {}) {
    const t0 = now();
    start(step, extra);
    try {
      const result = await fn();
      end(step, { ok: true, ms: Math.max(0, now() - t0) });
      return result;
    } catch (error) {
      end(step, { ok: false, ms: Math.max(0, now() - t0) });
      throw error;
    }
  }

  function timeout() {
    emit({
      event: "timeout",
      inProgress,
      completed,
    });
  }

  function summary(event, extra = {}) {
    emit({
      event,
      inProgress,
      completed,
      ...extra,
    });
  }

  return {
    id,
    start,
    end,
    run,
    timeout,
    summary,
    get inProgress() {
      return inProgress;
    },
    get completed() {
      return completed.slice();
    },
  };
}

module.exports = {
  TIKTOK_TIMING_PREFIX,
  createTikTokTiming,
  sanitizeTikTokTimingPayload,
  asStepRunner,
};
