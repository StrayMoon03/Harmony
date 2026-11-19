const { extractYouTubeId } = require("../modules/media/youtube");

// Classification concerns the announcement's subject, not incidental body links.
// Ticket applications take priority; product preorders are sales, not admissions.
const APPLICATION = /applications? (?:open|start|now|accepted)|apply (?:now|for)|(?:応募|申込|申し込み|抽選|先行|入場|参加|観覧).{0,12}(?:受付|開始|募集)|(?:신청|응모|예매).{0,8}(?:접수|시작|안내)|(?:报名|報名|申请|申請).{0,8}(?:开始|開始|受理)/i;
const TICKETS = /\btickets?\b|ticketing|チケット|티켓|门票|門票|\bvip\b.{0,15}(?:sale|package|registration)/i;
const PREORDER = /pre[- ]?order|予約販売|예약판매|预售|預售/i;
const RESERVATION = /reservations?|予約受付|사전예약/i;
const LIVE_CONTEXT = /concert|event|listening party|fan[- ]?meet|ライブ|公演|イベント|콘서트|공연|행사/i;
const CATEGORY_RULES = [
  ["Pop-up", /pop\s*[-‐‑–—]?\s*up(?: store)?|ポップ.?アップ|팝업|快闪店|快閃店/i],
  ["New Content", /skz[ -]?code|talker|racha[ -]?log|vlog|music video|\bmv\b|making (?:movie|film|video)|behind[- ]the[- ]scenes|dance practice|teaser|ミュージックビデオ|メイキング|ビハインド|뮤직비디오|비하인드|영상|動画|映像/i],
  ["Merch / Sale", /merch|goods|商品|グッズ|굿즈|周边|周邊|pre[- ]?order|予約販売|예약판매|预售|預售/i],
  ["Event", /listening[- ]?party|vr[- ]?(?:live|ライブ|라이브)|リスニング.?パーティ|리스닝.?파티/i],
  ["Release", /\balbum\b|\bsingle\b|\brelease(?:d|s)?\b|song.{0,30}(?:out now|drops)|\bost\b|collab|新曲|リリース|発売|楽曲.{0,12}配信|音源|ソロ.{0,12}配信|신곡|발매|음원|솔로.{0,12}공개|新歌|发行|發行|专辑|專輯/i],
  ["Event", /concert|fan[- ]?meet|world tour|콘서트|팬미팅|公演/i],
  ["Appearance", /broadcast|television|fashion|방송|出演|放送/i],
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
  const title = String(item.title || "").normalize("NFC").replace(/\s+/gu, " ");
  const ticketing = TICKETS.test(title) || APPLICATION.test(title) ||
    (RESERVATION.test(title) && LIVE_CONTEXT.test(title) && !PREORDER.test(title));
  const matched = ticketing ? ["Ticketing", true] : CATEGORY_RULES.find(([, pattern]) => pattern.test(title));
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
