const dns = require("node:dns").promises;
const net = require("node:net");

const HTML_ENTITY_MAP = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const nativeFetch = globalThis.fetch;
const TIMEZONE_ALIASES = {
  UTC: "UTC", GMT: "UTC", KST: "Asia/Seoul", JST: "Asia/Tokyo",
  ET: "America/New_York", EST: "America/New_York", EDT: "America/New_York",
  CT: "America/Chicago", CST: "America/Chicago", CDT: "America/Chicago",
  MT: "America/Denver", MST: "America/Denver", MDT: "America/Denver",
  PT: "America/Los_Angeles", PST: "America/Los_Angeles", PDT: "America/Los_Angeles",
  BST: "Europe/London", CET: "Europe/Paris", CEST: "Europe/Paris",
};
const WEEKDAYS = { SUN: 0, SUNDAY: 0, MON: 1, MONDAY: 1, TUE: 2, TUESDAY: 2, WED: 3, WEDNESDAY: 3, THU: 4, THURSDAY: 4, FRI: 5, FRIDAY: 5, SAT: 6, SATURDAY: 6 };

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (_, name) => HTML_ENTITY_MAP[name.toLowerCase()] || `&${name};`)
    .replace(/\s+/g, " ").trim();
}

function firstMeta(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i"));
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return null;
}

function jsonLdBlocks(html) {
  return [...String(html || "").matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .flatMap((match) => { try { return [JSON.parse(match[1].trim())]; } catch { return []; } });
}

function asEvent(value) {
  if (!value || typeof value !== "object") return null;
  if (String(value["@type"] || "").toLowerCase().split(/\s*,\s*/).includes("event")) return value;
  if (Array.isArray(value["@graph"])) return value["@graph"].find(asEvent) || null;
  return null;
}

function validTimezone(value) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date()); return true; } catch { return false; }
}

function timezoneFromText(value) {
  const match = String(value || "").match(/\b(UTC|GMT|KST|JST|ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|BST|CET|CEST)\b/i);
  if (!match) return null;
  const mapped = TIMEZONE_ALIASES[match[1].toUpperCase()];
  return mapped && validTimezone(mapped) ? mapped : null;
}

function toYear(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return null;
  if (String(value).length === 2) return 2000 + number;
  return String(value).length === 4 ? number : null;
}

function dateParts(year, month, day) {
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : null;
}

function weekdayMatches(date, weekday) {
  return !weekday || new Date(`${date}T00:00:00Z`).getUTCDay() === weekday;
}

