const cheerio = require("cheerio");
const { publicUrl, plainText, contentLinks, contentDigest, requestText } = require("./common");
const ORIGIN = "https://straykids.jype.com";
const key = "jype-notice";
function parseListing(html) {
  const $ = cheerio.load(html);
  const entries = new Map();
  $('a[href*="/notice/"]').each((_, element) => {
    const link = publicUrl($(element).attr("href"), ORIGIN);
    if (!link) return;
    const url = new URL(link);
    const id = url.pathname.match(/^\/notice\/([A-Za-z0-9_-]+)\/?$/)?.[1];
    if (url.origin !== ORIGIN || !id) return;
    entries.set(id, {
      id, url: ORIGIN + "/notice/" + id,
      aliases: [link],
      title: $(element).find(".tit, .tit_m").first().text().trim(),
      publishedAt: $(element).find(".date").first().text().match(/\d{4}-\d{2}-\d{2}/)?.[0] || null,
      noticeNumber: url.searchParams.get("NoticeNumber"),
    });
  });
  if (!entries.size) throw new Error("notice_listing_shape_changed");
  return [...entries.values()];
}
function parseDetail(html, entry) {
  const $ = cheerio.load(html);
  $("script,style,noscript,header,footer").remove();
  const root = $(".noticeDetail, .noticeView, .notice_view, .notice-detail, .view_cont, .view_con").first();
  // Read one content representation to avoid duplicate desktop/mobile text.
  const body = $(".boardView_cont .article-content, .boardView_cont_m .article-content, .nc_cont, .notice_content").first();
  const content = body.length ? body : root;
  if (!content.length) throw new Error("notice_detail_shape_changed");
  const links = contentLinks(content.html(), entry.url);
  const images = [...new Set(content.find("img").map((_, el) => publicUrl($(el).attr("src"), entry.url)).get().filter(Boolean))].sort();
  const title = entry.title || $(".title, .tit").filter((_, el) => $(el).text().trim()).first().text().trim() || "JYPE announcement";
  return {
    ...entry, title, summary: plainText(content.html()).slice(0, 6000),
    metadata: { noticeNumber: entry.noticeNumber, images, links, bodyHash: contentDigest(plainText(content.html())) },
  };
}
async function fetchItems({ source, since, fetchImpl }) {
  const items = [];
  const seen = new Set();
  let cursor = source.cursor;
  let complete = false;
  for (let page = 1; page <= 20; page++) {
    const result = await requestText(ORIGIN + "/notice?PgIndex=" + page, { fetchImpl });
    const entries = parseListing(result.text);
    cursor ||= entries[0].id;
    if (page === 1) cursor = entries[0].id;
    let reachedBoundary = entries.every((entry) => entry.publishedAt && entry.publishedAt < since.slice(0, 10));
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (entry.publishedAt && entry.publishedAt < since.slice(0, 10)) {
        continue;
      }
      const detail = await requestText(entry.url, { fetchImpl });
      items.push(parseDetail(detail.text, entry));
    }
    // Always revisit the overlapping recent items, even when the first one is known.
    if (reachedBoundary) { complete = true; break; }
  }
  return { items, cursor, limitation: complete ? null : "Notice page limit reached; requested history may be incomplete." };
}
module.exports = { key, accountId: "straykids", url: ORIGIN + "/notice", parseListing, parseDetail, fetchItems };
