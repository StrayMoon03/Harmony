// Discord-only decision preview. Never use these display values to write a
// calendar date, classify/correlate observations, or initiate translation.
const { cardText, preview, cleanTitle, candidateTiming, clip } = require('./radarPresentation');
const { calendarPrefill, validDate, validInstant } = require('./radarCalendarPrefill');
const { localToUtc } = require('./eventSchedulerService');
const PREVIEW_LIMIT = 360;
const SOURCE_NAMES = { 'youtube-uploads': 'Official Stray Kids YouTube',
  'jype-notice': 'JYPE Notice', 'sony-info': 'Sony Music Japan', 'sony-japan-info': 'Sony Music Japan' };
function sourceUrl(source) {
  try {
    const url = new URL(source?.canonical_url);
    return url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 512 ? url.href : null;
  } catch { return null; }
}
function sourceName(source) {
  if (SOURCE_NAMES[source?.provider]) return SOURCE_NAMES[source.provider];
  const url = sourceUrl(source);
  return url ? new URL(url).hostname.replace(/^www\./, '') : 'Original publisher';
}
function sourceText(discovery, source, view, translation) {
  const title = cleanTitle(view.translated ? translation.translated_title : source?.title || discovery.title);
  const summary = preview(view.translated ? translation.translated_summary : source?.summary || discovery.summary, title, PREVIEW_LIMIT);
  const same = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (summary && same(summary) !== same(title)) return { title, summary: cardText(summary, PREVIEW_LIMIT) };
  const vlog = source?.provider === 'youtube-uploads' && /^\[SKZ VLOG\]\s*(.+)$/i.exec(title);
  return { title, summary: vlog ? cardText(vlog[1].replace(/\s*·\s*/, ' — ') + ' (SKZ VLOG).', PREVIEW_LIMIT)
    : cardText(`An announcement from ${sourceName(source)}. No additional source description is available. Open Original Source for details.`, PREVIEW_LIMIT) };
}
function readableDate(date) {
  return validDate(date) ? new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(date + 'T00:00:00Z')) : 'Not identified';
}
function publicationDate(value) {
  return validDate(value) ? value : validInstant(value) ? value.slice(0, 10) : null;
}
function timeLabel(time, timezone) {
  if (!time) return 'Not announced';
  const [hour, minute] = time.split(':').map(Number);
  const zone = ({ 'Asia/Seoul': 'KST', 'Asia/Tokyo': 'JST', UTC: 'UTC' })[timezone] || timezone;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}${zone ? ' ' + zone : ' (time zone not announced)'}`;
}
function dateMeaning(line, originalText) {
  if (!line) return 'Not determined';
  const label = line.slice(0, line.indexOf(':'));
  const labels = new Set(['Application opens', 'Application deadline', 'Registration opens', 'Registration deadline',
    'Ticket sales open', 'Ticket sales deadline', 'Order opens', 'Order deadline', 'Preorder opens', 'Preorder deadline', 'Deadline', 'Release', 'Content release', 'Event']);
  if (!labels.has(label)) return 'Not determined';
  // Refine only the sentence that supplied this evidence. An incidental album,
  // member, or concert elsewhere in the article cannot determine date meaning.
  const sentences = String(originalText || '').slice(0, 20000).split(/[。！？!?;；\n]|\.(?=\s|$)/u)
    .filter(sentence => candidateTiming(sentence).includes(line));
  const subject = sentences.length === 1 ? sentences[0] : '';
  const refinements = label === 'Release' ? [
    ['Album release', /\balbum\b|アルバム|앨범/i], ['Single release', /\bsingle\b|シングル|싱글/i],
  ] : label === 'Event' ? [
    ['Concert', /\bconcert\b|コンサート|콘서트/i], ['Fan meeting', /fan[- ]?meet(?:ing)?|ファンミーティング|팬미팅/i],
    ['Livestream', /live[- ]?stream|生配信|라이브\s*방송/i], ['Broadcast', /broadcast|放送|방송/i],
    ['Listening party', /listening party|リスニング.?パーティ|리스닝.?파티/i],
  ] : [];
  const matches = refinements.filter(([, pattern]) => pattern.test(subject));
  return matches.length === 1 ? matches[0][0] : label;
}
function statusFor(date, time, timezone, meaning, now) {
  if (!date) return 'No calendar date identified yet';
  const dayIn = zone => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const instant = time && timezone ? localToUtc(date, time, timezone) : null;
  // Without a known applicable zone, use the full civil-day range rather than
  // inventing UTC as the event's timezone or declaring a boundary-day release past.
  const earliest = dayIn(timezone || 'Etc/GMT+12');
  const latest = dayIn(timezone || 'Pacific/Kiritimati');
  if ((instant && instant.getTime() > now.getTime()) || (!instant && date > latest)) return 'Upcoming';
  if (!instant && date >= earliest) return time && !timezone ? 'Date announced; time zone not announced' : 'Date announced; time not announced';
  if (/release/i.test(meaning)) return 'Already released';
  if (/deadline/i.test(meaning)) return 'Deadline has passed';
  return 'Date has passed';
}
function calendarDetails(discovery, source, now) {
  const original = (source?.title || discovery.title || '') + '\n' + (source?.summary || discovery.summary || '');
  const evidence = candidateTiming(original); // unchanged extraction; original source only
  const confirmed = validDate(discovery.event_date) || validInstant(discovery.event_at);
  const prefill = calendarPrefill(discovery, source);
  const matching = evidence.filter(line => calendarPrefill({}, { title: '', summary: line }).date === prefill.date);
  const entries = confirmed ? [{ ...prefill, line: matching.length === 1 ? matching[0] : null }]
    : evidence.length ? evidence.map(line => ({ ...calendarPrefill({}, { title: '', summary: line }), line })) : [{ date: '', time: '', timezone: '', line: null }];
  const published = publicationDate(source?.published_at);
  const contentPublished = source?.provider === 'youtube-uploads' && published &&
    (validInstant(source.published_at) ? Date.parse(source.published_at) <= now.getTime() : published <= now.toISOString().slice(0, 10));
  const lines = entries.slice(0, 3).map(entry => {
    const meaning = dateMeaning(entry.line, original);
    const status = !entry.date && contentPublished ? 'Already published' : statusFor(entry.date, entry.time, entry.timezone, meaning, now);
    return [`Date: ${readableDate(entry.date)}`, `Time: ${timeLabel(entry.time, entry.timezone)}`,
      `Date means: ${meaning}`, `Status: ${status}`,
      ...(!entry.date && contentPublished ? ['Calendar relevance: Content is already published; calendar timing still needs confirmation.'] : [])].join('\n');
  });
  return lines.join('\n\n');
}
function channelView(discovery, source, view, translation, now = new Date()) {
  const selected = sourceText(discovery, source, view, translation);
  const published = publicationDate(source?.published_at);
  let handoff;
  try { handoff = JSON.parse(discovery.handoff_result || 'null'); } catch { /* Optional display state. */ }
  const state = [({ Watching: 'Watching for details', Ignored: 'Ignored', Resolved: 'Resolved' })[discovery.review_state],
    handoff?.kind === 'event' ? 'Linked to existing calendar event' : discovery.calendar_candidate_id ? 'Sent for calendar review' : null].filter(Boolean).join(' · ');
  const language = view.translated ? 'Machine translated to English' : view.language === 'English translation available on request' ? null : view.language;
  return { title: cardText(selected.title, 256) || cardText(`${sourceName(source)} announcement`, 256),
    description: '**What this is:**\n' + selected.summary + (language ? '\n\n*' + language + '*' : ''),
    source: cardText(sourceName(source), 100), url: sourceUrl(source),
    timing: clip(calendarDetails(discovery, source, now), 1000), published: published ? readableDate(published) : null, state };
}
module.exports = { channelView, sourceUrl };
