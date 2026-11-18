const cheerio = require("cheerio");
const { createHash } = require("node:crypto");
const ALLOWED_HOSTS = new Set(["straykids.jype.com", "www.sonymusic.co.jp", "www.youtube.com"]);
const MAX_BYTES = 2 * 1024 * 1024;
function publicUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(name)) url.searchParams.delete(name);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}
function plainText(html) {
  const $ = cheerio.load(String(html || ""));
  $("script,style,noscript").remove();
  $("br").replaceWith(" ");
  $("p,div,li").append(" ");
  return $.root().text().normalize("NFC").replace(/\s+/gu, " ").trim();
}
function contentDigest(text) {
  return createHash("sha256").update(String(text).normalize("NFC").replace(/\s+/gu, " ").trim()).digest("hex");
}
function contentLinks(html, base) {
  const $ = cheerio.load(String(html || ""));
  const values = [
    ...$("a[href]").map((_, el) => $(el).attr("href")).get(),
    ...($.root().text().match(/https?:\/\/[^\s<>"']+/g) || []),
  ];
  return [...new Set(values.map((value) => publicUrl(value, base)).filter(Boolean))].sort();
}
function workBudget({ requests = 12, milliseconds = 10000 } = {}) {
  return { remaining: requests, deadline: Date.now() + milliseconds };
}
async function requestText(value, { fetchImpl = globalThis.fetch, headers = {}, budget } = {}) {
  let url = value;
  for (let redirects = 0; redirects <= 4; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname) || parsed.username || parsed.password) {
      throw new Error("blocked_source_destination");
    }
    if (budget && (budget.remaining <= 0 || Date.now() >= budget.deadline)) throw new Error("source_budget_exhausted");
    if (budget) budget.remaining--;
    const response = await fetchImpl(url, {
      redirect: "manual", signal: AbortSignal.timeout(budget ? Math.max(1, Math.min(3000, budget.deadline - Date.now())) : 15000),
      headers: { "user-agent": "Harmony-SKZ-Radar/1.0", accept: "text/html,application/xml,application/json", ...headers },
    });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      url = new URL(response.headers.get("location"), url).href;
      continue;
    }
    if (response.status === 304) return { status: 304 };
    if (!response.ok) {
      const error = new Error("source_http_" + response.status);
      const delay = response.headers.get("retry-after");
      const seconds = Number(delay);
      error.retryAfterMs = delay ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(delay) - Date.now()) : 0;
      throw error;
    }
    if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("source_response_too_large");
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > MAX_BYTES) throw new Error("source_response_too_large");
      chunks.push(Buffer.from(chunk));
    }
    return {
      text: Buffer.concat(chunks).toString("utf8"), status: response.status,
      etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified"),
    };
  }
  throw new Error("source_redirect_limit");
}
function conditionalHeaders(source) {
  const headers = {};
  if (source.etag) headers["if-none-match"] = source.etag;
  if (source.last_modified) headers["if-modified-since"] = source.last_modified;
  return headers;
}
module.exports = { workBudget, publicUrl, plainText, contentLinks, contentDigest, requestText, conditionalHeaders };
