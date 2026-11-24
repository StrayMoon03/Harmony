const { createHash } = require("node:crypto");
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, MessageFlags,
} = require("discord.js");
const store = require("../stores/radarStore");
const { resolveAdminCapabilities } = require("./operationsStatusService");
const { submitCalendarCandidate, localToUtc, validTimezone, refreshConfiguredScheduleManagers } = require("./eventSchedulerService");
const calendarStore = require("../stores/eventSchedulerStore");
const { calendarPrefill, validDate } = require("./radarCalendarPrefill");

const presentation = require("./radarPresentation");
const { channelView, sourceUrl } = require("./radarChannelPresentation");
const translation = require("./radarTranslationService");
const { classifyObservation } = require("./radarClassification");
const deliveries = new Map();
const handoffs = new Map();
const EXISTENCE_CHECK_MS = 60 * 60 * 1000;
function payload(discovery, sources, options = {}) {
  const source = presentation.primarySource(discovery, sources);
  const currentTranslation = options.translation || (source ? translation.current(source) : null);
  const view = presentation.cardView(discovery, source, currentTranslation, { translationConfigured: translation.azureProvider().available, translationUseful: options.translationUseful });
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-radar:ignore:" + discovery.id).setLabel("Ignore").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("harmony-radar:watch:" + discovery.id).setLabel("Watch for Details").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("harmony-radar:calendar:" + discovery.id).setLabel("Add to Calendar").setStyle(ButtonStyle.Primary)
      .setDisabled(Boolean(discovery.handoff_result) || !sourceUrl(source)),
  );
  if (source && view.needsTranslation && !view.translated) controls.addComponents(
    new ButtonBuilder().setCustomId("harmony-radar:translate:" + discovery.id).setLabel(
      view.language === "Translation pending" ? "Translating…" : "Translate to English")
      .setStyle(ButtonStyle.Secondary).setDisabled(view.language === "Translation pending"));
  const card = channelView(discovery, source, view, currentTranslation, options.now);
  if (card.url) controls.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Original Source").setURL(card.url));
  const embed = new EmbedBuilder().setTitle(card.title)
    .setDescription(card.description)
    .setColor(discovery.review_state === "Watching" ? 0xfee75c : 0x5865f2)
    .setAuthor({ name: "🔎 RADAR" });
  if (card.timing) embed.addFields({ name: "📅 Calendar details", value: card.timing });
  embed.addFields({ name: "Source", value: card.source });
  if (card.published) embed.addFields({ name: "Published (source/content)", value: card.published });
  if (card.state) embed.setFooter({ text: card.state });
  if (card.url) embed.setURL(card.url);
  return { embeds: [embed], components: [controls], allowedMentions: { parse: [] } };
}
async function recoverMessage(channel, client, discovery, reference) {
  if (reference.message_id) {
    try { return await channel.messages.fetch({ message: reference.message_id, force: true }); }
    catch (error) {
      if (error.code !== 10008) throw error;
      Object.assign(reference, store.resetDeletedDelivery(discovery.id, channel.id));
    }
  }
  let before = reference.recovery_before;
  for (let page = 0; page < 2; page++) {
    const history = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    for (const message of history.values()) {
      // New cards retain immutable identity in their existing controls, without
      // displaying an internal ID. Keep legacy-footer recovery for old cards.
      const controlMatch = message.components?.some(row => row.components?.some(button =>
        ["ignore", "watch", "calendar", "translate"].some(action =>
          (button.customId || button.data?.custom_id || button.custom_id) === `harmony-radar:${action}:${discovery.id}`)));
      if (message.author?.id === client.user.id && (controlMatch || message.embeds?.[0]?.footer?.text === "SKZ Radar #" + discovery.id)) return message;
    }
    const oldest = [...history.values()].at(-1);
    if (!oldest || history.size < 100 || oldest.createdTimestamp < Date.parse(reference.started_at) - 60000) return null;
    before = oldest.id;
  }
  store.saveRecoveryProgress(discovery.id, channel.id, before);
  throw Object.assign(new Error("Radar message recovery is continuing through saved channel history."), { code: "RADAR_RECOVERY_PENDING" });
}
async function syncRadarChannel(client, guildId, { now = new Date(), priorityDiscoveryId = null } = {}) {
  if (deliveries.has(guildId)) return deliveries.get(guildId);
  const job = (async () => {
    const settings = store.getSettings(guildId);
    if (!settings?.enabled) return;
    try {
      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
      const channel = guild.channels.cache.get(settings.channel_id) || await guild.channels.fetch(settings.channel_id);
      if (!channel?.isTextBased() || !channel.messages?.fetch) throw new Error("Radar destination is unavailable.");
      const queue = (await Promise.all(store.listDiscoveries(guildId).map(async (saved) => {
        const sources = store.supportingSources(saved.id);
        const source = presentation.primarySource(saved, sources);
        const discovery = source ? store.saveClassification(guildId, saved.id, classifyObservation(source, { title: source.title, summary: source.summary, metadata: source.metadata, url: source.canonical_url })) : saved;
        const body = payload(discovery, sources, { translationUseful: source ? await translation.useful(source) : false, now });
        const fingerprint = store.hash(body);
        const reference = store.delivery(discovery.id, channel.id);
        const changed = reference.delivered_hash !== fingerprint || !reference.message_id;
        return { discovery, body, fingerprint, reference, changed };
      }))).filter(({ reference, changed }) => changed || !reference.checked_at ||
        now.getTime() - Date.parse(reference.checked_at) >= EXISTENCE_CHECK_MS)
        // New/edited cards first, then oldest existence checks: a busy room must
        // not permanently starve later cards behind the same first twenty.
        .sort((a, b) => Number(b.discovery.id === priorityDiscoveryId) - Number(a.discovery.id === priorityDiscoveryId) || Number(b.changed) - Number(a.changed) ||
          Date.parse(a.reference.checked_at || a.reference.started_at) - Date.parse(b.reference.checked_at || b.reference.started_at) || a.discovery.id - b.discovery.id);
      let failure = null;
      for (const { discovery, body, fingerprint, reference } of queue.slice(0, 20)) {
        try {
          const existing = await recoverMessage(channel, client, discovery, reference);
          // Restart from the head if a send succeeds but saving its ID crashes.
          if (!existing) store.saveRecoveryProgress(discovery.id, channel.id, null);
          const message = existing ? (reference.delivered_hash === fingerprint ? existing : await existing.edit(body)) : await channel.send({
            ...body, nonce: createHash("sha256").update(reference.token).digest("hex").slice(0, 24), enforceNonce: true,
          });
          store.saveDelivery(discovery.id, channel.id, message.id, fingerprint, now.toISOString());
        } catch (error) { failure = deliveryError(error); }
      }
      store.setDeliveryError(guildId, failure);
    } catch (error) { store.setDeliveryError(guildId, deliveryError(error)); }
  })();
  deliveries.set(guildId, job);
  try { await job; } finally { deliveries.delete(guildId); }
}
function deliveryError(error) {
  if (error.code === 50013 || error.code === 50001) return "Harmony cannot read or post in the Radar destination. Check its channel access.";
  if (error.code === "RADAR_RECOVERY_PENDING") return "Radar message recovery is continuing through saved channel history.";
  return "Radar delivery could not complete. Discoveries remain saved for review.";
}
function calendarModal(discovery) {
  const source = presentation.primarySource(discovery, store.supportingSources(discovery.id));
  const prefill = calendarPrefill(discovery, source);
  const modal = new ModalBuilder().setCustomId("harmony-radar:handoff:" + discovery.id).setTitle("Send to calendar review");
  for (const [id, label, value, required] of [
    ["date", "Calendar date YYYY-MM-DD", validDate(prefill.date) ? prefill.date : "", true],
    ["time", "Local time HH:MM (blank = date only)", prefill.time, false],
    ["timezone", "Time zone, such as America/New_York", prefill.timezone, false],
  ]) {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(id === "date" ? 10 : id === "time" ? 5 : 80);
    if (value) input.setValue(value);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}
async function performHandoff(client, guildId, discoveryId, actorId, details) {
  const discovery = store.getDiscovery(guildId, discoveryId);
  const settings = store.getSettings(guildId);
  if (!discovery || !settings?.enabled) throw new Error("This Radar discovery is unavailable.");
  if (!settings.calendar_guild_id) throw new Error("Configure a calendar server with /harmony-radar calendar-target before handoff.");
  const completed = discovery.handoff_result ? JSON.parse(discovery.handoff_result) : null;
  const pending = discovery.handoff_request ? JSON.parse(discovery.handoff_request) : null;
  const targetId = completed?.guildId || pending?.guildId || settings.calendar_guild_id;
  const target = client.guilds.cache.get(targetId) || await client.guilds.fetch(targetId);
  const actor = await target.members.fetch(actorId);
  const capabilities = await resolveAdminCapabilities({ guild: target, member: actor, userId: actorId });
  if (!capabilities.canDiagnose) throw new Error("Calendar handoff requires admin access in the selected calendar server.");
  if (completed) return { ...completed, replayed: true };
  if (pending) details = pending.details;
  const date = String(details.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + "T00:00:00Z")) ||
      new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date) {
    throw new Error("Provide a valid calendar date. The Radar discovery is still saved.");
  }
  const time = String(details.time || "").trim();
  const timezone = String(details.timezone || "").trim();
  if (timezone && !validTimezone(timezone)) throw new Error("Provide a valid time zone.");
  if (time && (!/^\d{2}:\d{2}$/.test(time) || !timezone)) throw new Error("A timed event needs HH:MM and a time zone.");
  const at = time ? localToUtc(date, time, timezone) : null;
  if (time && !at) throw new Error("The date or local time is invalid.");
  const sources = store.supportingSources(discovery.id);
  const source = sources[0];
  if (!source) throw new Error("This discovery has no saved source evidence.");
  // Existing candidate identity makes a retry safe even after a crash before saving the Radar reference.
  const input = {
    guildId: target.id, title: discovery.title, proposedEventDate: date,
    proposedEventAt: at?.toISOString() || null, proposedEventTimezone: timezone || null,
    sourceUrl: source.canonical_url, sourceProvider: "skz-radar", discoveryKey: "radar:" + guildId + ":" + discovery.id,
    sourceType: "radar_handoff", skipEnrichment: true, submitterId: actorId, submittedNote: discovery.summary,
    sourceMetadata: JSON.stringify({ allDay: !time }),
    sourceProvenance: sources.map((item) => ({
      provider: item.provider, sourceName: item.provider, sourceId: item.item_id,
      sourceUrl: item.canonical_url, originalTitle: item.title, retrievedAt: item.discovered_at,
    })),
  };
  // Freeze target, details and source across a crash between the calendar write and Radar save.
  const request = store.reserveHandoff(guildId, discovery.id, { guildId: target.id, details, input });
  if (request.guildId !== target.id) return performHandoff(client, guildId, discoveryId, actorId, details);
  const result = await submitCalendarCandidate(null, request.input);
  let outcome;
  if (result.candidate) outcome = { kind: "candidate", disposition: result.duplicate ? "existing_candidate" : "created_candidate",
    reason: result.duplicateReason || null, guildId: target.id, record: result.candidate };
  else if (result.canonicalEvent) {
    const event = store.calendarEvent(target.id, result.canonicalEvent.id);
    if (event) outcome = { kind: "event", disposition: "existing_event", reason: result.duplicateReason || null, guildId: target.id, record: event };
  }
  if (!outcome) throw new Error("Calendar did not return a candidate or existing event. The discovery remains saved.");
  store.saveHandoff(guildId, discovery.id, outcome);
  return outcome;
}
async function handoff(client, guildId, discoveryId, actorId, details) {
  // Serialize per discovery; each queued actor still passes its own target authorization.
  const key = guildId + ":" + discoveryId;
  const previous = handoffs.get(key) || Promise.resolve();
  const job = previous.catch(() => {}).then(() => performHandoff(client, guildId, discoveryId, actorId, details));
  handoffs.set(key, job);
  try {
    const outcome = await job;
    // Refresh existing review controls only: never install channels/panels or publish.
    const target = client.guilds.cache.get(outcome.guildId);
    if (target) await refreshConfiguredScheduleManagers(target).catch(() => {});
    return outcome;
  } finally { if (handoffs.get(key) === job) handoffs.delete(key); }
}
function handoffFeedback(outcome) {
  if (outcome.kind === "event") return "Linked to existing calendar event #" + outcome.record.id + ". No new event was published.";
  if (outcome.record.status !== "open") return "Linked to existing calendar candidate #" + outcome.record.id +
    " (" + outcome.record.status + "). Its existing decision was preserved; no new event was published.";
  const panel = calendarStore.getManagerPanel(outcome.guildId, "stray_kids");
  const location = panel?.channel_id && panel?.message_id
    ? `[Stray Kids Schedule Manager](https://discord.com/channels/${outcome.guildId}/${panel.channel_id}/${panel.message_id}) → **Review Discovered Events**`
    : "**Stray Kids Schedule Manager → Review Discovered Events**, or /harmony-calendar review in the configured calendar server";
  return `Saved calendar candidate #${outcome.record.id} for review (${outcome.record.proposed_event_date || "date pending"}).\nOpen ${location}.\n${panel ? "If the manager message is unavailable, use /harmony-calendar review in the configured calendar server.\n" : ""}It is awaiting explicit approval and will not appear on the published month calendar yet.`;
}
async function handleRadarInteraction(interaction) {
  const match = /^harmony-radar:(ignore|watch|calendar|handoff|translate):(\d+)$/.exec(interaction.customId || "");
  if (!match) return false;
  const [, action, rawId] = match;
  const isModal = interaction.isModalSubmit?.();
  if ((action === "handoff") !== Boolean(isModal)) return false;
  if (action !== "calendar") {
    if (isModal || action === "translate") await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else await interaction.deferUpdate();
  }
  const capabilities = await resolveAdminCapabilities({ guild: interaction.guild, member: interaction.member, userId: interaction.user?.id });
  const settings = store.getSettings(interaction.guildId);
  const discovery = store.getDiscovery(interaction.guildId, Number(rawId));
  if (!capabilities.canDiagnose || !settings?.enabled || !discovery ||
      interaction.channelId !== settings.channel_id) {
    const content = "Use Radar from its configured Harmony server channel with admin access.";
    if (interaction.deferred) {
      if (isModal || action === "translate") await interaction.editReply(content);
      else await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "translate") {
    if (!capabilities.isGuildOwner) {
      await interaction.editReply("Only the Harmony server owner can request translation.");
      return true;
    }
    const source = presentation.primarySource(discovery, store.supportingSources(discovery.id));
    if (!source) { await interaction.editReply("The original source is unavailable. Discovery remains saved."); return true; }
    await interaction.editReply("Translating to English…");
    const work = translation.request(source);
    await syncRadarChannel(interaction.client, interaction.guildId, { priorityDiscoveryId: discovery.id });
    const result = await work;
    const latest = presentation.primarySource(store.getDiscovery(interaction.guildId, discovery.id), store.supportingSources(discovery.id));
    const unchanged = latest && latest.id === source.id && store.hash([latest.title, latest.summary]) === store.hash([source.title, source.summary]);
    await syncRadarChannel(interaction.client, interaction.guildId, { priorityDiscoveryId: discovery.id });
    await interaction.editReply(!unchanged ? "Source changed during translation. No stale result was applied; request translation of the current source."
      : result.status === "ready" ? (store.getSettings(interaction.guildId)?.delivery_error
        ? "English translation saved; Discord card update unavailable. Cached result and discovery remain saved."
        : "English translation ready. Radar card refreshed.")
      : result.status === "skipped" ? "This source already appears to be English."
      : result.error === "translator_free_quota_exhausted" ? "Free translation allowance exhausted. No automatic retry or provider fallback."
      : result.status === "pending" ? "Translation is already in progress. No additional request was sent."
      : result.status === "unavailable" ? "Translation not configured. Discovery remains saved."
      : "Translation unavailable" + (result.error ? " (" + result.error + ")" : "") + ". Discovery remains saved; no automatic retry.");
    return true;
  }
  if (action === "calendar") {
    if (discovery.handoff_result) {
      await interaction.reply({ content: "This discovery has already completed its calendar handoff.", flags: MessageFlags.Ephemeral });
    } else if (!settings.calendar_guild_id) {
      await interaction.reply({ content: "Configure /harmony-radar calendar-target first. This discovery remains saved.", flags: MessageFlags.Ephemeral });
    } else await interaction.showModal(calendarModal(discovery));
    return true;
  }
  if (action === "handoff") {
    try {
      const outcome = await handoff(interaction.client, interaction.guildId, discovery.id, interaction.user.id, {
        date: interaction.fields.getTextInputValue("date"), time: interaction.fields.getTextInputValue("time"),
        timezone: interaction.fields.getTextInputValue("timezone"),
      });
      await interaction.editReply(handoffFeedback(outcome));
    } catch (error) {
      await interaction.editReply(error.message);
    }
  } else store.setReviewState(interaction.guildId, discovery.id, action === "ignore" ? "Ignored" : "Watching");
  await syncRadarChannel(interaction.client, interaction.guildId);
  return true;
}
module.exports = { payload, recoverMessage, syncRadarChannel, calendarModal, handoff, handoffFeedback, handleRadarInteraction };
