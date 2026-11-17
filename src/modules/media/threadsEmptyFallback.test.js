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

test('accepts a small Threads image only after it decodes as real post media', async (t) => {
  const modulePath = path.join(__dirname, 'threadsDownloader.js');
  const localRequire = createRequire(modulePath);
  const post = 'https://www.threads.com/@author/post/REAL123';
  const cdn = 'https://scontent-a.fbcdn.net/verified-small.jpg';
  const exec = () => {};
  exec[promisify.custom] = async (file) => {
    if (String(file).includes('python')) {
      return {
        stdout: 'HARMONY_THREADS_BROWSER:' + JSON.stringify({
          candidates: [cdn],
          finalUrl: post,
        }),
      };
    }
    if (String(file).includes('ffprobe')) {
      return { stdout: '640x640\n' };
    }
    if (String(file).includes('ffmpeg')) {
      return { stdout: Buffer.alloc(64, 255) };
    }
    throw new Error(`unexpected executable: ${file}`);
  };
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, __dirname, process, console, Buffer, URL, AbortSignal,
    require: (id) => id === 'node:child_process' ? { execFile: exec } : localRequire(id),
    fetch: async (url) => {
      assert.equal(url, cdn);
      return new Response(Buffer.alloc(20 * 1024), {
        headers: { 'content-type': 'image/jpeg' },
      });
    },
  };

  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), context, { filename: modulePath });
  const result = await module.exports.downloadThreadsMedia(post);
  t.after(() => fsp.rm(result.rawDir, { recursive: true, force: true }));

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].isImage, true);
});


function loadDownloader(fetchImpl, browserStdout) {
  const modulePath = path.join(__dirname, 'threadsDownloader.js');
  const localRequire = createRequire(modulePath);
  const exec = () => {};
  exec[promisify.custom] = async (file) => {
    if (String(file).includes('python')) {
      return { stdout: browserStdout };
    }
    if (String(file).includes('ffprobe')) {
      return { stdout: '1200x800\n' };
    }
    if (String(file).includes('ffmpeg')) {
      return { stdout: Buffer.alloc(64, 255) };
    }
    throw new Error(`unexpected executable: ${file}`);
  };
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, __dirname, process, console, Buffer, URL, AbortSignal,
    require: (id) => id === 'node:child_process' ? { execFile: exec } : localRequire(id),
    fetch: fetchImpl,
  };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), context, { filename: modulePath });
  return module.exports;
}

const emptyBrowser = 'HARMONY_THREADS_BROWSER:' + JSON.stringify({ candidates: [] });

