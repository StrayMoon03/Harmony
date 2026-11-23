// Discord-only view. Do not use this module for classification, translation
// input, correlation, persistence or calendar handoff.
const { cardText, preview, formatDate, cleanTitle, candidateTiming } = require('./radarPresentation');
const { calendarPrefill } = require('./radarCalendarPrefill');

const SOURCE_NAMES = { 'youtube-uploads': 'Official Stray Kids YouTube',
  'jype-notice': 'JYPE Notice', 'sony-info': 'Sony Music Japan', 'sony-japan-info': 'Sony Music Japan' };
const FOREIGN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
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
function explanation(discovery, source, view, translation) {
  const name = sourceName(source);
  if (view.needsTranslation && !view.translated) return cardText(`An announcement from ${name}. Translate to English for details.`, 240);
  const title = cleanTitle(view.translated ? translation.translated_title : source?.title || discovery.title);
  const vlog = source?.provider === 'youtube-uploads' && /^\[SKZ VLOG\]\s*(.+)$/i.exec(title);
  if (vlog && !FOREIGN.test(vlog[1])) return cardText(vlog[1].replace(/\s*·\s*/, ' — ') + ' (SKZ VLOG).', 240);
  const summary = preview(view.translated ? translation.translated_summary : source?.summary || discovery.summary, title, 240);
  const same = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (summary && same(summary) !== same(title) && !/^(?:Open|See) (?:the )?(?:official source|original announcement)/i.test(summary)) return cardText(summary, 240);
  const subject = ({ Release: 'A release announcement', Event: 'An event announcement',
    Ticketing: 'A ticketing announcement', 'Pop-up': 'A pop-up announcement',
    'Merch / Sale': 'A merchandise or sales announcement', 'New Content': 'A content announcement',
    Appearance: 'An appearance announcement' })[discovery.category] || 'An announcement';
  return cardText(`${subject} from ${name}. Open Original Source for the complete details.`, 240);
}
function timeLabel(time, timezone) {
  if (!time) return 'Not announced';
  const [hour, minute] = time.split(':').map(Number);
  const zone = ({ 'Asia/Seoul': 'KST', 'Asia/Tokyo': 'JST', UTC: 'UTC' })[timezone] || timezone;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}${zone ? ' ' + zone : ' (time zone not announced)'}`;
}
function timing(discovery, source, view) {
  // Reuse existing validated suggestions for display only. The source's
  // publication timestamp and translated prose are never prefill inputs.
  const prefill = calendarPrefill(discovery, source);
  const confirmed = Boolean(discovery.event_date || discovery.event_at);
  const originalTiming = candidateTiming((source?.title || discovery.title || '') + '\n' + (source?.summary || discovery.summary || ''));
  const event = originalTiming.length === 1 && originalTiming[0].startsWith('Event: ') && view.timing.length === 1 && view.timing[0].startsWith('Event: ');
  if (prefill.date && (confirmed || event)) return [
    `${confirmed ? 'Calendar date' : 'Event Date'}: ${formatDate(prefill.date)}`,
    `Time: ${timeLabel(prefill.time, prefill.timezone)}`,
  ];
  return view.timing.slice(0, 3).map(line => cardText(line, 200));
}
function channelView(discovery, source, view, translation) {
  const lines = timing(discovery, source, view);
  const published = !lines.length && formatDate(source?.published_at);
  let handoff;
  try { handoff = JSON.parse(discovery.handoff_result || 'null'); } catch { /* Optional display state. */ }
  const state = [({ Watching: 'Watching for details', Ignored: 'Ignored', Resolved: 'Resolved' })[discovery.review_state],
    handoff?.kind === 'event' ? 'Linked to existing calendar event' : discovery.calendar_candidate_id ? 'Sent for calendar review' : null].filter(Boolean).join(' · ');
  const language = view.translated ? 'Machine translated to English' : view.language;
  return { title: view.title === 'Official announcement · Unknown' ? cardText(`${sourceName(source)} announcement`, 256) : view.title,
    description: '**What this is:**\n' + explanation(discovery, source, view, translation) + (language ? '\n\n*' + language + '*' : ''),
    source: cardText(sourceName(source), 100), url: sourceUrl(source),
    timing: lines.join('\n'), published, state };
}
module.exports = { channelView, sourceUrl };
