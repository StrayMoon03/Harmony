const HTML_ENTITY_MAP = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };

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
    .flatMap((match) => {
      try { return [JSON.parse(match[1].trim())]; } catch { return []; }
    });
}

function asEvent(value) {
  if (!value || typeof value !== "object") return null;
  if (String(value["@type"] || "").toLowerCase().split(/\s*,\s*/).includes("event")) return value;
  if (Array.isArray(value["@graph"])) return value["@graph"].find(asEvent) || null;
  return null;
}

function extractCandidateMetadata(html, sourceUrl) {
  const blocks = jsonLdBlocks(html);
  const event = blocks.map(asEvent).find(Boolean) || null;
  const title = event?.name ? decodeHtml(event.name) : firstMeta(html, ["og:title", "twitter:title"])
    || decodeHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const startDate = typeof event?.startDate === "string" ? event.startDate.trim() : null;
  let proposedEventAt = null;
  let proposedEventDate = null;
  let proposedEventTimezone = event?.eventSchedule?.scheduleTimezone || event?.scheduleTimezone || event?.timezone || null;
  if (startDate && /^\d{4}-\d{2}-\d{2}/.test(startDate)) {
    proposedEventDate = startDate.slice(0, 10);
    const hasExplicitTime = /T\d{2}:\d{2}/.test(startDate);
    if (hasExplicitTime && !Number.isNaN(new Date(startDate).getTime())) proposedEventAt = new Date(startDate).toISOString();
    if (!proposedEventTimezone && /Z$/i.test(startDate)) proposedEventTimezone = "UTC";
  }
  const parsed = new URL(sourceUrl);
  return {
    title: title || null,
    proposedEventAt,
    proposedEventDate,
    proposedEventTimezone: proposedEventTimezone || null,
    sourceProvider: parsed.hostname.toLowerCase(),
    sourceMetadata: event ? "json-ld-event" : (title ? "page-title" : null),
  };
}

async function enrichCalendarCandidate(sourceUrl, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (typeof fetchImpl !== "function") return { metadata: {}, error: "fetch-unavailable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(sourceUrl, { headers: { accept: "text/html,application/xhtml+xml,application/ld+json", "user-agent": "Harmony calendar candidate review" }, signal: controller.signal });
    if (!response?.ok) return { metadata: {}, error: `http-${response?.status || "unknown"}` };
    const html = await response.text();
    if (html.length > 2_000_000) return { metadata: {}, error: "response-too-large" };
    return { metadata: extractCandidateMetadata(html, sourceUrl), error: null };
  } catch (error) {
    return { metadata: {}, error: error?.name === "AbortError" ? "timeout" : "fetch-failed" };
  } finally { clearTimeout(timer); }
}

module.exports = { extractCandidateMetadata, enrichCalendarCandidate };
