const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const moduleUnderTest = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'threadsDownloader.js'), 'utf8'), {
  module: moduleUnderTest, __dirname, process, console, URL,
  require: name => name.startsWith('node:') ? require(name) : {},
});
const extract = moduleUnderTest.exports.collectPostScopedJsonMedia;
const url = 'https://www.threads.com/@example/post/DdVuFD7kabI';
const owned = 'https://scontent-a.fbcdn.net/owned.mp4';
const video = code => ({ code, video_versions: [{ url: owned }] });
const script = value => '<script type="application/json">' + JSON.stringify(value) + '</script>';
const check = (html, expected) => assert.deepEqual(Array.from(extract(html, url)), expected);
test('nested independently matching record survives an empty exact wrapper', () => {
  check(script({ code: 'DdVuFD7kabI', post: video('DdVuFD7kabI') }), [owned]);
});
test('empty first script does not hide later exact media', () => {
  check(script({ code: 'DdVuFD7kabI' }) + script(video('DdVuFD7kabI')), [owned]);
});
test('foreign or unidentified children never inherit exact identity', () => {
  for (const child of [video('OTHER'), { video_versions: [{ url: owned }] }]) {
    check(script({ code: 'DdVuFD7kabI', post: child }), []);
  }
});
test('shortcodes remain case sensitive', () => check(script(video('ddvufd7kabi')), []));
test('empty carousel list does not discard root video', () => {
  check(script({ ...video('DdVuFD7kabI'), carousel_media: [] }), [owned]);
});
test('nonempty carousel keeps order and does not collect neighbors', () => {
  const second = 'https://scontent-a.fbcdn.net/second.mp4';
  check(script([{ code: 'DdVuFD7kabI', carousel_media: [video(''), { video_versions: [{ url: second }] }] }, video('OTHER')]), [owned, second]);
});
test('malformed scripts and untrusted media are rejected', () => {
  check('<script type="application/json">broken</script>' + script({ code: 'DdVuFD7kabI', video_versions: [{ url: 'https://attacker.invalid/video.mp4' }] }), []);
});
test('explicit quote behavior preserved and root keeps priority', () => {
  const quote = 'https://scontent-a.fbcdn.net/quote.mp4';
  const info = { share_info: { quoted_post: { video_versions: [{ url: quote }] } } };
  check(script({ code: 'DdVuFD7kabI', text_post_app_info: info }), [quote]);
  check(script({ ...video('DdVuFD7kabI'), text_post_app_info: info }), [owned]);
});