test('uses matching exact-post Open Graph fallback after browser and Discord preview find no media', async (t) => {
  const post = 'https://www.threads.com/@agnieszka.jordan/post/DfueqT_ghKZ';
  const video = 'https://scontent-a.fbcdn.net/exact.mp4';
  const image = 'https://scontent-a.fbcdn.net/exact.jpg';
  const html = [
    '<html><head>',
    `<meta property="og:url" content="${post}">`,
    `<meta property="og:description" content="A year ago, Minsung skipped dinner.">`,
    `<meta property="og:video" content="${video}">`,
    `<meta property="og:image" content="${image}">`,
    '</head></html>',
  ].join('');
  const downloaded = [];
  const api = loadDownloader(async (url) => {
    if (String(url).includes('threads.com') || String(url).includes('threads.net')) {
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    }
    if (url === video) {
      downloaded.push('video');
      return new Response(Buffer.alloc(40 * 1024), { headers: { 'content-type': 'video/mp4' } });
    }
    if (url === image) {
      downloaded.push('image');
      return new Response(Buffer.alloc(20 * 1024), { headers: { 'content-type': 'image/jpeg' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }, emptyBrowser);

  const result = await api.downloadThreadsMedia(post, {
    getDiscordEmbedFallback: async () => null,
  });
  t.after(() => fsp.rm(result.rawDir, { recursive: true, force: true }));
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].isVideo, true);
  assert.match(result.files[0].path, /\.mp4$/);
  assert.equal(downloaded[0], 'video');
  assert.equal(result.previewOnly, undefined);
  assert.equal(result.creator, '@agnieszka.jordan');
});

test('posts a labeled video thumbnail when only og:image is downloadable', async (t) => {
  const post = 'https://www.threads.com/@agnieszka.jordan/post/DfueqT_ghKZ';
  const video = 'https://scontent-a.fbcdn.net/exact.mp4';
  const image = 'https://scontent-a.fbcdn.net/exact.jpg';
  const html = [
    '<html><head>',
    `<meta property="og:url" content="${post}">`,
    `<meta property="og:description" content="A year ago, Minsung skipped dinner.">`,
    `<meta property="og:video" content="${video}">`,
    `<meta property="og:image" content="${image}">`,
    '</head></html>',
  ].join('');
  const api = loadDownloader(async (url) => {
    if (String(url).includes('threads.com') || String(url).includes('threads.net')) {
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    }
    if (url === video) {
      return new Response('nope', { status: 403, headers: { 'content-type': 'text/plain' } });
    }
    if (url === image) {
      return new Response(Buffer.alloc(20 * 1024), { headers: { 'content-type': 'image/jpeg' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }, emptyBrowser);

  const result = await api.downloadThreadsMedia(post, {
    getDiscordEmbedFallback: async () => null,
  });
  t.after(() => fsp.rm(result.rawDir, { recursive: true, force: true }));
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].isImage, true);
  assert.equal(result.previewOnly, true);
});

test('does not use Open Graph media from a nested or different post', async () => {
  const requested = 'https://www.threads.com/@author/post/REAL123';
  const html = [
    '<html><head>',
    '<meta property="og:url" content="https://www.threads.com/@other/post/NESTED999">',
    '<meta property="og:description" content="A different post caption.">',
    '<meta property="og:image" content="https://scontent-a.fbcdn.net/other.jpg">',
    '</head></html>',
  ].join('');
  const api = loadDownloader(async (url) => {
    if (String(url).includes('threads.com') || String(url).includes('threads.net')) {
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }, emptyBrowser);

  await assert.rejects(api.downloadThreadsMedia(requested, {
    getDiscordEmbedFallback: async () => null,
  }), /browser returned no media/);
});

test('does not use Open Graph fallback for an unresolved share URL', async () => {
  const share = 'https://www.threads.com/share/ALIAS/';
  const image = 'https://scontent-a.fbcdn.net/exact.jpg';
  const html = [
    '<html><head>',
    '<meta property="og:image" content="' + image + '">',
    '</head></html>',
  ].join('');
  const downloaded = [];
  const api = loadDownloader(async (url) => {
    if (url === image) {
      downloaded.push(url);
      return new Response(Buffer.alloc(20 * 1024), { headers: { 'content-type': 'image/jpeg' } });
    }
    if (String(url).includes('threads.com') || String(url).includes('threads.net')) {
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }, emptyBrowser);

  await assert.rejects(api.downloadThreadsMedia(share, {
    getDiscordEmbedFallback: async () => null,
  }), /browser returned no media|share did not remain|could not inspect|no media/);
  assert.deepEqual(downloaded, []);
});

test('a text-only exact post fails with a plain text-only reason, not a media error', async () => {
  const modulePath = path.join(__dirname, 'threadsDownloader.js');
  const localRequire = createRequire(modulePath);
  const exec = () => {};
  exec[promisify.custom] = async () => ({
    stdout: 'HARMONY_THREADS_DIAGNOSTICS:' + JSON.stringify({ exactRecordSeen: true, exactRecordMediaTypeSeen: true, exactRecordTextOnly: true })
      + '\nHARMONY_THREADS_BROWSER:' + JSON.stringify({ candidates: [] }),
  });
  const post = 'https://www.threads.com/@author/post/TEXT123';
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, __dirname, process, console, Buffer, URL, AbortSignal,
    require: (id) => id === 'node:child_process' ? { execFile: exec } : localRequire(id),
    fetch: async () => new Response('<html>' + 'page without media '.repeat(100) + '</html>'),
  };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), context, { filename: modulePath });
  await assert.rejects(module.exports.downloadThreadsMedia(post, {
    getDiscordEmbedFallback: async () => null,
  }), /Threads post is text-only/);
});

function loadWithBrowserOutput(browserResult, diagnostics) {
  const modulePath = path.join(__dirname, 'threadsDownloader.js');
  const localRequire = createRequire(modulePath);
  const exec = () => {};
  exec[promisify.custom] = async () => ({
    stdout: 'HARMONY_THREADS_DIAGNOSTICS:' + JSON.stringify(diagnostics)
      + '\nHARMONY_THREADS_BROWSER:' + JSON.stringify(browserResult),
  });
  const fetched = [];
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, __dirname, process, console, Buffer, URL, AbortSignal,
    require: (id) => id === 'node:child_process' ? { execFile: exec } : localRequire(id),
    fetch: async (url) => {
      fetched.push(url);
      return new Response('<html>' + 'page without media '.repeat(100) + '</html>');
    },
  };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), context, { filename: modulePath });
  return { downloader: module.exports, fetched };
}

const TEXT_ONLY = { exactRecordSeen: true, exactRecordMediaTypeSeen: true, exactRecordTextOnly: true };

test('a text-only exact post returns its verified text instead of failing', async () => {
  const post = 'https://www.threads.com/@author/post/TEXT123';
  const badge = 'https://scontent-a.fbcdn.net/badge.png';
  const { downloader, fetched } = loadWithBrowserOutput({
    finalUrl: post,
    candidates: [badge],
    textPost: {
      text: 'Just words', username: 'author', fullName: 'Author Name',
      avatarUrl: 'https://scontent-a.cdninstagram.com/a.jpg', takenAt: 1794919280,
    },
  }, TEXT_ONLY);
  const result = await downloader.downloadThreadsMedia(post, { getDiscordEmbedFallback: async () => null });
  assert.equal(result.textOnly, true);
  assert.equal(result.files.length, 0);
  assert.equal(result.rawDir, null);
  assert.equal(result.creator, '@author');
  assert.deepEqual({ ...result.textPost }, {
    text: 'Just words', handle: 'author', displayName: 'Author Name',
    avatarUrl: 'https://scontent-a.cdninstagram.com/a.jpg',
    originalDate: '2026-11-17T12:41:20.000Z',
  });
  assert.equal(fetched.includes(badge), false);
});

test('text from a different author than the verified permalink is not used', async () => {
  const post = 'https://www.threads.com/@author/post/TEXT123';
  const { downloader } = loadWithBrowserOutput({
    finalUrl: post, candidates: [], textPost: { text: 'Someone else', username: 'other' },
  }, TEXT_ONLY);
  await assert.rejects(downloader.downloadThreadsMedia(post, {
    getDiscordEmbedFallback: async () => null,
  }), /Threads post is text-only/);
});

test('text is ignored unless the exact record is confirmed text-only', async () => {
  const post = 'https://www.threads.com/@author/post/TEXT123';
  const { downloader } = loadWithBrowserOutput({
    finalUrl: post, candidates: [], textPost: { text: 'Caption of a video', username: 'author' },
  }, { exactRecordSeen: true, exactRecordMediaTypeSeen: true });
  await assert.rejects(downloader.downloadThreadsMedia(post, {
    getDiscordEmbedFallback: async () => null,
  }), /browser returned no media|no media/);
});
