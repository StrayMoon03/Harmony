const crypto = require("node:crypto");
const store = require("../stores/eventSchedulerStore");
const { submitCalendarCandidate } = require("./eventSchedulerService");
const jype = require("./calendarDiscoverySources/strayKidsJypeScheduleAdapter");

const LOOKAHEAD_DAYS = 120;
const CORRECTION_LOOKBACK_HOURS = 48;
const POLL_INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const locks = new Set();
const sources = [jype];

function dateKey(date) { return date.toISOString().slice(0, 10); }
function addDays(date, days) { const next = new Date(date); next.setUTCDate(next.getUTCDate() + days); return next; }
function addHours(date, hours) { return new Date(date.getTime() + hours * 60 * 60 * 1000); }

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
    return { ok: response.ok, status: response.status, json: async () => JSON.parse(raw) };
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
  try {
    const conditionalHeaders = {};
    if (state?.etag) conditionalHeaders["if-none-match"] = state.etag;
    if (state?.last_modified) conditionalHeaders["if-modified-since"] = state.last_modified;
    const result = await fetchSourceWithRetry(source, { ...window, fetchImpl, headers: conditionalHeaders });
    if (result.notModified) {
      store.saveCalendarDiscoveryState(guildId, source.SOURCE_KEY, {
        initialized: 1,
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
      });
      console.log("Calendar discovery not modified", {
        sourceKey: source.SOURCE_KEY,
        runId,
        guildId,
        window,
        fetched: 0,
        latencyMs: Date.now() - started,
      });
      return { ok: true, notModified: true, sourceKey: source.SOURCE_KEY, runId, window, fetched: 0, newCount: 0, updated: 0, duplicate: 0, skipped: 0 };
    }
    fetched = result.records.length;
    for (const record of result.records) {
      const normalized = source.normalizeRecord(record);
      if (!normalized.candidate) { skipped += 1; continue; }
      if (normalized.candidate.proposedEventDate < window.startDate || normalized.candidate.proposedEventDate > window.endDate) { skipped += 1; continue; }
      const outcome = await submitCalendarCandidate(client, guildId ? { guildId, ...normalized.candidate } : normalized.candidate);
      if (outcome.duplicate) {
        duplicate += 1;
        if (outcome.updated) updated += 1;
        if (outcome.sourceChanged && !outcome.updated) console.warn("Calendar discovery source changed after admin decision", { sourceKey: source.SOURCE_KEY, guildId, discoveryKey: normalized.candidate.discoveryKey, status: outcome.candidate?.status });
      } else newCount += 1;
    }
    const sourceHash = crypto.createHash("sha256").update(JSON.stringify(result.records.map((record) => [record.id, record.updatedAt || record.scheduledAt || record.scheduledDate]))).digest("hex");
    store.saveCalendarDiscoveryState(guildId, source.SOURCE_KEY, { initialized: 1, lastSuccessAt: new Date().toISOString(), lastSourceHash: sourceHash, etag: result.etag || state?.etag || null, lastModified: result.lastModified || state?.last_modified || null, lastError: null });
    console.log("Calendar discovery completed", { sourceKey: source.SOURCE_KEY, runId, guildId, window, fetched, newCount, updated, duplicate, skipped, latencyMs: Date.now() - started });
    return { ok: true, sourceKey: source.SOURCE_KEY, runId, window, fetched, newCount, updated, duplicate, skipped };
  } catch (error) {
    store.saveCalendarDiscoveryState(guildId, source.SOURCE_KEY, { lastError: error.name || "source-error" });
    console.error("Calendar discovery failed", { sourceKey: source.SOURCE_KEY, runId, guildId, window, errorClass: error.name || "Error", latencyMs: Date.now() - started });
    return { ok: false, sourceKey: source.SOURCE_KEY, runId, window, fetched, newCount, updated, duplicate, skipped, error: error.message };
  }
}

async function runDiscovery(client, { now = new Date(), fetchImpl = fetchWithLimits, guildIds = null } = {}) {
  if (locks.has("calendar-discovery")) return { locked: true, results: [] };
  locks.add("calendar-discovery");
  try {
    const results = [];
    const guilds = [...(client?.guilds?.cache?.values?.() || [])].filter((guild) => !guildIds || guildIds.includes(guild.id));
    for (const guild of guilds) {
      for (const source of sources) results.push(await runSource(client, guild.id, source, { now, fetchImpl }));
    }
    return { locked: false, results };
  } finally { locks.delete("calendar-discovery"); }
}

function startCalendarDiscovery(client) {
  runDiscovery(client).catch((error) => console.error("Calendar discovery startup failed", { errorClass: error.name || "Error" }));
  const timer = setInterval(() => runDiscovery(client).catch((error) => console.error("Calendar discovery failed", { errorClass: error.name || "Error" })), POLL_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

module.exports = { LOOKAHEAD_DAYS, CORRECTION_LOOKBACK_HOURS, POLL_INTERVAL_MS, windowFor, runSource, runDiscovery, startCalendarDiscovery };
