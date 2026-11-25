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
