const crypto = require("node:crypto");
const store = require("../stores/eventSchedulerStore");
const { submitCalendarCandidate } = require("./eventSchedulerService");
const jype = require("./calendarDiscoverySources/strayKidsJypeScheduleAdapter");

const LOOKAHEAD_DAYS = 120;
const CORRECTION_LOOKBACK_HOURS = 48;
const POLL_INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DECISION_STATUSES = new Set(["added", "linked", "dismissed"]);
const DUPLICATE_REASONS = new Set(["same-discovery", "same-source", "same-title-date", "already-calendar"]);
const locks = new Set();
const sources = [jype];

function dateKey(date) { return date.toISOString().slice(0, 10); }
function addDays(date, days) { const next = new Date(date); next.setUTCDate(next.getUTCDate() + days); return next; }
function addHours(date, hours) { return new Date(date.getTime() + hours * 60 * 60 * 1000); }

function safeCategory(record) {
  const value = String(record?.category || "").trim().toUpperCase();
  return ["EVENT", "SHOW", "RELEASE", "ANNIVERSARY", "ETC"].includes(value) ? value : "OTHER";
}

function increment(counts, key, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

function safeSkipReason(reason) {
  return ["missing-id", "excluded-category", "missing-date", "missing-time"].includes(reason) ? `normalization:${reason}` : "normalization:other";
}

function safeDuplicateReason(reason) {
  return DUPLICATE_REASONS.has(reason) ? reason : "other";
}

function emptyDiagnostics() {
  return { categories: {}, normalized: 0, skipReasons: {}, adminDecisionPreserved: 0, duplicateReasons: {} };
}

function formatDiscoverySummary(results = []) {
  const totals = {
    fetched: 0, normalized: 0, newCount: 0, updated: 0, duplicate: 0,
    skipped: 0, adminDecisionPreserved: 0, failures: 0, notModified: 0,
    categories: {}, skipReasons: {}, failureReasons: {},
  };
  for (const item of results) {
    totals.fetched += item.fetched || 0;
    totals.normalized += item.normalized || 0;
    totals.newCount += item.newCount || 0;
    totals.updated += item.updated || 0;
    totals.duplicate += item.duplicate || 0;
    totals.skipped += item.skipped || 0;
    totals.adminDecisionPreserved += item.adminDecisionPreserved || 0;
    if (item.notModified) totals.notModified += 1;
    if (!item.ok) {
      totals.failures += 1;
      increment(totals.failureReasons, item.failureReason || "source-failed");
    }
    for (const [category, count] of Object.entries(item.categories || {})) increment(totals.categories, category, count);
    for (const [reason, count] of Object.entries(item.skipReasons || {})) increment(totals.skipReasons, reason, count);
  }
  const categoryText = Object.entries(totals.categories).map(([name, count]) => `${name} ${count}`).join(", ") || "none";
  const skippedText = Object.entries(totals.skipReasons).map(([name, count]) => `${name} ${count}`).join(", ");
  const failureText = Object.entries(totals.failureReasons).map(([name, count]) => `${name} ${count}`).join(", ");
  const fetchedText = totals.fetched
    ? `Fetched ${totals.fetched} (${categoryText})`
    : totals.notModified ? "JYP source unchanged (HTTP 304)" : "JYP returned 0 records";
  return [
    `Official schedule check complete. ${fetchedText}; normalized ${totals.normalized}; new ${totals.newCount}; updated ${totals.updated}; already known ${totals.duplicate}; skipped ${totals.skipped}${skippedText ? ` (${skippedText})` : ""}${totals.adminDecisionPreserved ? `; prior admin decisions preserved ${totals.adminDecisionPreserved}` : ""}${totals.failures ? `; source failures ${totals.failures} (${failureText})` : ""}.`,
    "No calendar events were created automatically.",
  ].join(" ");
}

function sourceFailureReason(error) {
  if (error?.code === "unexpected-response-shape") return "response-shape-unknown";
  if (error?.code === "invalid-json" || error instanceof SyntaxError) return "invalid-json";
  if (error?.code === "upstream-http-failure") return Number(error.status) === 429 ? "rate-limited" : "upstream-http-error";
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "timeout";
  return "network-or-source-error";
}

function windowFor(state, now = new Date()) {
  const start = state?.initialized ? addHours(now, -CORRECTION_LOOKBACK_HOURS) : now;
  return { startDate: dateKey(start), endDate: dateKey(addDays(now, LOOKAHEAD_DAYS)) };
}

async function fetchWithLimits(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response?.ok) return response;
    if (typeof response.json !== "function") return response;
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) throw new Error("source response exceeded size limit");
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      json: async () => JSON.parse(raw),
    };
  } finally { clearTimeout(timer); }
}

async function fetchSourceWithRetry(source, options) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await source.fetchRecords(options);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw lastError;
}

