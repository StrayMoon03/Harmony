const { getDb } = require("../db/sqlite");
const radarStore = require("../stores/radarStore");
const translation = require("./radarTranslationService");
const translationCache = require("../stores/radarTranslationStore");
const { preview, clip } = require("./radarPresentation");
const { classifyObservation } = require("./radarClassification");
const { escapeMarkdown } = require("discord.js");

const FOREIGN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
function sourceUrl(candidate) {
  try {
    const url = new URL(candidate.source_url);
    return url.protocol === "https:" && !url.username && !url.password && url.href.length <= 512 ? url.href : null;
  } catch { return null; }
}
function translationSource(candidate, create = false) {
  const db = getDb();
  const identityUrl = candidate.source_url || `urn:harmony:calendar-candidate:${candidate.guild_id}:${candidate.id}`;
  // Handoffs retain at most 6,000 summary characters; observations may retain
  // the whole article. Reuse the same source only when its actual bounded
  // translation input matches, including timing evidence and input version.
  const inputHash = translationCache.identity({ title: candidate.title || "", summary: candidate.submitted_note || "" }).inputHash;
  const existing = db.prepare(`SELECT o.* FROM radar_observations o
    WHERE o.canonical_url=? AND o.title=? ORDER BY o.id`)
    .all(identityUrl, candidate.title || "").find(observation => translationCache.identity(observation).inputHash === inputHash);
  if (existing || !create) return existing || null;
  const now = new Date().toISOString();
  // A translation-only observation uses the existing cache/lease infrastructure.
  // It is not a Radar discovery or a new monitored/official account.
  db.prepare(`INSERT OR IGNORE INTO radar_sources(guild_id,provider,account_id,source_url,authority,enabled,account_metadata)
    VALUES(?,'calendar-review',?,?,'unverified',0,'{}')`)
    .run(candidate.guild_id, String(candidate.id), candidate.source_url || "");
  const source = db.prepare("SELECT * FROM radar_sources WHERE guild_id=? AND provider='calendar-review' AND account_id=?")
    .get(candidate.guild_id, String(candidate.id));
  return radarStore.ingest(source, { id: String(candidate.id), url: identityUrl,
    title: candidate.title || "", summary: candidate.submitted_note || "", metadata: { calendarCandidateId: candidate.id } }, null, now).observation;
}
function clearlyEnglish(candidate) {
  const text = clip(candidate.title || "", 500) + " " + preview(candidate.submitted_note || "", candidate.title || "", 400);
  return !FOREIGN.test(text) && (text.match(/\b(?:the|this|is|will|with|for|and|from|available|of|to)\b/gi) || []).length >= 3 &&
    !/[^\x00-\x7F]/.test(text.replace(/[’‘“”·—–…]/g, ""));
}
function currentTranslation(candidate) {
  const source = translationSource(candidate);
  const current = source ? translation.current(source) : null;
  if (current?.status === "ready" || current?.status === "skipped") return current;
  // The observation may since have been edited. A completed translation of the
  // exact bounded candidate input is still reusable; source URL and the
  // versioned input hash must match. No extra source text is sent to Azure.
  const identity = translationCache.identity({ title: candidate.title || "", summary: candidate.submitted_note || "" });
  return getDb().prepare(`SELECT t.* FROM radar_translations t JOIN radar_observations o ON o.id=t.observation_id
    WHERE o.canonical_url=? AND t.input_hash=? AND t.status='ready' AND t.provider IN ('azure','google')
    ORDER BY t.updated_at DESC LIMIT 1`).get(candidate.source_url || "", identity.inputHash) || current;
}
function translationUseful(candidate) {
  const current = currentTranslation(candidate);
  if (current?.status === "ready" || current?.status === "skipped") return false;
  return !clearlyEnglish(candidate);
}
function englishDate(value) {
  const date = new Date(value + "T00:00:00Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(date)
    : "Not confirmed";
}
function view(candidate) {
  let metadata = {}, provenance = [];
  try { metadata = JSON.parse(candidate.source_metadata || "{}"); } catch { /* Optional metadata. */ }
  try { provenance = JSON.parse(candidate.source_provenance || "[]"); } catch { /* Optional evidence. */ }
  if (!Array.isArray(provenance)) provenance = [];
  const providers = new Set([candidate.source_provider, ...provenance.map(source => source.provider)]);
  const youtube = providers.has("youtube-uploads");
  const names = { "youtube-uploads": "Official Stray Kids YouTube", "jype-notice": "JYPE Notice", "sony-info": "Sony Music Japan", "jype-straykids-schedule": "JYP Official", "stray-kids-comeback-guide": "SKZ Comeback Guide" };
  const identities = [...new Set(provenance.map(source => names[source.provider] || source.sourceName).filter(name => name && !/^[a-z]+(?:-[a-z]+)+$/.test(name)))];
  const sourceName = identities.join(" + ") || names[candidate.source_provider] || (sourceUrl(candidate) ? new URL(sourceUrl(candidate)).hostname : "Identity not confirmed");
  const category = classifyObservation({ provider: youtube ? "youtube-uploads" : candidate.source_provider }, { title: candidate.title, summary: candidate.submitted_note || "", url: candidate.source_url }).category;
  const { CALENDAR_CATEGORIES, CALENDAR_CATEGORY_LABELS } = require("./eventSchedulerService");
  const type = candidate.source_type === "radar_handoff" && CALENDAR_CATEGORIES.includes(metadata.calendarCategory) ? CALENDAR_CATEGORY_LABELS[metadata.calendarCategory] : youtube ? "YouTube / Content" : ({ "New Content": "Video / Content", Unknown: "Not confirmed" }[category] || category);
  let time = metadata.allDay === true && !candidate.proposed_event_at ? "All Day" : "Not confirmed";
  if (candidate.proposed_event_at && candidate.proposed_event_timezone) {
    try { time = new Intl.DateTimeFormat("en-GB", { timeZone: candidate.proposed_event_timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(candidate.proposed_event_at)) + " (" + candidate.proposed_event_timezone + ")"; } catch { /* Do not invent timing. */ }
  }
  const current = currentTranslation(candidate);
  const translated = current?.status === "ready" && Boolean(current.translated_title);
  const original = preview(candidate.submitted_note || "", candidate.title || "", 300);
  const explanation = translated ? current.translated_title + ". " + preview(current.translated_summary || "", current.translated_title, 300)
    : FOREIGN.test(original) ? "English explanation available through Translate to English. See Original Source for the announcement."
    : original || "No additional description supplied. See Original Source for details.";
  const safe = (value, limit) => clip(escapeMarkdown(String(value || "")), limit);
  // The existing approval modal accepts 120 title characters. Preview exactly
  // that prefilled value rather than a longer title it would silently shorten.
  return { content: ["📅 **CALENDAR PREVIEW**", "", `**${safe(candidate.title ? candidate.title.slice(0, 120) : "Title not confirmed", 500)}**`,
    ...(candidate.title?.length > 120 ? ["Title shortened to the calendar confirmation limit; you can edit it before adding."] : []), "",
    `Date: ${englishDate(candidate.proposed_event_date)}${candidate.proposed_event_end_date ? " – " + englishDate(candidate.proposed_event_end_date) : ""}`,
    `Time: ${time}`, `Type: ${type}`, "", "**What this is:**", safe(explanation, 420), "",
    `Source: ${safe(sourceName, 180)}`, ...(translated ? ["Machine translated to English. Calendar title above remains unchanged."] : []),
    "Awaiting approval. Nothing is published yet."].join("\n"), useful: translationUseful(candidate) };
}
async function requestTranslation(candidate) {
  const complete = currentTranslation(candidate);
  if (complete?.status === "ready") return { ...complete, message: "English explanation ready (cached)." };
  if (clearlyEnglish(candidate)) return { status: "skipped", message: "This candidate already appears to be English." };
  const source = translationSource(candidate, true);
  const result = await translation.request(source);
  return { ...result, message: result.status === "ready" ? "English explanation ready."
    : result.status === "skipped" ? "This candidate already appears to be English."
    : result.error === "translator_free_quota_exhausted" ? "Free translation allowance exhausted."
    : result.status === "pending" ? "Translation is already in progress."
    : result.status === "unavailable" ? "Translation not configured."
    : "Translation unavailable. Original candidate remains unchanged." };
}
module.exports = { sourceUrl, translationSource, translationUseful, currentTranslation, view, requestTranslation };
