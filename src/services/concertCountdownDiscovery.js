"use strict";
// Private, read-only source checks. Reuse Radar's bounded readers, never its delivery path.
const { createHash } = require("node:crypto");
const adapters = [require("./radarSources/jypeNotice"), require("./radarSources/sonyInfo")];
const { workBudget } = require("./radarSources/common");
const tour = require("./concertTourCalendar");
const { validDate } = require("./radarCalendarPrefill");
const { normalize, locationEvidence } = require("./concertTourIdentity");
const jobs = new Map(), next = new Map(), cursors = new Map();
function suggestions(item, locations) {
  const text = [item.title, item.summary].join(" ");
  const hits = locations.filter(l => Object.values(locationEvidence({ title: text }, l)).some(Boolean));
  // Never combine a multi-city announcement's dates with a guessed location.
  const location = hits.length === 1 ? hits[0] : null;
  const dates = [...new Set(text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [])]
    .filter(validDate);
  return { location, dates: location && dates.length <= 12 ? dates : [] };
}
async function search(guildId, { now = new Date(), fetchImpl, sources = adapters, locations = tour.groups(guildId) } = {}) {
  if (jobs.has(guildId)) return jobs.get(guildId);
  if ((next.get(guildId) || 0) > now.getTime())
    throw Error("Official sources were checked recently. Please wait before checking again.");
  next.set(guildId, now.getTime() + 60000);
  const job = (async () => {
    const results = await Promise.all(sources.map(async source => {
      try {
        const cursorKey = guildId + ":" + source.key;
        const result = await source.fetchItems({ source: { traversal_state: cursors.get(cursorKey) || null }, since: new Date(now.getTime() - 7 * 86400000).toISOString(), now: now.toISOString(), fetchImpl, budget: workBudget(), knownIds: new Set() });
        cursors.set(cursorKey, result.continuation || null);
        return { provider: source.key, ok: true, limitation: result.continuation ? "Partial listings; the next check continues the remaining articles." : result.limitation || null, items: result.items || [] };
      } catch (error) {
        const delay = Number(error.retryAfterMs);
        if (delay > 0) next.set(guildId, Math.max(next.get(guildId), now.getTime() + delay));
        return { provider: source.key, ok: false, limitation: "Source unavailable; no complete result can be claimed.", items: [] };
      }
    }));
    const items = [...new Map(results.flatMap(r => r.items).filter(item =>
      tour.officialSource(item.url) && /concert|world.?tour|run.?it|追加公演|公演|콘서트|투어/i.test(item.title + " " + item.summary),
    ).map(item => [item.url, { ...item, ...suggestions(item, locations) }])).values()].slice(0, 100);
    return { checkedAt: now.toISOString(), items, sources: results.map(({ items, ...status }) => status) };
  })();
  jobs.set(guildId, job);
  try { return await job; } finally { jobs.delete(guildId); }
}
function manifest(item, fields, now = new Date()) {
  if (!item || !tour.officialSource(item.url)) throw Error("Review a supported official announcement first");
  const dates = [...new Set(fields.dates.split(/[\s,;]+/).filter(Boolean))];
  const known = item.location && normalize(item.location.city) === normalize(fields.city) && normalize(item.location.venue) === normalize(fields.venue) ? item.location : null;
  const key = known?.key || "discovered-" + createHash("sha256").update(normalize(fields.city + " " + fields.country + " " + fields.venue)).digest("hex").slice(0, 24);
  return tour.validateManifest({ tourId: tour.bundled.tourId, verifiedAt: now.toISOString().slice(0, 10), locations: [{ key, city: fields.city, country: fields.country, venue: fields.venue, timezone: fields.timezone, dates: dates.map(date => ({ date, sourceUrl: item.url })) }] });
}
module.exports = { search, suggestions, manifest };