async function runSource(client, guildId, source, { now = new Date(), fetchImpl = fetchWithLimits } = {}) {
  const state = store.getCalendarDiscoveryState(guildId, source.SOURCE_KEY);
  const window = windowFor(state, now);
  const runId = crypto.randomUUID();
  const started = Date.now();
  store.saveCalendarDiscoveryState(guildId, source.SOURCE_KEY, { lastRunAt: now.toISOString(), lastError: null });
  let fetched = 0, newCount = 0, updated = 0, duplicate = 0, skipped = 0;
  const diagnostics = emptyDiagnostics();
  try {
    const conditionalHeaders = {};
    if (state?.etag) conditionalHeaders["if-none-match"] = state.etag;
    if (state?.last_modified) conditionalHeaders["if-modified-since"] = state.last_modified;
    const result = await fetchSourceWithRetry(source, { ...window, fetchImpl, headers: conditionalHeaders });
    if (result.notModified) {
      store.saveCalendarDiscoveryState(guildId, source.SOURCE_KEY, {
        initialized: 1,
        lastSuccessAt: now.toISOString(),
        lastError: null,
      });
      console.log("Calendar discovery not modified", {
        sourceKey: source.SOURCE_KEY,
        runId,
        guildId,
        window,
        fetched: 0,
        ...diagnostics,
        latencyMs: Date.now() - started,
      });
      return { ok: true, notModified: true, sourceKey: source.SOURCE_KEY, runId, window, fetched: 0, newCount: 0, updated: 0, duplicate: 0, skipped: 0, ...diagnostics };
    }
    fetched = result.records.length;
    for (const record of result.records) {
      increment(diagnostics.categories, safeCategory(record));
      const normalized = source.normalizeRecord(record);
      if (!normalized.candidate) {
        skipped += 1;
        increment(diagnostics.skipReasons, safeSkipReason(normalized.reason));
        continue;
      }
      diagnostics.normalized += 1;
      if (normalized.candidate.proposedEventDate < window.startDate || normalized.candidate.proposedEventDate > window.endDate) {
        skipped += 1;
        increment(diagnostics.skipReasons, "outside-discovery-window");
        continue;
      }
      const outcome = await submitCalendarCandidate(client, guildId ? { guildId, ...normalized.candidate } : normalized.candidate);
      if (outcome.duplicate) {
        duplicate += 1;
        if (outcome.updated) updated += 1;
        increment(diagnostics.duplicateReasons, safeDuplicateReason(outcome.duplicateReason));
        if (DECISION_STATUSES.has(outcome.candidate?.status)) diagnostics.adminDecisionPreserved += 1;
        if (outcome.sourceChanged && !outcome.updated) console.warn("Calendar discovery source changed after admin decision", { sourceKey: source.SOURCE_KEY, guildId, discoveryKey: normalized.candidate.discoveryKey, status: outcome.candidate?.status });
      } else newCount += 1;
    }
    const sourceHash = crypto.createHash("sha256").update(JSON.stringify(result.records.map((record) => [record.id, record.updatedAt || record.scheduledAt || record.scheduledDate]))).digest("hex");
    store.saveCalendarDiscoveryState(guildId, source.SOURCE_KEY, { initialized: 1, lastSuccessAt: now.toISOString(), lastSourceHash: sourceHash, etag: result.etag || state?.etag || null, lastModified: result.lastModified || state?.last_modified || null, lastError: null });
    console.log("Calendar discovery completed", { sourceKey: source.SOURCE_KEY, runId, guildId, window, fetched, ...diagnostics, newCount, updated, duplicate, skipped, latencyMs: Date.now() - started });
    return { ok: true, sourceKey: source.SOURCE_KEY, runId, window, fetched, newCount, updated, duplicate, skipped, ...diagnostics };
  } catch (error) {
    const failureReason = sourceFailureReason(error);
    store.saveCalendarDiscoveryState(guildId, source.SOURCE_KEY, { lastError: error.name || "source-error" });
    console.error("Calendar discovery failed", { sourceKey: source.SOURCE_KEY, runId, guildId, window, failureReason, httpStatus: Number.isInteger(error.status) ? error.status : null, errorClass: error.name || "Error", fetched, ...diagnostics, latencyMs: Date.now() - started });
    return { ok: false, sourceKey: source.SOURCE_KEY, runId, window, fetched, newCount, updated, duplicate, skipped, ...diagnostics, failureReason };
  }
}

async function runDiscovery(client, { now = new Date(), fetchImpl = fetchWithLimits, guildIds = null, automatic = false } = {}) {
  if (locks.has("calendar-discovery")) return { locked: true, results: [] };
  locks.add("calendar-discovery");
  try {
    const results = [];
    const guilds = [...(client?.guilds?.cache?.values?.() || [])]
      .filter((guild) => !guildIds || guildIds.includes(guild.id))
      .filter((guild) => !automatic || store.isCalendarDiscoveryEnabled(guild.id));
    for (const guild of guilds) {
      for (const source of sources) results.push(await runSource(client, guild.id, source, { now, fetchImpl }));
    }
    return { locked: false, results };
  } finally { locks.delete("calendar-discovery"); }
}

function startCalendarDiscovery(client) {
  runDiscovery(client, { automatic: true }).catch((error) => console.error("Calendar discovery startup failed", { errorClass: error.name || "Error" }));
  const timer = setInterval(() => runDiscovery(client, { automatic: true }).catch((error) => console.error("Calendar discovery failed", { errorClass: error.name || "Error" })), POLL_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

module.exports = { LOOKAHEAD_DAYS, CORRECTION_LOOKBACK_HOURS, POLL_INTERVAL_MS, windowFor, fetchWithLimits, runSource, runDiscovery, startCalendarDiscovery, formatDiscoverySummary };
