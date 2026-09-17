const test = require('node:test');
const assert = require('node:assert/strict');
const storePath = require.resolve('../stores/errorMonitorStore');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true,
  exports: { getErrorMonitorSettings: () => ({ enabled: true }) } };
const { reportMediaErrorToGitHub } = require('./githubErrorReporter');

test('retains numbers on repeats and separates different links with identical errors', async () => {
  const originalFetch = global.fetch;
  const oldRepo = process.env.HARMONY_ERROR_GITHUB_REPO;
  const oldToken = process.env.HARMONY_ERROR_GITHUB_TOKEN;
  process.env.HARMONY_ERROR_GITHUB_REPO = 'test/errors';
  process.env.HARMONY_ERROR_GITHUB_TOKEN = 'fake-test-token';
  let calls = 0;
  global.fetch = async () => { const number = ++calls; await new Promise(r => setImmediate(r));
    return new Response(JSON.stringify({ number, html_url: `https://github.com/test/errors/issues/${number}` })); };
  const error = new Error('No media');
  try {
    const first = { content: 'https://www.threads.com/share/first/?tracking=1' };
    const [a, b] = await Promise.all([reportMediaErrorToGitHub(first, error), reportMediaErrorToGitHub(first, error)]);
    assert.equal(a.number, 1); assert.deepEqual(a, b); assert.equal(calls, 1);
    const repeat = await reportMediaErrorToGitHub({ content: 'https://www.threads.com/share/first/?tracking=2' }, error);
    assert.equal(repeat.number, 1); assert.equal(calls, 1);
    const different = await reportMediaErrorToGitHub({ content: 'https://www.threads.com/share/second/' }, error);
    assert.equal(different.number, 2); assert.equal(calls, 2);
    global.fetch = async () => { calls++; return new Response('', { status: 503 }); };
    const third = { content: 'https://www.threads.com/share/third/' };
    assert.equal(await reportMediaErrorToGitHub(third, error), false);
    global.fetch = async () => { calls++; return new Response(JSON.stringify({number:3})); };
    assert.equal((await reportMediaErrorToGitHub(third, error)).number, 3);
    assert.equal(calls, 4);
  } finally {
    global.fetch = originalFetch;
    if (oldRepo === undefined) delete process.env.HARMONY_ERROR_GITHUB_REPO; else process.env.HARMONY_ERROR_GITHUB_REPO = oldRepo;
    if (oldToken === undefined) delete process.env.HARMONY_ERROR_GITHUB_TOKEN; else process.env.HARMONY_ERROR_GITHUB_TOKEN = oldToken;
  }
});
