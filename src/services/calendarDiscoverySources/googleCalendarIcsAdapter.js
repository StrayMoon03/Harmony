function decodeText(value) {
  return String(value || "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function unfold(text) {
  return String(text || "").replace(/\r?\n[ \t]/g, "");
}

function parseProperty(line) {
  const index = line.indexOf(":");
  if (index < 0) return null;
  const left = line.slice(0, index).split(";");
  const params = {};
  for (const part of left.slice(1)) {
    const split = part.indexOf("=");
    if (split > 0) params[part.slice(0, split).toUpperCase()] = part.slice(split + 1).replace(/^"|"$/g, "");
  }
  return { name: left[0].toUpperCase(), params, value: decodeText(line.slice(index + 1)) };
}

function parseCalendar(text) {
  const calendar = { properties: {}, events: [] };
  let event = null;
  for (const line of unfold(text).split(/\r?\n/)) {
    if (line === "BEGIN:VEVENT") { event = {}; continue; }
    if (line === "END:VEVENT") { if (event) calendar.events.push(event); event = null; continue; }
    const property = parseProperty(line);
    if (!property) continue;
    const target = event || calendar.properties;
    if (target === calendar.properties) target[property.name] = property;
    else {
      (target[property.name] ||= []).push(property);
    }
  }
  return calendar;
}

function get(event, name) { return event?.[name]?.[0] || null; }

function validTimezone(value) {
  if (!value) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date()); return true; }
  catch { return false; }
}

