const { extractYouTubeId } = require("../modules/media/youtube");

const CATEGORY_RULES = [
  ["Ticketing", /ticket|vip|티켓|チケット|先行受付/i],
  ["Pop-up", /pop[- ]?up|팝업|ポップアップ/i],
  ["New Content", /skz[ -]?code|talker|racha[ -]?log|vlog|music video|\bmv\b|dance practice|teaser|영상|公開/i],
  ["Merch / Sale", /merch|pre[- ]?order|goods|skzoo|예약판매|グッズ|予約販売/i],
  ["Release", /album|single|released|\bost\b|collab|발매|発売|配信/i],
  ["Appearance", /broadcast|television|fashion|방송|出演|放送/i],
  ["Event", /concert|fan[ -]?meet|world tour|콘서트|팬미팅|公演/i],
  ["Announcement", /announcement|notice|공지|お知らせ/i],
];
const MEMBERS = [
  ["Bang Chan", /\bbang chan\b|방찬|バンチャン/i],
  ["Lee Know", /\blee know\b|리노|リノ/i],
  ["Changbin", /\bchangbin\b|창빈|チャンビン/i],
  ["Hyunjin", /\bhyunjin\b|현진|ヒョンジン/i],
  ["HAN", /\bhan\b|\bhan jisung\b|ハン/i],
  ["Felix", /\bfelix\b|필릭스|フィリックス/i],
  ["Seungmin", /\bseungmin\b|승민|スンミン/i],
  ["I.N", /\bi\.n\b|아이엔|アイエン/i],
];
function classifyObservation(source, item) {
  const title = String(item.title || "");
  const matched = CATEGORY_RULES.find(([, pattern]) => pattern.test(title));
  const category = source.provider === "youtube-uploads" ? "New Content" : matched?.[0] || "Unknown";
  // Links embedded in an article are supporting evidence, not the article's identity.
  // Only a canonical video URL proves primary video identity in Phase 1A.
  const primaryVideo = extractYouTubeId(item.url);
  const correlationKey = primaryVideo ? "youtube:" + primaryVideo : null;
  const potential = ["Event", "Release", "Appearance", "Ticketing", "Pop-up", "Merch / Sale"].includes(category);
  return {
    category, confidence: matched || source.provider === "youtube-uploads" ? "rule-based" : "uncertain",
    correlationKey, members: MEMBERS.filter(([, pattern]) => pattern.test(title)).map(([name]) => name),
    eligibility: potential ? "Potential" : "Unknown",
    reason: "Owner must confirm the calendar date and any time zone before handoff.",
  };
}
module.exports = { classifyObservation };
