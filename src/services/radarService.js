const store = require("../stores/radarStore");
const { classifyObservation } = require("./radarClassification");
const jype = require("./radarSources/jypeNotice");
const youtube = require("./radarSources/youtubeUploads");
const sony = require("./radarSources/sonyInfo");

const SOURCES = [jype, youtube, sony];
const POLL_MS = 15 * 60 * 1000;
const CATCHUP_MS = 7 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 48 * 60 * 60 * 1000;
const jobs = new Map();
const { workBudget } = require("./radarSources/common");

async function pollSource(source, adapter, { now = new Date(), fetchImpl } = {}) {
  const timestamp = now.toISOString();
  if (!source.enabled || Date.parse(source.next_poll_at) > now.getTime()) return { source: source.provider, skipped: true };
  const catchupSince = source.catchup_since || new Date(now.getTime() - CATCHUP_MS).toISOString();
  const normalBoundary = source.initialized_at
    ? Math.max(Date.parse(catchupSince), Date.parse(source.last_success_at) - OVERLAP_MS)
    : Date.parse(catchupSince);
  const since = new Date(normalBoundary).toISOString();
  const started = Date.now();
  const budget = workBudget();
  store.updateSource(source.id, { catchup_since: catchupSince, last_attempt_at: timestamp });
  try {
    const watched = store.watchedItems(source.id);
    const limitations = [];
    // Direct watched-detail requests never widen the normal listing boundary.
    // Rotate persistently so even very old notices remain reachable in bounded work.
    if (adapter.revisit && watched.length) {
      for (let n = 0; n < Math.min(2, watched.length); n++) {
        const index = (source.watch_cursor + n) % watched.length;
        try {
          const item = await adapter.revisit(watched[index], { fetchImpl, budget });
          store.ingest(source, item, classifyObservation(source, item), timestamp);
        } catch (error) {
          if (error.retryAfterMs > 0) throw error;
          limitations.push("A watched detail could not be revisited; later cycles will retry.");
        }
        store.updateSource(source.id, { watch_cursor: (index + 1) % watched.length });
      }
    } else if (watched.length) {
      limitations.push("Watched edits are checked only within this source's available listing/feed history.");
    }
    const result = await adapter.fetchItems({ source, since, fetchImpl, budget, now: timestamp, knownIds: store.knownItems(source.id) });
    for (const item of result.items || []) {
      store.ingest(source, item, classifyObservation(source, item), timestamp);
    }
    store.updateSource(source.id, {
      initialized_at: result.continuation ? source.initialized_at : source.initialized_at || timestamp,
      traversal_state: result.continuation || null, cursor: result.cursor || source.cursor,
      last_success_at: result.continuation ? source.last_success_at : result.coveredThrough || timestamp,
      next_poll_at: new Date(now.getTime() + (Date.now() - started) + POLL_MS).toISOString(),
      etag: result.etag || source.etag, last_modified: result.lastModified || source.last_modified,
      result: result.notModified ? "not_modified" : "ok", error: null,
      limitation: result.notModified ? source.limitation : [...limitations, result.limitation].filter(Boolean).join(" ") || null,
    });
    return { source: source.provider, ok: true, count: result.items?.length || 0 };
  } catch (error) {
    // Never shorten a valid Retry-After. Unrepresentable values pause visibly
    // rather than silently scheduling earlier than the provider requested.
    const supplied = error.retryAfterMs;
    const retry = Math.max(POLL_MS, Number.isFinite(supplied) && supplied > 0 ? supplied : 0);
    const retryTime = now.getTime() + (Date.now() - started) + retry;
    const representable = Number.isFinite(new Date(retryTime).getTime());
    const nextPoll = representable ? new Date(retryTime).toISOString() : "9999-12-31T23:59:59.999Z";
    // Only a bounded machine-readable category is persisted, never upstream bodies.
    const category = /^[a-z][a-z0-9_]{0,79}$/.test(error.message || "") ? error.message : "source_request_failed";
    store.updateSource(source.id, {
      result: "failed", error: category, next_poll_at: nextPoll,
      ...(!representable ? { limitation: "Provider retry interval exceeds the supported clock; automatic polling is suspended pending review." } : {}),
    });
    return { source: source.provider, ok: false, error: category };
  }
}
async function pollRadar(client, guildId, options = {}) {
  if (jobs.has(guildId)) return jobs.get(guildId);
  const job = (async () => {
    const settings = store.getSettings(guildId);
    if (!settings?.enabled) return [];
    store.ensureSources(guildId, options.adapters || SOURCES);
    const results = [];
    // Providers have independent HTTP budgets and progress concurrently. Delivery
    // can drain saved work while a slow provider is still spending its budget.
    const sync = client ? () => require("./radarDiscord").syncRadarChannel(client, guildId) : async () => {};
    await sync();
    await Promise.all(store.listSources(guildId).map(async (source) => {
      const adapter = (options.adapters || SOURCES).find((candidate) => candidate.key === source.provider);
      if (adapter) results.push(await pollSource(source, adapter, options));
    }));
    if (client) {
      // Separate delivery failure from provider polling and retain all observations.
      const { syncRadarChannel } = require("./radarDiscord");
      await syncRadarChannel(client, guildId);
    }
    return results;
  })();
  jobs.set(guildId, job);
  try { return await job; } finally { jobs.delete(guildId); }
}
function startRadar(client) {
  const run = async () => {
    for (const settings of store.listSettings()) {
      try { await pollRadar(client, settings.guild_id); }
      catch { console.warn("Radar poll failed for a configured Harmony server."); }
    }
  };
  run().catch(() => console.warn("Radar startup poll failed."));
  const timer = setInterval(run, POLL_MS);
  timer.unref?.();
  return timer;
}
module.exports = { SOURCES, POLL_MS, CATCHUP_MS, OVERLAP_MS, pollSource, pollRadar, startRadar };
