const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { saveVerifiedPhotos } = require('./instagramPhotoFallback');

test('Instagram photo browser extraction tests pass', () => {
  const result = spawnSync(process.env.PYTHON_PATH || 'python3', ['instagramPhotoBrowser_test.py'], {
    cwd: __dirname,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('removes earlier photos when a later carousel attachment fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'instagram-photos-test-'));
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => ++calls === 1
    ? new Response(Buffer.alloc(2048), { headers: { 'content-type': 'image/jpeg' } })
    : new Response('', { status: 403 });
  try {
    await assert.rejects(saveVerifiedPhotos({ code: 'target', photos: ['https://a.cdninstagram.com/1', 'https://a.cdninstagram.com/2'] }, 'target', dir), /HTTP 403/);
    assert.deepEqual(await fs.readdir(dir), []);
    await assert.rejects(saveVerifiedPhotos({ code: 'other', photos: ['https://a.cdninstagram.com/1'] }, 'target', dir), /identity mismatch/);
    await assert.rejects(saveVerifiedPhotos({ code: 'target', photos: ['https://example.com/1'] }, 'target', dir), /URL rejected/);
    assert.equal(calls, 2);
  } finally {
    global.fetch = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('saves mixed photo and video carousel items in order', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'instagram-mixed-media-test-'));
  const original = global.fetch;
  global.fetch = async (url) => {
    const isVideo = String(url).endsWith('.mp4');
    return new Response(Buffer.alloc(2048), { headers: { 'content-type': isVideo ? 'video/mp4' : 'image/jpeg' } });
  };
  try {
    const files = await saveVerifiedPhotos({
      code: 'target',
      items: [
        { type: 'image', url: 'https://a.cdninstagram.com/0.jpg' },
        { type: 'video', url: 'https://scontent.cdninstagram.com/1.mp4' },
        { type: 'image', url: 'https://a.cdninstagram.com/2.jpg' },
      ],
    }, 'target', dir);
    assert.deepEqual(files.map((file) => path.basename(file)), [
      'instagram-media-000.jpg',
      'instagram-media-001.mp4',
      'instagram-media-002.jpg',
    ]);
    assert.deepEqual((await fs.readdir(dir)).sort(), [
      'instagram-media-000.jpg',
      'instagram-media-001.mp4',
      'instagram-media-002.jpg',
    ]);
  } finally {
    global.fetch = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('keeps photos when a mixed-carousel video cannot be downloaded', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'instagram-mixed-skip-video-'));
  const original = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('video')) return new Response('', { status: 403 });
    return new Response(Buffer.alloc(2048), { headers: { 'content-type': 'image/jpeg' } });
  };
  try {
    const files = await saveVerifiedPhotos({
      code: 'target',
      items: [
        { type: 'image', url: 'https://a.cdninstagram.com/0.jpg' },
        { type: 'video', url: 'https://a.cdninstagram.com/video.mp4' },
        { type: 'video', url: 'https://example.com/not-allowed.mp4' },
        { type: 'image', url: 'https://a.cdninstagram.com/3.jpg' },
      ],
    }, 'target', dir);
    assert.deepEqual(files.map((file) => path.basename(file)), [
      'instagram-media-000.jpg',
      'instagram-media-003.jpg',
    ]);
  } finally {
    global.fetch = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function photoLine(code) {
  return `HARMONY_INSTAGRAM_PHOTOS:${JSON.stringify({ code, creator: 'poster', photos: ['https://a.cdninstagram.com/1.jpg'] })}\n`;
}

async function withImageFetch(fn) {
  const original = global.fetch;
  global.fetch = async () => new Response(Buffer.alloc(2048), { headers: { 'content-type': 'image/jpeg' } });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'instagram-session-retry-test-'));
  try {
    return await fn(dir);
  } finally {
    global.fetch = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('photo fallback stays logged out when the logged-out pass works', async () => {
  const { downloadInstagramPhotos } = require('./instagramPhotoFallback');
  await withImageFetch(async (dir) => {
    const calls = [];
    const exec = async (_bin, args) => { calls.push(args.slice(1)); return { stdout: photoLine('target') }; };
    const result = await downloadInstagramPhotos('https://www.instagram.com/p/target/', dir, { exec, env: { INSTAGRAM_COOKIES: '/tmp/cookies.txt' } });
    assert.equal(result.files.length, 1);
    assert.deepEqual(calls, [['https://www.instagram.com/p/target/']]);
  });
});

test('photo fallback retries once with the Instagram session after a logged-out failure', async () => {
  const { downloadInstagramPhotos } = require('./instagramPhotoFallback');
  await withImageFetch(async (dir) => {
    const calls = [];
    const exec = async (_bin, args) => {
      calls.push(args.slice(1));
      if (!args.includes('--session')) throw new Error('Instagram browser could not verify a complete post');
      return { stdout: photoLine('target') };
    };
    const result = await downloadInstagramPhotos('https://www.instagram.com/p/target/', dir, { exec, env: { INSTAGRAM_COOKIES: '/tmp/cookies.txt' } });
    assert.equal(result.files.length, 1);
    assert.equal(result.creator, 'poster');
    assert.deepEqual(calls, [['https://www.instagram.com/p/target/'], ['https://www.instagram.com/p/target/', '--session']]);
  });
});

test('photo fallback does not retry with a session when no Instagram cookies are configured', async () => {
  const { downloadInstagramPhotos } = require('./instagramPhotoFallback');
  await withImageFetch(async (dir) => {
    let calls = 0;
    const exec = async () => { calls += 1; throw new Error('logged-out failed'); };
    await assert.rejects(downloadInstagramPhotos('https://www.instagram.com/p/target/', dir, { exec, env: {} }), /logged-out failed/);
    assert.equal(calls, 1);
  });
});

test('photo fallback reports both failures and still rejects a session result for another post', async () => {
  const { downloadInstagramPhotos } = require('./instagramPhotoFallback');
  await withImageFetch(async (dir) => {
    const exec = async (_bin, args) => {
      if (!args.includes('--session')) throw new Error('logged-out failed');
      return { stdout: photoLine('other') };
    };
    await assert.rejects(
      downloadInstagramPhotos('https://www.instagram.com/p/target/', dir, { exec, env: { INSTAGRAM_COOKIES: '/tmp/cookies.txt' } }),
      /logged-out failed; session retry: Instagram photo identity mismatch/,
    );
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test('photo fallback logs redacted browser diagnostics from a failed session retry', async () => {
  const { downloadInstagramPhotos, photoBrowserDiagnostics } = require('./instagramPhotoFallback');
  const diag = { session: true, stage: 'redirected', finalPath: '/accounts/login/', responses: [{ path: '/graphql/query', status: 401, message: 'Please wait a few minutes before you try again.' }] };
  const stderr = `Harmony Chromium executable: /x\nHARMONY_INSTAGRAM_PHOTO_DIAGNOSTICS:${JSON.stringify(diag)}\nInstagram browser could not verify a complete post\n`;
  assert.deepEqual(photoBrowserDiagnostics(stderr), diag);
  assert.equal(photoBrowserDiagnostics('HARMONY_INSTAGRAM_PHOTO_DIAGNOSTICS:not json'), null);
  const warnings = [];
  const logger = { warn: (line) => warnings.push(line) };
  const exec = async () => { const error = new Error('Command failed'); error.stderr = stderr; throw error; };
  await assert.rejects(downloadInstagramPhotos('https://www.instagram.com/p/target/', os.tmpdir(), { exec, env: { INSTAGRAM_COOKIES: '/tmp/cookies.txt' }, logger }), /session retry/);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((line) => line.startsWith('HARMONY_INSTAGRAM_PHOTO_DIAGNOSTICS:')));
  assert.deepEqual(JSON.parse(warnings[1].split(':').slice(1).join(':')), diag);
});
