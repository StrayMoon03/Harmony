const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');

const POST = 'https://www.threads.com/@agnieszka.jordan/post/DfueqT_ghKZ';
const VIDEO = 'https://scontent-iad3-1.cdninstagram.com/o1/v/t16/real.mp4?x=1';
const THUMB = 'https://scontent-a.fbcdn.net/thumb.jpg';

function loadDownloader({ fetchImpl, exec, logs }) {
  const modulePath = path.join(__dirname, 'threadsDownloader.js');
  const localRequire = createRequire(modulePath);
  const execFile = () => {};
  execFile[promisify.custom] = exec;
  const module = { exports: {} };
  const capture = (...args) => logs && logs.push(args.map(String).join(' '));
  const context = {
    module, exports: module.exports, __dirname, process, Buffer, URL, AbortSignal,
    console: { log: capture, warn: capture, error: capture },
    require: (id) => id === 'node:child_process' ? { execFile } : localRequire(id),
    fetch: fetchImpl,
  };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), context, { filename: modulePath });
  return module.exports;
}

function crawlerHtml({ withRecord = true, code = 'DfueqT_ghKZ' } = {}) {
  const record = { data: { post: { code, media_type: 2, video_versions: [{ url: VIDEO }], image_versions2: { candidates: [{ url: THUMB, width: 640, height: 640 }] } } } };
  return [
    '<html><head>',
    `<meta property="og:url" content="https://www.threads.com/&#064;agnieszka.jordan/post/${code}">`,
    `<meta property="og:image" content="${THUMB}">`,
    '</head><body>',
    withRecord ? `<script type="application/json">${JSON.stringify(record)}</script>` : '',
    '</body></html>',
  ].join('');
}

function media(url) {
  if (url === VIDEO) return new Response(Buffer.alloc(40 * 1024), { headers: { 'content-type': 'video/mp4' } });
  if (url === THUMB) return new Response(Buffer.alloc(20 * 1024), { headers: { 'content-type': 'image/jpeg' } });
  return null;
}

async function withCookieFile(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'threads-cookie-test-'));
  const file = path.join(dir, 'cookies.txt');
  await fsp.writeFile(file, '.threads.com\tTRUE\t/\tTRUE\t4000000000\tsessionid\tdummy\n');
  const previous = process.env.THREADS_COOKIES;
  process.env.THREADS_COOKIES = file;
  t.after(async () => {
    if (previous === undefined) delete process.env.THREADS_COOKIES; else process.env.THREADS_COOKIES = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return file;
}

const emptyCookiedBrowser = 'HARMONY_THREADS_BROWSER:' + JSON.stringify({ candidates: [], cookieCount: 8, finalUrl: POST });

test('uses the exact post record video from the public crawler page before the Discord preview', async (t) => {
  await withCookieFile(t);
  const pageRequests = [];
  let discordCalls = 0;
  let browserCalls = 0;
  const api = loadDownloader({
    exec: async (file) => {
      if (String(file).includes('python')) { browserCalls++; return { stdout: emptyCookiedBrowser, stderr: '' }; }
      throw new Error('unexpected ' + file);
    },
    fetchImpl: async (url, init = {}) => {
      const m = media(url); if (m) return m;
      pageRequests.push({ url, cookie: init.headers?.Cookie || '' });
      return new Response(crawlerHtml(), { headers: { 'content-type': 'text/html' } });
    },
  });
  const result = await api.downloadThreadsMedia(POST, { getDiscordEmbedFallback: async () => { discordCalls++; return null; } });
  t.after(() => fsp.rm(result.rawDir, { recursive: true, force: true }));
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].isVideo, true);
  assert.equal(result.previewOnly, undefined);
  assert.equal(discordCalls, 0);
  assert.equal(browserCalls, 1, 'no cookieless browser retry needed once the crawler supplied video');
  assert.equal(pageRequests[0].cookie, '', 'public crawler page is tried without the session first');
});