function inferYear(month, day, weekday, contextYear) {
  if (contextYear) return dateParts(contextYear, month, day) && weekdayMatches(dateParts(contextYear, month, day), weekday) ? contextYear : null;
  if (!weekday) return null;
  const currentYear = new Date().getUTCFullYear();
  const candidates = [];
  for (let year = currentYear - 1; year <= currentYear + 2; year++) {
    const date = dateParts(year, month, day);
    if (date && weekdayMatches(date, weekday)) candidates.push(year);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function parseDateToken(yearText, monthText, dayText, weekdayText, contextYear) {
  const year = yearText ? toYear(yearText) : inferYear(Number(monthText), Number(dayText), weekdayText, contextYear);
  const date = year ? dateParts(year, Number(monthText), Number(dayText)) : null;
  return date && weekdayMatches(date, weekdayText) ? { date, year, month: Number(monthText), day: Number(dayText) } : null;
}

function parseTextDates(text) {
  const value = decodeHtml(text).replace(/[‐‑‒–—―]/g, "-");
  const range = value.match(/(?:^|[^\d])((?:\d{2}|\d{4})[./-]\d{1,2}[./-]\d{1,2})\s*(?:([A-Za-z]{3,9}))?\s*(?:-|~|to)\s*((?:(?:\d{2}|\d{4})[./-])?\d{1,2}[./-]\d{1,2})\s*(?:([A-Za-z]{3,9}))?/i);
  if (range) {
    const first = range[1].split(/[./-]/);
    const second = range[3].split(/[./-]/);
    const start = parseDateToken(first.length === 3 ? first[0] : null, first.length === 3 ? first[1] : first[0], first.length === 3 ? first[2] : first[1], WEEKDAYS[String(range[2] || "").toUpperCase()], null);
    if (!start) return {};
    const endHasYear = second.length === 3;
    let endYear = endHasYear ? toYear(second[0]) : start.year;
    if (!endHasYear && start.month > Number(second[0])) endYear += 1;
    const end = parseDateToken(endHasYear ? second[0] : null, endHasYear ? second[1] : second[0], endHasYear ? second[2] : second[1], WEEKDAYS[String(range[4] || "").toUpperCase()], endYear);
    return end ? { proposedEventDate: start.date, proposedEventEndDate: end.date } : {};
  }
  const single = value.match(/(?:^|[^\d])((?:\d{4}|\d{2})[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./]\d{1,2}|\d{1,2}\/\d{1,2})\s*(?:([A-Za-z]{3,9}))?/i);
  if (!single) return {};
  const parts = single[1].split(/[./-]/);
  const parsed = parseDateToken(parts.length === 3 ? parts[0] : null, parts.length === 3 ? parts[1] : parts[0], parts.length === 3 ? parts[2] : parts[1], WEEKDAYS[String(single[2] || "").toUpperCase()], null);
  return parsed ? { proposedEventDate: parsed.date } : {};
}

function extractCandidateMetadata(html, sourceUrl) {
  const blocks = jsonLdBlocks(html);
  const event = blocks.map(asEvent).find(Boolean) || null;
  const title = event?.name ? decodeHtml(event.name) : firstMeta(html, ["og:title", "twitter:title"])
    || decodeHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const startDate = typeof event?.startDate === "string" ? event.startDate.trim() : null;
  const endDate = typeof event?.endDate === "string" ? event.endDate.trim() : null;
  let proposedEventAt = null;
  let proposedEventDate = null;
  let proposedEventEndDate = null;
  let proposedEventTimezone = event?.eventSchedule?.scheduleTimezone || event?.scheduleTimezone || event?.timezone || null;
  if (startDate && /^\d{4}-\d{2}-\d{2}/.test(startDate)) {
    proposedEventDate = startDate.slice(0, 10);
    const hasExplicitTime = /T\d{2}:\d{2}/.test(startDate);
    if (hasExplicitTime && !Number.isNaN(new Date(startDate).getTime())) proposedEventAt = new Date(startDate).toISOString();
    if (!proposedEventTimezone && /Z$/i.test(startDate)) proposedEventTimezone = "UTC";
  }
  if (endDate && /^\d{4}-\d{2}-\d{2}/.test(endDate)) proposedEventEndDate = endDate.slice(0, 10);
  if (!proposedEventDate || !proposedEventEndDate) {
    const textDates = parseTextDates(title);
    proposedEventDate ||= textDates.proposedEventDate;
    proposedEventEndDate ||= textDates.proposedEventEndDate;
  }
  if (proposedEventTimezone) proposedEventTimezone = TIMEZONE_ALIASES[String(proposedEventTimezone).toUpperCase()] || proposedEventTimezone;
  if (proposedEventTimezone && !validTimezone(proposedEventTimezone)) proposedEventTimezone = null;
  proposedEventTimezone ||= timezoneFromText(title);
  const parsed = new URL(sourceUrl);
  return {
    title: title || null, proposedEventAt, proposedEventDate: proposedEventDate || null,
    proposedEventEndDate: proposedEventEndDate || null, proposedEventTimezone: proposedEventTimezone || null,
    sourceProvider: parsed.hostname.toLowerCase(), sourceMetadata: event ? "json-ld-event" : (title ? "page-title" : null),
  };
}

function ipv4Number(value) { return value.split(".").reduce((number, part) => number * 256 + Number(part), 0); }
function isProhibitedIp(value) {
  const version = net.isIP(value);
  if (version === 4) {
    const n = ipv4Number(value);
    return n === 0 || (n >>> 24) === 127 || (n >>> 24) === 10 || (n >= 0xAC100000 && n <= 0xAC1FFFFF) || (n >= 0xC0A80000 && n <= 0xC0A8FFFF) || (n >= 0xA9FE0000 && n <= 0xA9FEFFFF) || (n >= 0x64400000 && n <= 0x647FFFFF) || (n >= 0xC6120000 && n <= 0xC613FFFF) || (n >>> 24) >= 224;
  }
  if (version === 6) {
    const normalized = value.toLowerCase();
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isProhibitedIp(mapped[1]);
    const mappedHex = normalized.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return isProhibitedIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return false;
  }
  return true;
}

async function validateFetchUrl(value, { lookupImpl = dns.lookup, skipDnsResolution = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error("blocked-destination"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error("blocked-destination");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname) && isProhibitedIp(hostname)) throw new Error("blocked-destination");
  if (!skipDnsResolution) {
    let addresses;
    try { addresses = await lookupImpl(hostname, { all: true, verbatim: true }); } catch { throw new Error("blocked-destination"); }
    if (!addresses?.length || addresses.some((entry) => isProhibitedIp(entry.address))) throw new Error("blocked-destination");
  }
  return url;
}

async function readBoundedResponse(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response?.headers?.get?.("content-length") || 0);
  if (declared > maxBytes) throw new Error("response-too-large");
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); throw new Error("response-too-large"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock?.(); }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("response-too-large");
  return text;
}

async function enrichCalendarCandidate(sourceUrl, { fetchImpl = globalThis.fetch, timeoutMs = 5000, lookupImpl = dns.lookup } = {}) {
  if (typeof fetchImpl !== "function") return { metadata: {}, error: "fetch-unavailable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const testFetch = fetchImpl !== nativeFetch && lookupImpl === dns.lookup;
  try {
    let current = await validateFetchUrl(sourceUrl, { lookupImpl, skipDnsResolution: testFetch });
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const response = await fetchImpl(current.toString(), { redirect: "manual", headers: { accept: "text/html,application/xhtml+xml,application/ld+json", "user-agent": "Harmony calendar candidate review" }, signal: controller.signal });
      if (response?.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.("location");
        if (!location || redirects === MAX_REDIRECTS) return { metadata: {}, error: "redirect-blocked" };
        current = await validateFetchUrl(new URL(location, current).toString(), { lookupImpl, skipDnsResolution: testFetch });
        continue;
      }
      if (!response?.ok) return { metadata: {}, error: `http-${response?.status || "unknown"}` };
      const html = await readBoundedResponse(response);
      return { metadata: extractCandidateMetadata(html, sourceUrl), error: null };
    }
    return { metadata: {}, error: "redirect-blocked" };
  } catch (error) {
    return { metadata: {}, error: error?.name === "AbortError" ? "timeout" : error?.message === "response-too-large" ? "response-too-large" : error?.message === "blocked-destination" ? "blocked-destination" : "fetch-failed" };
  } finally { clearTimeout(timer); }
}

module.exports = { extractCandidateMetadata, enrichCalendarCandidate, parseTextDates, isProhibitedIp };
