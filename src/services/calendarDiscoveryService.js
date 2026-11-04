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
  const classifications = {
    new_candidate: 0,
    updated_candidate: 0,
    already_known_unchanged: 0,
    outside_discovery_window: 0,
    normalization_rejected: 0,
    admin_decision_preserved: 0,
    other_explicit_reason: 0,
  };
  const normalizationReasons = {};
  const recordResults = [];
  let candidateSubmissionFailed = false;
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
        latencyMs: Date.now() - started,
      });
      return { ok: true, notModified: true, sourceKey: source.SOURCE_KEY, runId, window, fetched: 0, newCount: 0, updated: 0, duplicate: 0, skipped: 0, classifications, normalizationReasons, recordResults };
    }
    fetched = result.records.length;
    for (const [index, record] of result.records.entries()) {
      const normalized = source.normalizeRecord(record);
      if (!normalized.candidate) {
        skipped += 1;
        classifications.normalization_rejected += 1;
        const reason = normalized.reason || "normalization-rejected";
        normalizationReasons[reason] = (normalizationReasons[reason] || 0) + 1;
        recordResults.push({ index: index + 1, classification: "normalization_rejected", reason });
        continue;
      }
      if (normalized.candidate.proposedEventDate < window.startDate || normalized.candidate.proposedEventDate > window.endDate) {
        skipped += 1;
        classifications.outside_discovery_window += 1;
        recordResults.push({ index: index + 1, classification: "outside_discovery_window", reason: "date-outside-window" });
        continue;
      }
      let outcome;
      try {
        outcome = await submitCalendarCandidate(client, guildId ? { guildId, ...normalized.candidate } : normalized.candidate);
      } catch (error) {
        candidateSubmissionFailed = true;
        classifications.other_explicit_reason += 1;
        recordResults.push({ index: index + 1, classification: "other_explicit_reason", reason: "candidate-submission-failed" });
        console.error("Calendar discovery candidate could not be saved", { sourceKey: source.SOURCE_KEY, guildId, errorClass: error.name || "Error" });
        continue;
      }
      if (outcome.duplicate) {
        duplicate += 1;
        if (outcome.updated) {
          updated += 1;
          classifications.updated_candidate += 1;
          recordResults.push({ index: index + 1, classification: "updated_candidate", reason: "open-candidate-source-changed" });
        } else if (["added", "linked", "dismissed"].includes(outcome.candidate?.status)) {
          classifications.admin_decision_preserved += 1;
          recordResults.push({ index: index + 1, classification: "admin_decision_preserved", reason: outcome.candidate.status });
        } else if (["same-discovery", "same-source", "same-title-date", "already-calendar"].includes(outcome.duplicateReason)) {
          classifications.already_known_unchanged += 1;
          recordResults.push({ index: index + 1, classification: "already_known_unchanged", reason: outcome.duplicateReason });
        } else {
          classifications.other_explicit_reason += 1;
          recordResults.push({ index: index + 1, classification: "other_explicit_reason", reason: outcome.duplicateReason || "duplicate-without-reason" });
        }
        if (outcome.sourceChanged && !outcome.updated) console.warn("Calendar discovery source changed after admin decision", { sourceKey: source.SOURCE_KEY, guildId, discoveryKey: normalized.candidate.discoveryKey, status: outcome.candidate?.status });
      } else {
        newCount += 1;
        classifications.new_candidate += 1;
        recordResults.push({ index: index + 1, classification: "new_candidate", reason: "candidate-created" });
      }
    }
    const sourceHash = crypto.createHash("sha256").update(JSON.stringify(result.records.map((record) => [record.id, record.updatedAt || record.scheduledAt || record.scheduledDate]))).digest("hex");
    store.saveCalendarDiscoveryState(guildId, source.SOURCE_KEY, {
      initialized: 1,
      lastSuccessAt: candidateSubmissionFailed ? state?.last_success_at || null : now.toISOString(),
      lastSourceHash: candidateSubmissionFailed ? state?.last_source_hash || null : sourceHash,
      etag: candidateSubmissionFailed ? state?.etag || null : result.etag || state?.etag || null,
      lastModified: candidateSubmissionFailed ? state?.last_modified || null : result.lastModified || state?.last_modified || null,
      lastError: candidateSubmissionFailed ? "candidate-submission-error" : null,
    });
    console.log("Calendar discovery completed", { sourceKey: source.SOURCE_KEY, runId, guildId, window, fetched, newCount, updated, duplicate, skipped, classifications, normalizationReasons, latencyMs: Date.now() - started });
    return { ok: !candidateSubmissionFailed, sourceKey: source.SOURCE_KEY, runId, window, fetched, newCount, updated, duplicate, skipped, classifications, normalizationReasons, recordResults, ...(candidateSubmissionFailed ? { failureReason: "candidate-submission-error" } : {}) };
  } catch (error) {
    store.saveCalendarDiscoveryState(guildId, source.SOURCE_KEY, { lastError: error.name || "source-error" });
    console.error("Calendar discovery failed", { sourceKey: source.SOURCE_KEY, runId, guildId, window, errorClass: error.name || "Error", latencyMs: Date.now() - started });
    return { ok: false, sourceKey: source.SOURCE_KEY, runId, window, fetched, newCount, updated, duplicate, skipped, classifications, normalizationReasons, recordResults, failureReason: error.code === "unexpected-response-shape" ? error.code : "source-check-failed", error: error.message };
  }
}

