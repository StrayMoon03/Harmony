const { plainText, publicUrl, contentLinks, contentDigest, requestText, workBudget } = require("./common");
const cheerio = require("cheerio");
const ORIGIN = "https://www.sonymusic.co.jp";
const url = ORIGIN + "/json/v2/artist/StrayKids/information/start/0/count/20";
function parsePage(text) {
  const match = String(text).match(/^\s*callback\(([\s\S]*)\);?\s*$/);
  if (!match) throw new Error("sony_jsonp_wrapper_changed");
  const payload = JSON.parse(match[1]);
  if (!Array.isArray(payload.items) || !Number.isInteger(payload.total_count)) throw new Error("sony_info_shape_changed");
  const items = payload.items.map((entry) => {
    if (!/^\d+$/.test(String(entry.id))) throw new Error("sony_item_identity_missing");
    const id = String(entry.id);
    const article = String(entry.article || "");
    const $ = cheerio.load(article);
    const links = contentLinks(article, ORIGIN);
    const imageValues = Array.isArray(entry.images) ? entry.images : Object.values(entry.images || {});
    const images = [...new Set([
      ...$("img[src]").map((_, el) => publicUrl($(el).attr("src"), ORIGIN)).get(),
      ...imageValues.filter((image) => typeof image === "string").map((image) => publicUrl(image, ORIGIN)),
    ].filter(Boolean))].sort();
    return {
      id, url: ORIGIN + "/artist/StrayKids/info/" + id,
      aliases: ["https://www.straykidsjapan.com/info/archive/?" + id],
      title: plainText(entry.title), summary: plainText(article),
      publishedAt: /^\d{4}\.\d{2}\.\d{2}$/.test(entry.date || "") ? entry.date.replaceAll(".", "-") : null,
      metadata: { sourceCategory: entry.category || null, images, links, bodyHash: contentDigest(plainText(article)) },
    };
  });
  return { items, total: payload.total_count };
}
async function fetchItems({ source, since, fetchImpl, budget = workBudget(), now = new Date().toISOString(), knownIds = new Set() }) {
  const state = source.traversal_state ? JSON.parse(source.traversal_state) : { offset: 0, since, coveredThrough: now, cursor: source.cursor };
  const items = [];
  let complete = false;
  const fetchPage = async (offset) => parsePage((await requestText(ORIGIN + "/json/v2/artist/StrayKids/information/start/" + offset + "/count/20", { fetchImpl, budget })).text);
  try {
    if (state.offset && budget.remaining > 1) {
      const head = await fetchPage(0);
      items.push(...head.items.filter((item) => !knownIds.has(item.id)));
    }
    while (!complete) {
      const page = await fetchPage(state.offset);
      if (state.offset === 0) state.cursor = page.items[0]?.id || state.cursor;
      items.push(...page.items.filter((item) => !item.publishedAt || item.publishedAt >= state.since.slice(0, 10)));
      if (!page.items.length || state.offset + page.items.length >= page.total ||
          page.items.every((item) => item.publishedAt && item.publishedAt < state.since.slice(0, 10))) complete = true;
      state.offset += page.items.length;
    }
  } catch (error) {
    if (error.message !== "source_budget_exhausted" && error.name !== "TimeoutError") throw error;
  }
  return { items, cursor: state.cursor, coveredThrough: state.coveredThrough || now, continuation: complete ? null : JSON.stringify(state),
    limitation: complete ? null : "Sony work budget reached; saved traversal will resume next cycle." };
}
module.exports = { key: "sony-info", accountId: "StrayKids", url, parsePage, fetchItems };