function localDateFor(instant, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function parseIcsDate(property) {
  if (!property?.value) return null;
  if (property.params.VALUE === "DATE" || /^\d{8}$/.test(property.value)) {
    const match = property.value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!match) return null;
    return { allDay: true, date: `${match[1]}-${match[2]}-${match[3]}`, instant: null, timezone: property.params.TZID || null, raw: property.value };
  }
  const value = property.value;
  let instant;
  if (/^\d{8}T\d{6}Z$/.test(value)) {
    instant = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`);
  } else if (/^\d{8}T\d{6}$/.test(value) && validTimezone(property.params.TZID)) {
    // Resolve local wall time against the supplied IANA zone, including DST.
    const y = Number(value.slice(0, 4)), mo = Number(value.slice(4, 6)) - 1, d = Number(value.slice(6, 8));
    const hh = Number(value.slice(9, 11)), mm = Number(value.slice(11, 13)), ss = Number(value.slice(13, 15));
    const target = Date.UTC(y, mo, d, hh, mm, ss);
    let guess = target;
    for (let i = 0; i < 3; i += 1) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: property.params.TZID, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
      const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
      guess += target - represented;
    }
    instant = new Date(guess);
  } else return null;
  if (Number.isNaN(instant.getTime())) return null;
  return { allDay: false, date: null, instant, timezone: property.params.TZID || null, raw: value };
}

function eventTimezone(location, explicitTimezone, calendarTimezone) {
  if (validTimezone(explicitTimezone)) return explicitTimezone;
  const value = String(location || "").toLowerCase();
  if (value.includes("hong kong")) return "Asia/Hong_Kong";
  if (value.includes("taipei") || value.includes("taiwan")) return "Asia/Taipei";
  if (value.includes("tokyo") || value.includes("japan")) return "Asia/Tokyo";
  if (value.includes("seoul") || value.includes("korea") || value.includes("incheon")) return "Asia/Seoul";
  return validTimezone(calendarTimezone) ? calendarTimezone : "Asia/Seoul";
}

function sourceUrlFromEvent(event, fallback) {
  const direct = get(event, "URL")?.value;
  if (direct) {
    try { const parsed = new URL(direct); if (["http:", "https:"].includes(parsed.protocol)) return parsed.toString(); } catch { /* Use description link or publisher page. */ }
  }
  const description = get(event, "DESCRIPTION")?.value || "";
  const href = description.match(/href=["']([^"']+)["']/i)?.[1];
  if (href) {
    try {
      let url = new URL(href.replace(/&amp;/g, "&"));
      const wrapped = url.searchParams.get("q");
      if (url.hostname === "www.google.com" && url.pathname === "/url" && wrapped) url = new URL(wrapped);
      if (["http:", "https:"].includes(url.protocol)) return url.toString();
    } catch { /* Use publisher page. */ }
  }
  return fallback;
}

function createIcsSource(config) {
  const { SOURCE_KEY, SOURCE_PROVIDER, SOURCE_NAME, CALENDAR_NAME, TIMEZONE, CALENDAR_URL, FEED_URL } = config;
  function normalizeRecord(event, { retrievedAt = new Date().toISOString() } = {}) {
    const status = get(event, "STATUS")?.value?.toUpperCase();
    if (status === "CANCELLED") return { candidate: null, reason: "cancelled" };
    const uid = get(event, "UID")?.value;
    const title = get(event, "SUMMARY")?.value?.trim();
    const start = parseIcsDate(get(event, "DTSTART"));
    if (!uid) return { candidate: null, reason: "missing-id" };
    if (!title) return { candidate: null, reason: "missing-title" };
    if (!start) return { candidate: null, reason: "missing-date" };
    const end = parseIcsDate(get(event, "DTEND"));
    const location = get(event, "LOCATION")?.value || null;
    const timezone = eventTimezone(location, start.timezone, TIMEZONE);
    const eventDate = start.allDay ? start.date : localDateFor(start.instant, timezone);
    let endDate = null;
    if (end) {
      endDate = end.allDay ? shiftDate(end.date, -1) : localDateFor(end.instant, timezone);
      if (endDate === eventDate) endDate = null;
    }
    const sourceUrl = sourceUrlFromEvent(event, CALENDAR_URL);
    const startAt = start.allDay ? null : start.instant.toISOString();
    const metadata = {
      allDay: start.allDay,
      location,
      sourceDateTime: start.raw,
      sourceEndDateTime: end?.raw || null,
      calendarTimezone: TIMEZONE,
      sourceUid: uid,
    };
    const provenance = {
      provider: SOURCE_PROVIDER,
      sourceName: SOURCE_NAME,
      sourceId: uid,
      sourceUrl,
      calendarUrl: CALENDAR_URL,
      originalTitle: title,
      location,
      sourceDateTime: start.raw,
      sourceEndDateTime: end?.raw || null,
      retrievedAt,
    };
    return {
      candidate: {
        title,
        proposedEventAt: startAt,
        proposedEventDate: eventDate,
        proposedEventEndDate: endDate,
        proposedEventTimezone: start.allDay ? null : timezone,
        sourceUrl,
        sourceType: "automatic_discovery",
        sourceProvider: SOURCE_PROVIDER,
        discoveryKey: `${SOURCE_PROVIDER}:${uid}`,
        sourceMetadata: JSON.stringify(metadata),
        sourceProvenance: [provenance],
        submittedNote: `Discovered from ${SOURCE_NAME}.`,
        skipEnrichment: true,
      },
      reason: null,
    };
  }
  async function fetchRecords({ startDate, endDate, fetchImpl = global.fetch, signal, headers = {} } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
    const response = await fetchImpl(FEED_URL, { headers: { accept: "text/calendar", "user-agent": "Harmony-StrayKids-Discovery/1.0", ...headers }, signal });
    if (response?.status === 304) return { url: FEED_URL, records: [], notModified: true, etag: null, lastModified: null };
    if (!response?.ok) {
      const error = new Error(`${SOURCE_NAME} calendar request failed`); error.code = "upstream-http-failure"; error.status = response?.status; throw error;
    }
    let text;
    try { text = await response.text(); } catch { const error = new Error("Invalid calendar response"); error.code = "invalid-calendar"; throw error; }
    const calendar = parseCalendar(text);
    if (!/BEGIN:VCALENDAR/.test(text) || !/END:VCALENDAR/.test(text)) {
      const error = new Error("Unrecognized public calendar feed"); error.code = "unexpected-response-shape"; throw error;
    }
    const records = calendar.events.filter((event) => {
      const parsed = parseIcsDate(get(event, "DTSTART"));
      if (!parsed) return true;
      const location = get(event, "LOCATION")?.value || null;
      const timezone = eventTimezone(location, parsed.timezone, TIMEZONE);
      const date = parsed.allDay ? parsed.date : localDateFor(parsed.instant, timezone);
      return date >= startDate && date <= endDate;
    });
    return { url: FEED_URL, records, notModified: false, etag: response.headers?.get?.("etag") || null, lastModified: response.headers?.get?.("last-modified") || null };
  }
  return { ...config, fetchRecords, normalizeRecord };
}

module.exports = { createIcsSource, parseCalendar, parseIcsDate, localDateFor };
