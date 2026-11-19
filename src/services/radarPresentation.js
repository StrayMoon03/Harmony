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
function preview(body, title = "", limit = SUMMARY_LIMIT) {
  let text = withoutUrls(body);
  // Keep source facts, not track lists or the ensuing legal/application manual.
  const boilerplate = /(?:【|\[)?(?:track\s*list|disc\s*[12]|収録(?:曲|内容)|商品詳細|応募方法|応募条件|注意事項|利用規約|트랙리스트|유의사항|曲目列表|申请须知|申請須知)(?:】|\])?/i.exec(text);
  if (boilerplate) text = text.slice(0, boilerplate.index).trim();
  const sentences = text.split(/(?<=[。！？!?])\s*|(?<=[.!?])\s+(?=[\p{Lu}\p{Script=Han}\p{Script=Hangul}])/u)
    .map(normalize).filter(Boolean).filter((part) => part !== normalize(title));
  if (!sentences.length) return "";
  const first = sentences[0];
  // Select at most one further sentence. Preserve its context; never extract a
  // bare date and relabel it as an event/release date.
  const dated = sentences.slice(1).find((part) => part.length <= 300 && /\d{4}[年./-]|\d{1,2}[月월]|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(part));
  return clip([first, dated || sentences[1]].filter(Boolean).join(" "), limit);
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
  return { title: clip(withoutUrls(source.title), 500), summary: preview(source.summary, source.title, TRANSLATION_INPUT_LIMIT) };
}
function cardView(discovery, source, translation) {
  const translated = translation?.status === "ready";
  const title = translated ? translation.translated_title : source?.title || discovery.title;
  const summary = translated ? translation.translated_summary : preview(source?.summary || discovery.summary, title);
  const language = translated ? "Machine translated to English · " + (translation.provider === "azure" ? "Azure Translator" : "Translation")
    : translation?.status === "skipped" ? null
      : translation?.status === "pending" ? "English translation pending · Original source text"
      : translation?.status ? "English translation unavailable · Original source text"
        : /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Han}]/u.test(title + " " + summary)
          ? "English translation pending · Original source text" : null;
  return {
    title: cardText(title, 256) || "Source announcement",
    summary: cardText(summary, SUMMARY_LIMIT) || "Open the original announcement for complete details.",
    language,
    originalTitle: translated && normalize(title) !== normalize(source?.title) ? cardText(source.title, 180) : null,
  };
}
module.exports = { VERSION, SUMMARY_LIMIT, TRANSLATION_INPUT_LIMIT, normalize, clip, preview, formatDate, cardText, primarySource, translationInput, cardView };
