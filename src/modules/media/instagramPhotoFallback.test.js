const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { saveVerifiedPhotos } = require('./instagramPhotoFallback');

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