test('ignores a crawler record for a different shortcode', async (t) => {
  const api = loadDownloader({
    exec: async (file) => {
      if (String(file).includes('python')) return { stdout: 'HARMONY_THREADS_BROWSER:' + JSON.stringify({ candidates: [] }), stderr: '' };
      throw new Error('unexpected ' + file);
    },
    fetchImpl: async (url) => {
      if (media(url)) throw new Error('must not download media from another post');
      return new Response(crawlerHtml({ code: 'OTHER999' }), { headers: { 'content-type': 'text/html' } });
    },
  });
  await assert.rejects(api.downloadThreadsMedia(POST, { getDiscordEmbedFallback: async () => null }), /browser returned no media/);
});

test('retries the browser once without cookies when the session view had no media', async (t) => {
  await withCookieFile(t);
  const cookieArgs = [];
  const logs = [];
  const api = loadDownloader({
    logs,
    exec: async (file, args) => {
      if (String(file).includes('python')) {
        cookieArgs.push(args[2]);
        if (args[2]) return { stdout: emptyCookiedBrowser, stderr: 'Harmony Chromium executable: /ms-playwright/chrome\nHarmony Chromium version: 159.0.1\nnoise' };
        return { stdout: 'HARMONY_THREADS_BROWSER:' + JSON.stringify({ candidates: [VIDEO], cookieCount: 0, finalUrl: POST }), stderr: '' };
      }
      throw new Error('unexpected ' + file);
    },
    fetchImpl: async (url) => {
      const m = media(url); if (m) return m;
      return new Response('blocked', { status: 429 });
    },
  });
  const result = await api.downloadThreadsMedia(POST, { getDiscordEmbedFallback: async () => null });
  t.after(() => fsp.rm(result.rawDir, { recursive: true, force: true }));
  assert.equal(cookieArgs.length, 2);
  assert.ok(cookieArgs[0]);
  assert.equal(cookieArgs[1], '');
  assert.equal(result.files[0].isVideo, true);
  assert.ok(logs.some((line) => line.includes('Harmony Chromium version: 159.0.1')));
  assert.ok(logs.some((line) => line.includes('Harmony Chromium executable: /ms-playwright/chrome')));
  assert.ok(!logs.some((line) => line.includes('noise')));
});

test('does not retry without cookies when no session was used', async () => {
  const cookieArgs = [];
  const api = loadDownloader({
    exec: async (file, args) => {
      if (String(file).includes('python')) { cookieArgs.push(args[2]); return { stdout: 'HARMONY_THREADS_BROWSER:' + JSON.stringify({ candidates: [], cookieCount: 0 }), stderr: '' }; }
      throw new Error('unexpected ' + file);
    },
    fetchImpl: async () => new Response('blocked', { status: 429 }),
  });
  const previous = process.env.THREADS_COOKIES;
  delete process.env.THREADS_COOKIES;
  try {
    await assert.rejects(api.downloadThreadsMedia(POST, { getDiscordEmbedFallback: async () => null }), /browser returned no media/);
  } finally {
    if (previous !== undefined) process.env.THREADS_COOKIES = previous;
  }
  assert.equal(cookieArgs.length, 1);
});

test('falls back to the labeled thumbnail when the crawler page has only og:image', async (t) => {
  const api = loadDownloader({
    exec: async (file) => {
      if (String(file).includes('python')) return { stdout: 'HARMONY_THREADS_BROWSER:' + JSON.stringify({ candidates: [] }), stderr: '' };
      if (String(file).includes('ffprobe')) return { stdout: '640x640\n' };
      if (String(file).includes('ffmpeg')) return { stdout: Buffer.alloc(64, 255) };
      throw new Error('unexpected ' + file);
    },
    fetchImpl: async (url) => {
      const m = media(url); if (m) return m;
      return new Response(crawlerHtml({ withRecord: false }), { headers: { 'content-type': 'text/html' } });
    },
  });
  const result = await api.downloadThreadsMedia(POST, { getDiscordEmbedFallback: async () => null });
  t.after(() => fsp.rm(result.rawDir, { recursive: true, force: true }));
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].isImage, true);
});
