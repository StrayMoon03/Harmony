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

async function pollSource(source, adapter, { now = new Date(), fetchImpl } = {}) {
  const timestamp = now.toISOString();
  if (!source.enabled || source.next_poll_at > timestamp) return { source: source.provider, skipped: true };
  const catchupSince = source.catchup_since || new Date(now.getTime() - CATCHUP_MS).toISOString();
  const normalBoundary = source.initialized_at
    ? Math.max(Date.parse(catchupSince), Date.parse(source.last_success_at) - OVERLAP_MS)
    : Date.parse(catchupSince);
  const watching = Date.parse(store.watchingBoundary(source.id));
  const since = new Date(Number.isFinite(watching) ? Math.min(normalBoundary, watching) : normalBoundary).toISOString();
  store.updateSource(source.id, { catchup_since: catchupSince, last_attempt_at: timestamp });
  try {
    const result = await adapter.fetchItems({ source, since, fetchImpl });
    for (const item of result.items || []) {
      store.ingest(source, item, classifyObservation(source, item), timestamp);
    }
    store.updateSource(source.id, {
      initialized_at: source.initialized_at || timestamp, cursor: result.cursor || source.cursor,
      last_success_at: timestamp, next_poll_at: new Date(now.getTime() + POLL_MS).toISOString(),
      etag: result.etag || source.etag, last_modified: result.lastModified || source.last_modified,
      result: result.notModified ? "not_modified" : "ok", error: null,
      limitation: result.notModified ? source.limitation : result.limitation || null,
    });
    return { source: source.provider, ok: true, count: result.items?.length || 0 };
  } catch (error) {
    const retry = Math.max(POLL_MS, Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0);
    // Only a bounded machine-readable category is persisted, never upstream bodies.
    const category = /^[a-z][a-z0-9_]{0,79}$/.test(error.message || "") ? error.message : "source_request_failed";
    store.updateSource(source.id, {
      result: "failed", error: category, next_poll_at: new Date(now.getTime() + Math.min(retry, 24 * 60 * 60 * 1000)).toISOString(),
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
    for (const source of store.listSources(guildId)) {
      const adapter = (options.adapters || SOURCES).find((candidate) => candidate.key === source.provider);
      if (adapter) results.push(await pollSource(source, adapter, options));
    }
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
