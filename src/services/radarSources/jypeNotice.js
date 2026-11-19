const cheerio = require("cheerio");
const { publicUrl, plainText, contentLinks, contentDigest, requestText, workBudget } = require("./common");
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
    ...entry, title, summary: plainText(content.html()),
    metadata: { noticeNumber: entry.noticeNumber, images, links, bodyHash: contentDigest(plainText(content.html())) },
  };
}
async function revisit(item, { fetchImpl, budget }) {
  const entry = {
    id: item.item_id, url: item.canonical_url, aliases: JSON.parse(item.aliases),
    title: item.title, publishedAt: item.published_at, noticeNumber: JSON.parse(item.metadata).noticeNumber,
  };
  const response = await requestText(entry.url, { fetchImpl, budget });
  return parseDetail(response.text, entry);
}
async function fetchItems({ source, since, fetchImpl, budget = workBudget(), now = new Date().toISOString(), knownIds = new Set() }) {
  const saved = source.traversal_state ? JSON.parse(source.traversal_state) : null;
  const state = saved || { page: 1, pending: [], since, coveredThrough: now, cursor: source.cursor };
  const items = [];
  let complete = false;
  try {
    // A resumed backlog does not hide newly published head items. At most two requests
    // are used here, leaving the rest of this cycle's budget for continuation.
    if (saved && budget.remaining > 2) {
      const head = parseListing((await requestText(ORIGIN + "/notice?PgIndex=1", { fetchImpl, budget })).text);
      const newest = head.find((entry) => !knownIds.has(entry.id));
      if (newest) items.push(parseDetail((await requestText(newest.url, { fetchImpl, budget })).text, newest));
    }
    while (!complete) {
      if (!state.pending.length) {
        const response = await requestText(ORIGIN + "/notice?PgIndex=" + state.page, { fetchImpl, budget });
        const entries = parseListing(response.text);
        if (state.page === 1) state.cursor = entries[0].id;
        if (entries.every((entry) => entry.publishedAt && entry.publishedAt < state.since.slice(0, 10))) {
          complete = true;
          break;
        }
        state.pending = entries.filter((entry) => !entry.publishedAt || entry.publishedAt >= state.since.slice(0, 10));
        state.page++;
      }
      while (state.pending.length) {
        const entry = state.pending[0];
        // Checkpoint advances only after a complete, parsed detail response.
        if (!items.some((item) => item.id === entry.id)) {
          items.push(parseDetail((await requestText(entry.url, { fetchImpl, budget })).text, entry));
        }
        state.pending.shift();
      }
    }
  } catch (error) {
    if (error.message !== "source_budget_exhausted" && error.name !== "TimeoutError") throw error;
  }
  return { items, cursor: state.cursor, coveredThrough: state.coveredThrough || now, continuation: complete ? null : JSON.stringify(state),
    limitation: complete ? null : "Notice work budget reached; saved traversal will resume next cycle." };
}
module.exports = { key, accountId: "straykids", url: ORIGIN + "/notice", parseListing, parseDetail, fetchItems, revisit };