function aggregateDiscoveryResults(results = []) {
  const keys = ["new_candidate", "updated_candidate", "already_known_unchanged", "outside_discovery_window", "normalization_rejected", "admin_decision_preserved", "other_explicit_reason"];
  const totals = { fetched: 0, newCount: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0, classifications: Object.fromEntries(keys.map((key) => [key, 0])), normalizationReasons: {}, failureReasons: {} };
  for (const item of results) {
    totals.fetched += item.fetched || 0;
    totals.newCount += item.newCount || 0;
    totals.updated += item.updated || 0;
    totals.duplicate += item.duplicate || 0;
    totals.skipped += item.skipped || 0;
    if (!item.ok) {
      totals.failed += 1;
      const reason = item.failureReason || "source-check-failed";
      totals.failureReasons[reason] = (totals.failureReasons[reason] || 0) + 1;
    }
    for (const key of keys) totals.classifications[key] += item.classifications?.[key] || 0;
    for (const [reason, count] of Object.entries(item.normalizationReasons || {})) totals.normalizationReasons[reason] = (totals.normalizationReasons[reason] || 0) + count;
  }
  return totals;
}

function formatDiscoverySummary(totals) {
  const c = totals.classifications || {};
  const reasons = Object.entries(totals.normalizationReasons || {}).map(([reason, count]) => `${reason}: ${count}`);
  const failures = Object.entries(totals.failureReasons || {}).map(([reason, count]) => `${reason}: ${count}`);
  return [
    `Official schedule check complete. Fetched ${totals.fetched}; new ${totals.newCount}; updated ${totals.updated}; already known ${totals.duplicate}; skipped ${totals.skipped}${totals.failed ? `; failed ${totals.failed}${failures.length ? ` (${failures.join(", ")})` : ""}` : ""}.`,
    `Record results — new candidates ${c.new_candidate || 0}; updated candidates ${c.updated_candidate || 0}; already-known unchanged ${c.already_known_unchanged || 0}; outside window ${c.outside_discovery_window || 0}; normalization rejected ${c.normalization_rejected || 0}; admin decisions preserved ${c.admin_decision_preserved || 0}; other ${c.other_explicit_reason || 0}.${reasons.length ? ` Rejection reasons: ${reasons.join(", ")}.` : ""}`,
    "No calendar events were created automatically.",
  ].join("\n");
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

module.exports = { LOOKAHEAD_DAYS, CORRECTION_LOOKBACK_HOURS, POLL_INTERVAL_MS, windowFor, fetchWithLimits, runSource, runDiscovery, aggregateDiscoveryResults, formatDiscoverySummary, startCalendarDiscovery };
