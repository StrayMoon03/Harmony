const cache = require("../stores/radarTranslationStore");
const { clip } = require("./radarPresentation");
const TIMEOUT_MS = 3000;
const RETRY_MS = 60 * 60 * 1000;
const MAX_QUEUE = 100;
async function detectLanguage(text) {
  const letters = text.match(/\p{L}/gu) || [];
  const count = (pattern) => (text.match(pattern) || []).length;
  const cjk = count(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu);
  if (cjk >= 3 && cjk / Math.max(1, letters.length) >= 0.15) {
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "jpn";
    if (/\p{Script=Hangul}/u.test(text)) return "kor";
    return "cmn";
  }
  if (letters.length < 30) return /[^\p{Script=Latin}\p{P}\p{N}\p{S}\p{Z}\s]/u.test(text) ? "und" : "eng";
  const { franc } = await import("franc-min");
  return franc(text, { minLength: 30 });
}
function azureProvider(env = process.env, fetchImpl = globalThis.fetch) {
  if (env.HARMONY_RADAR_TRANSLATION_PROVIDER !== "azure") return { id: "disabled", available: false };
  const key = env.AZURE_TRANSLATOR_KEY;
  const base = env.AZURE_TRANSLATOR_ENDPOINT || "https://api.cognitive.microsofttranslator.com";
  let endpoint;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" ||
        !(url.hostname === "api.cognitive.microsofttranslator.com" || /^[a-z0-9-]+\.cognitiveservices\.azure\.com$/.test(url.hostname))) throw new Error();
    endpoint = new URL(url.hostname === "api.cognitive.microsofttranslator.com" ? "/translate" : "/translator/text/v3.0/translate", url);
    endpoint.search = "api-version=3.0&to=en&textType=plain";
  } catch { return { id: "azure-invalid-endpoint", available: false }; }
  if (!key) return { id: "azure-missing-key", available: false };
  return {
    id: "azure", available: true,
    async translate(input, signal) {
      const texts = [input.title, input.summary].filter(Boolean);
      const response = await fetchImpl(endpoint.href, {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json; charset=UTF-8", "Ocp-Apim-Subscription-Key": key,
          ...(env.AZURE_TRANSLATOR_REGION ? { "Ocp-Apim-Subscription-Region": env.AZURE_TRANSLATOR_REGION } : {}) },
        body: JSON.stringify(texts.map((Text) => ({ Text }))),
      });
      if (!response.ok) {
        const error = new Error("translator_http_" + response.status);
        const retry = response.headers.get("retry-after");
        const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        if (Number.isFinite(delay) && delay > 0 && Number.isFinite(new Date(Date.now() + delay).getTime())) error.retryAfterMs = delay;
        throw error;
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 32768) throw new Error("translator_response_too_large");
        chunks.push(Buffer.from(chunk));
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(data) || data.length !== texts.length) throw new Error("translator_invalid_response");
      const translated = data.map((entry) => entry.translations?.find((value) => value.to === "en")?.text);
      if (translated.some((text) => typeof text !== "string" || !text.trim())) throw new Error("translator_invalid_response");
      return { title: translated[0], summary: translated[1] || "", language: data.find((entry) => entry.detectedLanguage?.language && entry.detectedLanguage.language !== "en")?.detectedLanguage.language || data.at(-1).detectedLanguage?.language || "und" };
    },
  };
}
function createTranslationService({ provider = () => azureProvider(), detector = detectLanguage, timeoutMs = TIMEOUT_MS, clock = Date.now } = {}) {
  const pending = new Map();
  const waiting = [];
  const idle = [];
  const calls = [];
  let active = 0;
  let scheduled = false;
  let cooldown = 0;
  function current(source) {
    try { return cache.get(source, provider().id); } catch { return null; }
  }
  function enqueue(source, callbackKey, onReady) {
    try { enqueueInternal(source, callbackKey, onReady); } catch { /* Enrichment cannot prevent the original card. */ }
  }
  function enqueueInternal(source, callbackKey, onReady) {
    if (!source?.id) return;
    const selected = provider();
    const key = source.id + ":" + cache.identity(source).sourceHash + ":" + selected.id;
    if (pending.has(key)) {
      if (onReady) pending.get(key).callbacks.set(callbackKey, onReady);
      return;
    }
    const row = cache.get(source, selected.id);
    if (row && (["ready", "skipped", "unavailable"].includes(row.status) || Date.parse(row.next_retry_at) > clock() || Date.parse(row.lease_until) > clock())) return;
    if (pending.size >= MAX_QUEUE) return; // Original cards still deliver; next poll can enqueue the remaining work.
    const job = { key, source, selected, callbacks: new Map(onReady ? [[callbackKey, onReady]] : []) };
    pending.set(key, job);
    waiting.push(job);
    schedule();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; pump(); });
  }
  async function run(job) {
    const { source, selected } = job;
    if (!cache.claim(source, selected.id, clock(), timeoutMs + 1000)) return;
    const previous = cache.reusable(source, selected.id);
    if (previous) {
      cache.save(source, selected.id, { status: previous.status, language: previous.original_language,
        title: previous.translated_title, summary: previous.translated_summary }, clock());
      return;
    }
    const input = cache.identity(source).input;
    const controller = new AbortController();
    let timer;
    let detected;
    try {
      const work = (async () => {
        const language = await detector(input.title + ". " + input.summary);
        detected = language;
        if (controller.signal.aborted) throw new Error("translator_timeout");
        if (language === "eng" || language === "en") return { status: "skipped", language: "en" };
        if (!selected.available) return { status: "unavailable", language };
        if (clock() < cooldown || calls.filter((time) => time > clock() - 60000).length >= 20) {
          return { status: "failed", language, error: "translator_budget", retryAt: Math.max(cooldown, clock() + 60000) };
        }
        calls.push(clock());
        while (calls.length && calls[0] <= clock() - 60000) calls.shift();
        const result = await selected.translate(input, controller.signal);
        if (typeof result?.title !== "string" || !result.title.trim() ||
            (input.summary && (typeof result.summary !== "string" || !result.summary.trim()))) throw new Error("translator_invalid_response");
        return { status: "ready", language: result.language || language, title: clip(result.title, 1000), summary: clip(result.summary, 2400) };
      })();
      const result = await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("translator_timeout")); }, timeoutMs);
      })]);
      cache.save(source, selected.id, result, clock());
    } catch (error) {
      const delay = Math.max(RETRY_MS, Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0);
      // Share provider cooldown across cards; never retry every failed item in a catch-up.
      if (/^translator_http_(?:401|403|429|5\d\d)$/.test(error.message || "")) cooldown = clock() + delay;
      cache.save(source, selected.id, { status: "failed", language: detected, error: /^translator_[a-z0-9_]+$/.test(error.message || "") ? error.message : "translator_failed", retryAt: clock() + delay }, clock());
    } finally { clearTimeout(timer); }
  }
  function pump() {
    while (active < 2 && waiting.length) {
      const job = waiting.shift();
      active++;
      run(job).catch(() => {}).finally(() => {
        pending.delete(job.key);
        active--;
        for (const callback of job.callbacks.values()) Promise.resolve().then(callback).catch(() => {});
        if (waiting.length) schedule();
        else if (!active) { for (const resolve of idle.splice(0)) resolve(); }
      });
    }
  }
  function whenIdle() {
    return pending.size ? new Promise((resolve) => idle.push(resolve)) : Promise.resolve();
  }
  return { enqueue, current, whenIdle };
}
const service = createTranslationService();
module.exports = { TIMEOUT_MS, detectLanguage, azureProvider, createTranslationService, ...service };
