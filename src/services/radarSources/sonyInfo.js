const { plainText, publicUrl, contentLinks, contentDigest, requestText } = require("./common");
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
      title: plainText(entry.title), summary: plainText(article).slice(0, 6000),
      publishedAt: /^\d{4}\.\d{2}\.\d{2}$/.test(entry.date || "") ? entry.date.replaceAll(".", "-") : null,
      metadata: { sourceCategory: entry.category || null, images, links, bodyHash: contentDigest(plainText(article)) },
    };
  });
  return { items, total: payload.total_count };
}
async function fetchItems({ source, since, fetchImpl }) {
  const items = [];
  let cursor = source.cursor;
  let complete = false;
  for (let offset = 0; offset < 400; offset += 20) {
    const result = await requestText(ORIGIN + "/json/v2/artist/StrayKids/information/start/" + offset + "/count/20", { fetchImpl });
    const page = parsePage(result.text);
    if (offset === 0) cursor = page.items[0]?.id || cursor;
    items.push(...page.items.filter((item) => !item.publishedAt || item.publishedAt >= since.slice(0, 10)));
    if (!page.items.length || offset + page.items.length >= page.total ||
        page.items.every((item) => item.publishedAt && item.publishedAt < since.slice(0, 10))) {
      complete = true;
      break;
    }
  }
  return { items, cursor, limitation: complete ? null : "Sony pagination limit reached; requested history may be incomplete." };
}
module.exports = { key: "sony-info", accountId: "StrayKids", url, parsePage, fetchItems };
