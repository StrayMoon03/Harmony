const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
process.env.HARMONY_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'countdown-topic-model-')), 'fixture.sqlite');
const topics = require('../src/services/concertCountdownTopic');
const panel = (day, days) => ({ day, days, state: days < 0 ? 'completed' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : 'upcoming' });
const model = (panels, city = 'Chicago') => ({ city, panels });
test('topic format matches the approved single and multiple date forms', () => {
  assert.equal(topics.format(model([panel(1, 205)])), '🧡 205 days until Chicago! 🖤');
  assert.equal(topics.format(model([panel(1, 205), panel(2, 206)])), '🧡 Day 1: 205 days | Day 2: 206 days 🖤');
  assert.equal(topics.format(model([panel(1, 1)])), '🧡 1 day until Chicago! 🖤');
  assert.match(topics.format(model([panel(1, 0)])), /It's concert day in Chicago!/);
  assert.match(topics.format(model([panel(1, -1)])), /Chicago concert completed/);
  assert.equal(topics.format(model([panel(1, -1), panel(2, 0), panel(3, 1)])), '🧡 Day 1: Completed | Day 2: Concert day! | Day 3: 1 day 🖤');
});
test('all twelve dates, no active dates and Unicode city names render without multiline injection', () => {
  const text = topics.format(model(Array.from({ length: 12 }, (_, n) => panel(n + 1, 205 + n))));
  for (let n = 1; n <= 12; n++) assert.ok(text.includes(`Day ${n}:`));
  assert.ok(text.length < topics.LIMIT); assert.match(topics.format(model([])), /No active concert dates/);
  assert.equal(topics.format(model([panel(1, 5)], 'São\nPaulo')), '🧡 5 days until São Paulo! 🖤');
});
test('topic composition moves one owned line to the top and preserves unrelated text exactly', () => {
  const old = topics.format(model([panel(1, 205)])), next = topics.format(model([panel(1, 204)]));
  const unrelated = 'Welcome to Chicago!\r\nTickets: https://example.com/ 🖤\n  Keep this spacing.  ';
  assert.equal(topics.compose(unrelated, [], next), next + '\n' + unrelated);
  assert.equal(topics.compose('Welcome\n' + old + '\nOther info', [old], next), next + '\nWelcome\nOther info');
  assert.equal(topics.compose(old + '\n' + old + '\n' + unrelated, [old], next), next + '\n' + unrelated);
  assert.equal(topics.compose(next + '\n' + unrelated, [old], next), next + '\n' + unrelated);
  assert.equal(topics.compose(null, [], next), next);
});
test('pending ownership removes the line from an unknown prior PATCH outcome without duplicates', () => {
  const old = topics.format(model([panel(1, 205)])), pending = topics.format(model([panel(1, 204)])), next = topics.format(model([panel(1, 203)]));
  assert.equal(topics.compose(pending + '\nWelcome', [old, pending], next), next + '\nWelcome');
});
test('full topics never truncate room information or dates, and exact limits are supported', () => {
  const text = topics.format(model([panel(1, 205)])), rest = 'x'.repeat(1024 - text.length - 1);
  assert.equal(topics.compose(rest, [], text).length, 1024);
  assert.throws(() => topics.compose(rest + 'x', [], text), /Not enough channel topic space/);
  assert.throws(() => topics.compose('🧡 10 days until Chicago! 🖤\nWelcome', [], text), /kept for review/);
  assert.throws(() => topics.compose(text + ' Room info', [text], text), /kept for review/);
  assert.equal(topics.compose('🧡 Welcome STAY! 🖤', [], text), text + '\n🧡 Welcome STAY! 🖤');
});
