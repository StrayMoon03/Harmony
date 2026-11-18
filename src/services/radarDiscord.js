const { createHash } = require("node:crypto");
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, MessageFlags,
} = require("discord.js");
const store = require("../stores/radarStore");
const { resolveAdminCapabilities } = require("./operationsStatusService");
const { submitCalendarCandidate, localToUtc, validTimezone } = require("./eventSchedulerService");

const deliveries = new Map();
function payload(discovery, sources) {
  const source = sources[0];
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-radar:ignore:" + discovery.id).setLabel("Ignore").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("harmony-radar:watch:" + discovery.id).setLabel("Watch for Details").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("harmony-radar:calendar:" + discovery.id).setLabel("Add to Calendar").setStyle(ButtonStyle.Primary)
      .setDisabled(Boolean(discovery.calendar_candidate_id)),
  );
  const embed = new EmbedBuilder().setTitle(discovery.title.slice(0, 256))
    .setDescription((discovery.summary || "Open the source to review this announcement.").slice(0, 1800))
    .setColor(discovery.review_state === "Watching" ? 0xfee75c : 0x5865f2)
    .setFooter({ text: "SKZ Radar #" + discovery.id })
    .addFields(
      { name: "Review", value: discovery.review_state, inline: true },
      { name: "Category", value: discovery.category, inline: true },
      { name: "Confidence", value: discovery.confidence, inline: true },
      { name: "Timing", value: [
        source?.published_at ? "Published " + source.published_at : "Publication time unknown",
        "Discovered " + discovery.created_at,
        discovery.event_date ? "Calendar date " + discovery.event_date : "Event / release date unconfirmed",
      ].join("\n") },
      { name: "Calendar", value: discovery.calendar_candidate_id
        ? "Sent for calendar review as candidate #" + discovery.calendar_candidate_id + "."
        : discovery.calendar_eligibility + " — " + discovery.eligibility_reason },
      { name: "Supporting sources", value: sources.slice(0, 8)
        .map((item) => "[" + item.provider + " · " + item.authority + "](" + item.canonical_url + ")").join("\n").slice(0, 1024) || "Source unavailable" },
    );
  if (source) embed.setURL(source.canonical_url);
  const images = source ? JSON.parse(source.metadata).images : [];
  if (images?.[0]) embed.setImage(images[0]);
  return { embeds: [embed], components: [controls], allowedMentions: { parse: [] } };
}
async function recoverMessage(channel, client, discovery, reference) {
  if (reference.message_id) {
    try { return await channel.messages.fetch(reference.message_id); }
    catch (error) { if (error.code !== 10008) throw error; }
  }
  let before;
  for (let page = 0; page < 10; page++) {
    const history = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    for (const message of history.values()) {
      if (message.author?.id === client.user.id && message.embeds?.[0]?.footer?.text === "SKZ Radar #" + discovery.id) return message;
    }
    const oldest = [...history.values()].at(-1);
    if (!oldest || history.size < 100 || oldest.createdTimestamp < Date.parse(reference.started_at) - 60000) return null;
    before = oldest.id;
  }
  throw new Error("Radar message recovery reached its history limit. Check channel history before retrying delivery.");
}
async function syncRadarChannel(client, guildId) {
  if (deliveries.has(guildId)) return deliveries.get(guildId);
  const job = (async () => {
    const settings = store.getSettings(guildId);
    if (!settings?.enabled) return;
    try {
      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
      const channel = guild.channels.cache.get(settings.channel_id) || await guild.channels.fetch(settings.channel_id);
      if (!channel?.isTextBased() || !channel.messages?.fetch) throw new Error("Radar destination is unavailable.");
      let sent = 0;
      for (const discovery of store.listDiscoveries(guildId).reverse()) {
        const sources = store.supportingSources(discovery.id);
        const body = payload(discovery, sources);
        const fingerprint = store.hash(body);
        const reference = store.delivery(discovery.id, channel.id);
        if (reference.delivered_hash === fingerprint && reference.message_id) continue;
        const existing = await recoverMessage(channel, client, discovery, reference);
        const message = existing ? await existing.edit(body) : await channel.send({
          ...body, nonce: createHash("sha256").update(reference.token).digest("hex").slice(0, 24), enforceNonce: true,
        });
        store.saveDelivery(discovery.id, channel.id, message.id, fingerprint);
        if (++sent === 20) break;
      }
      store.setDeliveryError(guildId, null);
    } catch (error) {
      const message = error.code === 50013 || error.code === 50001
        ? "Harmony cannot read or post in the Radar destination. Check its channel access."
        : "Radar delivery could not complete. Discoveries remain saved for review.";
      store.setDeliveryError(guildId, message);
    }
  })();
  deliveries.set(guildId, job);
  try { await job; } finally { deliveries.delete(guildId); }
}
function calendarModal(discovery) {
  const modal = new ModalBuilder().setCustomId("harmony-radar:handoff:" + discovery.id).setTitle("Send to calendar review");
  for (const [id, label, value, required] of [
    ["date", "Calendar date YYYY-MM-DD", discovery.event_date || "", true],
    ["time", "Local time HH:MM (blank means all-day)", "", false],
    ["timezone", "Time zone, such as America/New_York", discovery.event_timezone || "", false],
  ]) {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(80);
    if (value) input.setValue(value);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}
async function handoff(client, guildId, discoveryId, actorId, details) {
  const discovery = store.getDiscovery(guildId, discoveryId);
  const settings = store.getSettings(guildId);
  if (!discovery || !settings?.enabled) throw new Error("This Radar discovery is unavailable.");
  if (!settings.calendar_guild_id) throw new Error("Configure a calendar server with /harmony-radar calendar-target before handoff.");
  const target = client.guilds.cache.get(settings.calendar_guild_id) || await client.guilds.fetch(settings.calendar_guild_id);
  const actor = await target.members.fetch(actorId);
  const capabilities = await resolveAdminCapabilities({ guild: target, member: actor, userId: actorId });
  if (!capabilities.canDiagnose) throw new Error("Calendar handoff requires admin access in the selected calendar server.");
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
  const source = store.supportingSources(discovery.id)[0];
  // Existing candidate identity makes a retry safe even after a crash before saving the Radar reference.
  const result = await submitCalendarCandidate(null, {
    guildId: target.id, title: discovery.title, proposedEventDate: date,
    proposedEventAt: at?.toISOString() || null, proposedEventTimezone: timezone || null,
    sourceUrl: source.canonical_url, sourceProvider: "skz-radar", discoveryKey: "radar:" + guildId + ":" + discovery.id,
    sourceType: "radar_handoff", skipEnrichment: true, submitterId: actorId, submittedNote: discovery.summary,
    sourceProvenance: store.supportingSources(discovery.id).map((item) => ({
      provider: item.provider, sourceName: item.provider, sourceId: item.item_id,
      sourceUrl: item.canonical_url, originalTitle: item.title, retrievedAt: item.discovered_at,
    })),
  });
  store.saveHandoff(guildId, discovery.id, target.id, result.candidate.id, { date, at: at?.toISOString() || null, timezone: timezone || null });
  return result.candidate;
}
async function handleRadarInteraction(interaction) {
  const match = /^harmony-radar:(ignore|watch|calendar|handoff):(\d+)$/.exec(interaction.customId || "");
  if (!match) return false;
  const [, action, rawId] = match;
  const isModal = interaction.isModalSubmit?.();
  if ((action === "handoff") !== Boolean(isModal)) return false;
  if (action !== "calendar") {
    if (isModal) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else await interaction.deferUpdate();
  }
  const capabilities = await resolveAdminCapabilities({ guild: interaction.guild, member: interaction.member, userId: interaction.user?.id });
  const settings = store.getSettings(interaction.guildId);
  const discovery = store.getDiscovery(interaction.guildId, Number(rawId));
  if (!capabilities.canDiagnose || !settings?.enabled || !discovery ||
      interaction.channelId !== settings.channel_id) {
    const content = "Use Radar from its configured Harmony server channel with admin access.";
    if (interaction.deferred) {
      if (isModal) await interaction.editReply(content);
      else await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "calendar") {
    if (!settings.calendar_guild_id) {
      await interaction.reply({ content: "Configure /harmony-radar calendar-target first. This discovery remains saved.", flags: MessageFlags.Ephemeral });
    } else await interaction.showModal(calendarModal(discovery));
    return true;
  }
  if (action === "handoff") {
    try {
      const candidate = await handoff(interaction.client, interaction.guildId, discovery.id, interaction.user.id, {
        date: interaction.fields.getTextInputValue("date"), time: interaction.fields.getTextInputValue("time"),
        timezone: interaction.fields.getTextInputValue("timezone"),
      });
      await interaction.editReply("Sent as calendar candidate #" + candidate.id + ". Review it with /harmony-calendar review in the configured calendar server.");
    } catch (error) {
      await interaction.editReply(error.message);
    }
  } else store.setReviewState(interaction.guildId, discovery.id, action === "ignore" ? "Ignored" : "Watching");
  await syncRadarChannel(interaction.client, interaction.guildId);
  return true;
}
module.exports = { payload, recoverMessage, syncRadarChannel, calendarModal, handoff, handleRadarInteraction };
