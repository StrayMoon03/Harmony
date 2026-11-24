const { randomBytes } = require('node:crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const store = require('../stores/radarStore');
const p = require('./radarPresentation');
const { channelView, sourceUrl } = require('./radarChannelPresentation');
const { calendarPrefill, validDate } = require('./radarCalendarPrefill');
const translation = require('./radarTranslationService');
const { resolveAdminCapabilities } = require('./operationsStatusService');
const { CALENDAR_CATEGORIES, CALENDAR_CATEGORY_LABELS, validTimezone } = require('./eventSchedulerService');
const TTL = 30 * 60 * 1000;
function suggestedCategory(source, discovery) {
  const title = source?.title || discovery.title || '';
  if (/merch|goods|グッズ|通信販売|pop[- ]?up|ポップアップ/i.test(title)) return 'shopping';
  if (source?.provider === 'youtube-uploads') return 'content';
  if (discovery.confidence !== 'rule-based') return 'other';
  if (discovery.category === 'Release' && /\brelease\b|新曲|リリース|발매/i.test(title)) return 'release';
  if (discovery.category === 'Event' && /concert|コンサート|콘서트/i.test(title)) return 'concert';
  if (/livestream|live stream|生配信/i.test(title)) return 'stream';
  if (discovery.category === 'Appearance') return 'appearance';
  return 'other';
}
function safeImage(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && u.href.length <= 2048 &&
      u.hostname.includes('.') && !/^\d+\.|^\[|localhost|\.local$|\.internal$/i.test(u.hostname) ? u.href : null;
  } catch { return null; }
}
function image(source) {
  let metadata = {};
  try { metadata = JSON.parse(source?.metadata || '{}'); } catch { /* No image is safe too. */ }
  for (const url of Array.isArray(metadata.images) ? metadata.images.slice(0, 5) : []) if (safeImage(url)) return safeImage(url);
  try {
    const u = new URL(source.canonical_url);
    const id = ['www.youtube.com', 'youtube.com'].includes(u.hostname) ? u.searchParams.get('v') : null;
    if (source.provider === 'youtube-uploads' && /^[A-Za-z0-9_-]{11}$/.test(id || '')) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  } catch { /* No thumbnail. */ }
  return null;
}
function validate(draft, final = false) {
  if (!draft.title || draft.title.length > 120) throw new Error('Enter a calendar title (up to 120 characters).');
  if ((final || draft.date) && !validDate(draft.date)) throw new Error('Enter a complete calendar date as YYYY-MM-DD.');
  if (draft.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) throw new Error('Use HH:MM for an exact time, or leave it blank for date only.');
  if (draft.timezone && !validTimezone(draft.timezone)) throw new Error('Enter a valid timezone, such as Asia/Tokyo.');
  if (final && draft.time && !draft.timezone) throw new Error('An exact time requires a timezone.');
  if (!CALENDAR_CATEGORIES.includes(draft.category) || draft.description.length > 500) throw new Error('Choose an existing calendar type and keep notes within 500 characters.');
}
function createEntryReview({ handoff, syncRadarChannel, handoffFeedback }) {
  const sessions = new Map();
  function confirmedDraft(outcome) {
    const r = outcome.record, candidate = outcome.kind === 'candidate';
    const at = candidate ? r.proposed_event_at : r.event_at;
    const timezone = (candidate ? r.proposed_event_timezone : r.event_timezone) || '';
    let time = '';
    if (at && timezone && validTimezone(timezone)) time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
    let category = candidate ? 'other' : r.category;
    try { if (candidate) category = JSON.parse(r.source_metadata || '{}').calendarCategory || 'other'; } catch { /* Legacy metadata. */ }
    return { title: r.title || '', date: (candidate ? r.proposed_event_date : r.event_date) || '', time, timezone,
      description: (candidate ? r.submitted_note : r.description) || '', category: CALENDAR_CATEGORIES.includes(category) ? category : 'other' };
  }
  const key = i => `${i.guildId}:${i.user.id}`;
  const id = (s, action) => `harmony-radar:entry:${action}:${s.token}:${s.version}`;
  const button = (s, action, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id(s, action)).setLabel(label).setStyle(style);
  function prune() { for (const [token, s] of sessions) if (s.expires <= Date.now()) sessions.delete(token); }
  function payload(s, notice = '') {
    const current = translation.current(s.source);
    const view = p.cardView(s.discovery, s.source, current, { translationConfigured: translation.azureProvider().available, translationUseful: s.useful });
    const card = channelView(s.discovery, s.source, view, current);
    const title = view.translated ? current.translated_title : s.source.title || s.discovery.title;
    const body = view.translated ? current.translated_summary : s.source.summary;
    const preview = p.cardText(p.cleanContent(String(body || '').slice(0, 12000), title), 1400) || 'No additional source text. Open Original Source to inspect the announcement.';
    const context = new EmbedBuilder().setAuthor({ name: '📅 CALENDAR ENTRY REVIEW' }).setTitle(p.cardText(p.cleanTitle(title), 256) || 'Original announcement')
      .setDescription('**What Harmony found**\n' + preview + (view.translated ? '\n\n*Machine translated to English*' : ''))
      .addFields({ name: 'Source', value: card.source });
    if (card.published) context.addFields({ name: 'Published (source/content)', value: card.published });
    if (card.url) context.setURL(card.url);
    if (card.timing.includes("Status: Already published")) context.setFooter({ text: "Already published YouTube content. Publication is not a calendar date." });
    const thumbnail = image(s.source); if (thumbnail) context.setImage(thumbnail);
    const d = s.draft;
    const entry = new EmbedBuilder().setTitle(s.completed ? 'Sent to Calendar Review' : 'Calendar entry')
      .setDescription(s.completed ? s.feedback : 'Review the source above, then edit the entry below. Nothing is published by this step.')
      .addFields({ name: 'Title', value: p.cardText(d.title, 240) || 'Needs entry' },
        { name: 'Date', value: d.date || 'Needs entry', inline: true }, { name: 'Time', value: d.time || 'Date only (no time)', inline: true },
        { name: 'Timezone', value: d.timezone || 'Not set', inline: true },
        { name: 'Type', value: CALENDAR_CATEGORY_LABELS[d.category] },
        { name: 'Description / notes', value: p.cardText(d.description, 1000) || 'None' });
    if (notice) entry.setFooter({ text: p.clip(notice, 500) });
    const rows = [];
    if (!s.completed) {
      rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(id(s, 'type')).setPlaceholder('Calendar type')
        .setDisabled(s.busy || s.frozen).addOptions(CALENDAR_CATEGORIES.map(value => ({ label: CALENDAR_CATEGORY_LABELS[value], value, default: value === d.category })))));
      rows.push(new ActionRowBuilder().addComponents(button(s, 'edit', 'Edit Calendar Entry').setDisabled(s.busy || s.frozen),
        button(s, 'send', 'Send to Calendar Review', ButtonStyle.Primary).setDisabled(s.busy), button(s, 'refresh', 'Refresh'), button(s, 'cancel', 'Cancel / Back')));
    } else rows.push(new ActionRowBuilder().addComponents(button(s, 'cancel', 'Close')));
    const sources = new ActionRowBuilder();
    if (!s.completed && s.owner && view.needsTranslation && !view.translated) sources.addComponents(button(s, 'translate', 'Translate to English').setDisabled(s.translating));
    if (card.url) sources.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open Original Source').setURL(card.url));
    if (sources.components.length) rows.push(sources);
    return { embeds: [context, entry], components: rows, allowedMentions: { parse: [] } };
  }
  async function open(i, discovery, capabilities) {
    prune();
    let s = [...sessions.values()].find(s => s.actorKey === key(i) && s.discovery.id === discovery.id && !s.completed);
    if (!s) {
      if (sessions.size >= 200) { await i.editReply('Private review is busy. Close an old draft before opening another.'); return; }
      const source = p.primarySource(discovery, store.supportingSources(discovery.id));
      if (!source) { await i.editReply('The stored source is unavailable. Nothing was sent.'); return; }
      const prefill = calendarPrefill(discovery, source);
      const complete = translation.current(source);
      let pending = null;
      try { pending = JSON.parse(discovery.handoff_request || 'null'); } catch { /* Existing malformed state fails in handoff. */ }
      s = { token: randomBytes(12).toString('hex'), actorKey: key(i), channelId: i.channelId, discovery, source,
        version: 0, owner: capabilities.isGuildOwner, expires: Date.now() + TTL,
        frozen: Boolean(pending), busy: false, completed: false,
        draft: pending ? { title: pending.input.title, date: pending.details.date, time: pending.details.time || '', timezone: pending.details.timezone || '',
          description: pending.input.submittedNote || '', category: JSON.parse(pending.input.sourceMetadata || '{}').calendarCategory || 'other' } : {
          title: p.clip(p.cleanTitle(complete?.status === 'ready' ? complete.translated_title : source.title || discovery.title), 120),
          date: prefill.date, time: prefill.timezone ? prefill.time : '', timezone: prefill.timezone,
          description: p.preview(complete?.status === 'ready' ? complete.translated_summary : source.summary, source.title, 500), category: suggestedCategory(source, discovery) } };
      sessions.set(s.token, s);
      s.useful = await translation.useful(source);
    }
    s.expires = Date.now() + TTL;
    await i.editReply(payload(s, s.frozen ? 'Handoff already started. Retry the same frozen entry safely.' : 'Private draft expires after 30 minutes of inactivity.'));
  }
  async function handle(i) {
    const match = /^harmony-radar:entry:(edit|save|type|refresh|translate|send|cancel):([a-f0-9]{24}):(\d+)$/.exec(i.customId || '');
    if (!match) return false;
    const [, action, token, version] = match;
    if ((action === 'save') !== Boolean(i.isModalSubmit?.())) { await i.reply({ content: 'Use the review controls to edit this entry.', flags: MessageFlags.Ephemeral }); return true; }
    prune();
    const s = sessions.get(token), settings = store.getSettings(i.guildId);
    const cap = await resolveAdminCapabilities({ guild: i.guild, member: i.member, userId: i.user?.id });
    const fail = content => i.reply({ content, flags: MessageFlags.Ephemeral });
    if (!s || s.actorKey !== key(i) || !cap.canDiagnose || !settings?.enabled || i.channelId !== settings.channel_id || i.channelId !== s.channelId) {
      await fail('This private draft expired, Harmony restarted, or access changed. Reopen Review / Add to Calendar. Nothing was sent by this action.'); return true;
    }
    s.expires = Date.now() + TTL;
    if (['edit', 'save', 'type', 'send'].includes(action) && Number(version) !== s.version) { await fail('This entry changed. Refresh the review and use its current controls.'); return true; }
    if (['edit', 'save', 'type'].includes(action) && (s.busy || s.frozen || s.completed)) { await fail('This handoff is already started or completed. Its confirmed values cannot be rewritten.'); return true; }
    if (action === 'edit') {
      const modal = new ModalBuilder().setCustomId(id(s, 'save')).setTitle('Edit calendar entry');
      for (const [field, label, required, max] of [['title', 'Calendar title', true, 120], ['date', 'Date YYYY-MM-DD', false, 10],
        ['time', 'Time HH:MM (blank = date only)', false, 5], ['timezone', 'Timezone (required with time)', false, 80], ['description', 'Description / notes', false, 500]]) {
        const input = new TextInputBuilder().setCustomId(field).setLabel(label).setRequired(required).setMaxLength(max)
          .setStyle(field === 'description' ? TextInputStyle.Paragraph : TextInputStyle.Short);
        if (s.draft[field]) input.setValue(s.draft[field]);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      }
      await i.showModal(modal); return true;
    }
    if (action === 'cancel') { sessions.delete(token); await i.update({ content: 'Calendar entry review closed. No new submission was made.', embeds: [], components: [] }); return true; }
    if (action === 'save') {
      const draft = { ...s.draft };
      for (const field of ['title', 'date', 'time', 'timezone', 'description']) draft[field] = i.fields.getTextInputValue(field).trim();
      try { validate(draft); } catch (error) { await fail(error.message); return true; }
      s.draft = draft; s.version++;
    }
    if (action === 'type') {
      if (!CALENDAR_CATEGORIES.includes(i.values?.[0])) { await fail('Choose an existing calendar type.'); return true; }
      s.draft.category = i.values[0]; s.version++;
    }
    if (action === 'translate') {
      if (!cap.isGuildOwner) { await fail('Only the Harmony server owner can request translation.'); return true; }
      await i.deferUpdate(); s.translating = true;
      try {
        await i.editReply(payload(s, 'Translating source preview only; your calendar entry is unchanged.'));
        const result = await translation.request(s.source); s.translating = false;
        if (!sessions.has(token)) return true;
        await i.editReply(payload(s, result.status === 'ready' ? 'Source translated. Your calendar entry is unchanged; edit it if needed.'
          : result.error === 'translator_free_quota_exhausted' ? 'Free translation allowance exhausted.' : 'Translation unavailable or still pending. Your entry remains intact.'));
      } finally { s.translating = false; }
      return true;
    }
    if (action === 'send') {
      if (s.busy) { await fail('This handoff is already in progress.'); return true; }
      if (s.completed) { await i.update(payload(s)); return true; }
      try { if (!s.frozen) validate(s.draft, true); } catch (error) { await fail(error.message); return true; }
      s.busy = true;
      try {
        await i.deferUpdate();
        const outcome = await handoff(i.client, i.guildId, s.discovery.id, i.user.id, { ...s.draft });
        s.draft = confirmedDraft(outcome);
        s.feedback = handoffFeedback(outcome); s.completed = true;
        await syncRadarChannel(i.client, i.guildId, { priorityDiscoveryId: s.discovery.id });
      } catch (error) {
        s.frozen = Boolean(store.getDiscovery(i.guildId, s.discovery.id)?.handoff_request);
        s.busy = false;
        if (!i.deferred) throw error;
        await i.editReply(payload(s, error.message)); return true;
      }
      s.busy = false; await i.editReply(payload(s)); return true;
    }
    await i.update(payload(s)); return true;
  }
  return { open, handle };
}
module.exports = { createEntryReview };
