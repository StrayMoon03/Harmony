const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');
const { matchesThreadsPreview } = require('./threads');

test('matches a resolved post preview while rejecting foreign hosts and partial IDs', () => {
  const share = 'https://www.threads.com/share/ALIAS/';
  const post = 'https://www.threads.com/@author/post/REAL123';
  assert.equal(matchesThreadsPreview(post, share, post), true);
  assert.equal(matchesThreadsPreview('https://www.threads.net/@author/post/REAL123?tracking=1', share, post), true);
  assert.equal(matchesThreadsPreview('https://evil.example/@author/post/REAL123', share, post), false);
  assert.equal(matchesThreadsPreview('https://www.threads.com/@author/post/REAL123extra', share, post), false);
  assert.equal(matchesThreadsPreview('https://www.threads.com/@author/post/OTHER', share, post), false);
});

test('an empty browser result uses the exact-message preview and still fails if absent', async (t) => {
  const modulePath = path.join(__dirname, 'threadsDownloader.js');
  const localRequire = createRequire(modulePath);
  const exec = () => {};
  exec[promisify.custom] = async () => ({ stdout: 'HARMONY_THREADS_BROWSER:' + JSON.stringify({ candidates: [] }) });
  const post = 'https://www.threads.com/@author/post/REAL123';
  const cdn = 'https://scontent-a.fbcdn.net/verified.mp4';
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, __dirname, process, console, Buffer, URL, AbortSignal,
    require: (id) => id === 'node:child_process' ? { execFile: exec } : localRequire(id),
    fetch: async (url) => url === cdn
      ? new Response(Buffer.alloc(40 * 1024), { headers: { 'content-type': 'video/mp4' } })
      : new Response('<html>' + 'page without media '.repeat(100) + '</html>'),
  };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), context, { filename: modulePath });
  let called = 0;
  const result = await module.exports.downloadThreadsMedia(post, {
    getDiscordEmbedFallback: async (resolved) => {
      called++; assert.equal(resolved, post);
      return { candidates: [cdn], finalUrl: post, creator: '@author' };
    },
  });
  t.after(() => fsp.rm(result.rawDir, { recursive: true, force: true }));
  assert.equal(called, 1); assert.equal(result.files.length, 1); assert.equal(result.creator, '@author');
  await assert.rejects(module.exports.downloadThreadsMedia(post, {
    getDiscordEmbedFallback: async () => null,
  }), /browser returned no media/);
});
