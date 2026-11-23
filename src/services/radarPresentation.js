const { escapeMarkdown } = require("discord.js");
const VERSION = 1;
const SUMMARY_LIMIT = 420;
const TRANSLATION_INPUT_LIMIT = 900;
const normalize = (value) => String(value || "").normalize("NFC").replace(/\s+/gu, " ").trim();
function clip(value, limit) {
  const text = normalize(value);
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "");
  const boundary = prefix.lastIndexOf(" ");
  return (boundary > limit * 0.65 ? prefix.slice(0, boundary) : prefix) + "…";
}
function withoutUrls(value) {
  return normalize(String(value || "").replace(/https?:\/\/[^\s<>]+|www\.[^\s<>]+/giu, ""));
}
// Presentation-only cleanup. The stored observation is never rewritten.
function cleanTitle(value) {
  return normalize(withoutUrls(value).replace(/#[\p{L}\p{N}_]+/gu, ""));
}
function cleanContent(body, title = "") {
  let text = String(body || "").normalize("NFC")
    .replace(/https?:\/\/[^\s<>]+|www\.[^\s<>]+/giu, "")
    .replace(/#[\p{L}\p{N}_]+/gu, "");
  text = text.replace(/(^|[。！？!?\n.])[^。！？!?\n.]*legal boilerplate[^。！？!?\n.]*/gi, "$1");
  const stop = /(?:【|\[)?(?:track\s*list|disc\s*[12]|収録(?:曲|内容)|商品詳細|応募方法|応募条件|注意事項|利用規約|트랙리스트|유의사항|曲目列表|申请须知|申請須知|terms and conditions|application instructions|legal boilerplate)(?:】|\])?/i.exec(text);
  if (stop) text = text.slice(0, stop.index);
  // These prompts are distribution boilerplate, not announcement evidence.
  text = text.replace(/(?:subscribe(?: to)?|follow us|connect with|listen (?:here|now)|stream (?:here|now)|watch (?:here|now)|구독|フォロー|チャンネル登録)[^。！？!?\n]*(?:[。！？!?]|$)/gi, "");
  text = normalize(text);
  const heading = normalize(title);
  if (heading && text.startsWith(heading)) text = text.slice(heading.length).replace(/^[\s:：—–-]+/u, "");
  return normalize(text);
}
function preview(body, title = "", limit = SUMMARY_LIMIT) {
  const sentences = cleanContent(body, title).split(/(?<=[。！？!?])\s*|(?<=[.!?])\s+(?=[\p{Lu}\p{Script=Han}\p{Script=Hangul}])/u)
    .map(normalize).filter(Boolean).filter(part => part !== normalize(title));
  const unique = [...new Set(sentences)];
  const dated = unique.slice(1).find(part => part.length <= 300 && /\d{4}[年./-]|\d{1,2}[月월]|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(part));
  return clip([unique[0], dated || unique[1]].filter(Boolean).join(" "), limit);
}
// Explicitly labelled source evidence only: no inferred year, time zone or calendar fields.
function translationTimingEvidence(text) {
  const dates = /(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|(?:\d{4}年)?\d{1,2}月\d{1,2}日|\d{1,2}월\s*\d{1,2}일)(?:\s*\d{1,2}:\d{2}\s*(?:AM|PM|JST|KST|UTC)?)?|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+\d{4})?(?:\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:AM|PM|JST|KST|UTC)?)?/gi;
  const labels = [
    ["Application closes", /applications? (?:close|end)|応募締切|申込締切|受付終了|신청 마감/i],
    ["Application opens", /applications? (?:open|start)|受付開始|신청 시작/i],
    ["Deadline", /deadline|締切|마감/i],
    ["Release", /release(?: date|s|d)?|発売|リリース|발매/i],
    ["Event", /event(?: date)?|concert|listening party|開催|公演|공연/i],
  ];
  const result = [];
  for (const sentence of String(text || "").slice(0, 20000).replace(/https?:\/\/[^\s<>]+/giu, "").split(/[。！？!?;；\n]|\.(?=\s|$)/u)) {
    if (/published|posted|publication|掲載日|投稿日|公開日/i.test(sentence)) continue;
    const matches = labels.filter(([, pattern]) => pattern.test(sentence));
    // A deadline is an application close, not a second independent meaning.
    const meanings = matches.filter(([label]) => label !== "Deadline" || !matches.some(([other]) => other === "Application closes"));
    const label = meanings.length === 1 ? meanings[0] : null;
    const found = sentence.match(dates);
    if (label && found?.length === 1 && sentence.length <= 350) {
      const value = label[0] + ": " + found.join(" → ");
      if (!result.includes(value)) result.push(value);
    }
    if (result.length === 3) break;
  }
  return result;
}
// Display-only semantics. Keep the legacy translation evidence above byte-stable:
// changing that request input would invalidate already-completed translations.
function candidateTiming(text) {
  const dates = /(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|(?:\d{4}年)?\d{1,2}月\d{1,2}日|\d{1,2}월\s*\d{1,2}일)(?:\s*\d{1,2}:\d{2}\s*(?:AM|PM|JST|KST|UTC)?)?|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+\d{4})?(?:\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:AM|PM|JST|KST|UTC)?)?/gi;
  const result = [];
  for (const sentence of String(text || "").slice(0, 20000).replace(/https?:\/\/[^\s<>]+/giu, "").split(/[。！？!?;；\n]|\.(?=\s|$)/u)) {
    if (sentence.length > 350 || /published|posted|publication|掲載日|投稿日|公開日/i.test(sentence)) continue;
    const found = sentence.match(dates);
    if (found?.length !== 1) continue;
    const deadline = /\b(?:deadlines?|due|closes?|ends?|until|by|before)\b|締切|期限|受付終了|まで|마감|까지/i.test(sentence);
    const application = /\b(?:applications?|apply|applicants?)\b|応募|申込|申し込み|受付|신청|응모/i.test(sentence);
    const registration = /\bregistrations?\b|登録/i.test(sentence);
    const preorder = /\bpre[- ]?orders?\b|予約販売|예약판매/i.test(sentence);
    const order = /\borders?\b|注文|주문/i.test(sentence);
    const tickets = /\btickets?\b|ticketing|チケット|티켓/i.test(sentence);
    const subjects = [application && "Application", registration && "Registration", (preorder || order) && (preorder ? "Preorder" : "Order")].filter(Boolean);
    if (!subjects.length && tickets) subjects.push("Ticket sales");
    let label;
    if (deadline && subjects.length === 1) label = subjects[0] + " deadline";
    else if (subjects.length > 1) continue;
    else if (subjects.length) {
      if (/\b(?:opens?|starts?|begins?)\b|on sale|受付開始|신청 시작/i.test(sentence)) label = subjects[0] + (subjects[0] === "Ticket sales" ? " open" : " opens");
      else continue; // Mentioning an application for an event proves no event date.
    } else if (deadline) {
      if (/\b(?:deadlines?|due)\b|締切|期限|마감/i.test(sentence)) label = "Deadline";
      else continue;
    }
    else {
      const content = /\b(?:video|content|episode|music video)\b.{0,20}\bpremieres?\b/i.test(sentence);
      const release = content || /\brelease(?: date|s|d)?\b|発売|リリース|발매/i.test(sentence);
      // An incidental 'event' noun is insufficient: require explicit date/held/on
      // wording. Do not resolve two competing meanings or multiple dates.
      const event = /\b(?:event|concert|listening party)\b(?:\s*:|\s+date\b|.{0,30}\b(?:on|held|takes place|scheduled)\b)|開催|公演|공연/i.test(sentence);
      if (release && /\b(?:event|concert|listening party)\b|開催|公演|공연/i.test(sentence)) continue;
      if (release && !event) label = content ? "Content release" : "Release";
      else if (event && !release) label = "Event";
    }
    if (!label) continue;
    const value = label + ": " + found[0];
    if (!result.includes(value)) result.push(value);
    if (result.length === 3) break;
  }
  return result;
}
function formatDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(value + "T00:00:00Z");
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) {
      // A source date without a time zone must not move to the previous day.
      return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
    }
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? `<t:${Math.floor(time / 1000)}:f>` : null;
}
function cardText(value, limit) {
  const clean = withoutUrls(value).replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, (stamp) => {
    const time = Date.parse(stamp);
    return Number.isFinite(time) ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(time) + " UTC" : "";
  });
  return clip(escapeMarkdown(clean), limit);
}
function primarySource(discovery, sources) {
  return sources.find((item) => item.active !== 0 && item.title === discovery.title) ||
    sources.find((item) => item.active !== 0) || sources[0];
}
function translationInput(source) {
  const summary = preview(source.summary, source.title, TRANSLATION_INPUT_LIMIT);
  const timing = translationTimingEvidence(source.title + "\n" + source.summary).filter(value => !summary.includes(value.slice(value.indexOf(": ") + 2))).join("; ");
  // Reserve bounded space for already identified evidence; never translate the
  // full article to find a date, infer a year or write calendar fields.
  const evidence = timing ? "\n" + timing : "";
  return { title: clip(cleanTitle(source.title), 500), summary: clip(summary, TRANSLATION_INPUT_LIMIT - evidence.length) + evidence };
}
function cardView(discovery, source, translation, options = {}) {
  const originalTitle = source?.title || discovery.title;
  const originalSummary = source?.summary || discovery.summary;
  const foreign = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Han}]/u;
  const translated = translation?.status === "ready" && Boolean(translation.translated_title);
  const needsTranslation = foreign.test(originalTitle + " " + preview(originalSummary, originalTitle)) || options.translationUseful === true;
  let title = cleanTitle(translated ? translation.translated_title : originalTitle);
  let summary = translated ? preview(translation.translated_summary, title) : preview(originalSummary, title);
  let language = null;
  if (translated) language = "Machine translated to English · " + ({ google: "Google Cloud Translation", azure: "Azure Translator" }[translation.provider] || "Translation");
  else if (needsTranslation) {
    const unconfigured = ["disabled", "azure-missing-key"].includes(translation?.provider) || (!translation && options.translationConfigured === false);
    const pending = translation?.status === "pending" && Date.parse(translation.lease_until) > Date.now();
    language = translation?.error === "translator_free_quota_exhausted" ? "Free translation allowance exhausted"
      : unconfigured ? "Translation not configured" : pending ? "Translation pending"
      : !translation ? "English translation available on request" : "Translation failed/unavailable";
    if (foreign.test(title)) title = "Official announcement · " + discovery.category;
    summary = "Open the official source for the original announcement and complete details.";
  }
  const timingText = translated ? translation.translated_title + "\n" + translation.translated_summary : originalTitle + "\n" + originalSummary;
  let timing = candidateTiming(timingText);
  // Older translation inputs may contain an appended, synthesized Event label.
  // It is not independent evidence: require the stricter original-source check
  // to corroborate that label before displaying translated Event timing.
  if (translated && translation.input_summary?.includes("\n")) {
    const suppliedEvents = translation.input_summary.split("\n").slice(1).join("; ").split("; ").filter(line => line.startsWith("Event: "));
    const originalTiming = candidateTiming(originalTitle + "\n" + originalSummary);
    if (suppliedEvents.some(line => !originalTiming.includes(line))) timing = timing.filter(line => !line.startsWith("Event: "));
  }
  return { title: cardText(title, 256) || "Official announcement",
    summary: cardText(summary, SUMMARY_LIMIT) || "Open the original announcement for complete details.",
    language, needsTranslation, translated, timing };
}
module.exports = { VERSION, SUMMARY_LIMIT, TRANSLATION_INPUT_LIMIT, normalize, clip, cleanTitle, cleanContent, preview, candidateTiming, formatDate, cardText, primarySource, translationInput, cardView };
