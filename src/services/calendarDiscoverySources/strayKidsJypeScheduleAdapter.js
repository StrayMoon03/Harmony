const SOURCE_KEY = "jype-straykids-schedule";
const SOURCE_PROVIDER = "jype-straykids-schedule";
const GROUP_ID = "10";
const OFFICIAL_ORIGIN = "https://straykids.jype.com";
const SCHEDULE_PAGE = `${OFFICIAL_ORIGIN}/schedule`;
const CATEGORIES = new Set(["EVENT", "SHOW", "RELEASE"]);

function isoDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : String(value);
}

function dateFromTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[T ]/);
  return match ? isoDate(match[1]) : null;
}

function isValidTimestamp(value) {
  return Boolean(value && !Number.isNaN(new Date(value).getTime()) && /T|\s/.test(String(value)));
}

function recordArray(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "schedules", "items", "results"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function sourceUrlFor(record) {
  const id = encodeURIComponent(String(record.id));
  return `${SCHEDULE_PAGE}?scheduleId=${id}`;
}

function normalizeRecord(record) {
  if (!record || record.id === undefined || record.id === null) return { candidate: null, reason: "missing-id" };
  const category = String(record.category || "").trim().toUpperCase();
  if (!CATEGORIES.has(category)) return { candidate: null, reason: "excluded-category", category };
  const allDay = Boolean(record.isAllDay);
  const scheduledDate = isoDate(record.scheduledDate);
  const scheduledAt = record.scheduledAt ? String(record.scheduledAt).trim() : null;
  const eventDate = allDay ? scheduledDate : (scheduledDate || dateFromTimestamp(scheduledAt));
  if (!eventDate) return { candidate: null, reason: "missing-date", category };
  if (!allDay && !isValidTimestamp(scheduledAt)) return { candidate: null, reason: "missing-time", category };
  const explicitTimezone = record.timezone || record.timeZone || record.tz || null;
  const offset = scheduledAt?.match(/(Z|[+-]\d{2}:?\d{2})$/)?.[1] || null;
  const metadata = {
    officialId: String(record.id),
    category,
    allDay,
    scheduledDate: scheduledDate || null,
    scheduledAt: scheduledAt || null,
    timezone: explicitTimezone,
    explicitOffset: offset,
    location: record.location || null,
  };
  return {
    candidate: {
      title: String(record.title || "").trim() || `Stray Kids ${category.toLowerCase()}`,
      proposedEventAt: allDay ? null : scheduledAt,
      proposedEventDate: eventDate,
      proposedEventEndDate: null,
      proposedEventTimezone: explicitTimezone || null,
      sourceUrl: sourceUrlFor(record),
      sourceType: "automatic_discovery",
      sourceProvider: SOURCE_PROVIDER,
      discoveryKey: `${SOURCE_PROVIDER}:${GROUP_ID}:${record.id}`,
      sourceMetadata: JSON.stringify(metadata),
      submittedNote: "Discovered from the official Stray Kids JYP schedule.",
      skipEnrichment: true,
    },
    reason: null,
  };
}

function buildEndpoint(startDate, endDate) {
  const params = new URLSearchParams({ groupId: GROUP_ID, startDate, endDate });
  return `${OFFICIAL_ORIGIN}/api/schedules?${params}`;
}

async function fetchRecords({ startDate, endDate, fetchImpl = global.fetch, signal, headers = {} } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const url = buildEndpoint(startDate, endDate);
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "Harmony-StrayKids-Discovery/1.0", ...headers },
    signal,
  });
  if (response?.status === 304) return { url, records: [], notModified: true, etag: null, lastModified: null };
  if (!response?.ok) throw new Error(`JYP schedule request failed (${response?.status || "unknown"})`);
  const payload = await response.json();
  return { url, records: recordArray(payload), notModified: false, etag: response.headers?.get?.("etag") || null, lastModified: response.headers?.get?.("last-modified") || null };
}

module.exports = {
  SOURCE_KEY,
  SOURCE_PROVIDER,
  GROUP_ID,
  OFFICIAL_ORIGIN,
  SCHEDULE_PAGE,
  CATEGORIES,
  buildEndpoint,
  normalizeRecord,
  fetchRecords,
};
