const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(__dirname + '/src/handlers/mediaHandler.js', 'utf8');
const start = source.indexOf('    const platform = "facebook";');
const end = source.indexOf('      const downloadResult =', start);
assert.ok(start >= 0 && end > start);
const body = source.slice(start, end) + '\n      await downloadFacebookMedia(normalizedUrl, originalUrl);\n    } catch (error) { throw error; }';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction('message', 'shareStore', 'formatAlreadySharedReply', 'suppressOriginalEmbeds', 'mediaId', 'normalizedUrl', 'originalUrl', 'getMediaInfo', 'downloadFacebookMedia', 'console', body);

for (const failure of [null, new Error('HTTP 500'), new Error('Missing Access')]) {
  test('Facebook continues after typing: ' + (failure?.message || 'success'), async () => {
    const calls = [];
    await run({ channel: { sendTyping: async () => { calls.push('typing'); if (failure) throw failure; } } },
      { find: () => null }, () => '', async () => {}, 'media', 'normalized', 'original',
      async () => { calls.push('metadata'); }, async () => { calls.push('download'); },
      { warn: () => calls.push('warning') });
    assert.deepEqual(calls, failure ? ['typing', 'warning', 'metadata', 'download'] : ['typing', 'metadata', 'download']);
  });
}
test('duplicate branch still returns without typing or downloading', async () => {
  const calls = [];
  await run({ reply: async () => calls.push('reply'), channel: { sendTyping: async () => { throw Error('must not type'); } } },
    { find: () => ({ existing: true }) }, () => 'duplicate', async () => calls.push('suppress'), 'media', 'normalized', 'original',
    async () => { throw Error('must not fetch metadata'); }, async () => { throw Error('must not download'); }, { warn() {} });
  assert.deepEqual(calls, ['reply', 'suppress']);
});
test('real download errors still propagate', async () => {
  const error = new Error('verified download failure');
  await assert.rejects(run({ channel: { sendTyping: async () => {} } }, { find: () => null }, () => '', async () => {},
    'media', 'normalized', 'original', async () => ({}), async () => { throw error; }, { warn() {} }), error);
});
