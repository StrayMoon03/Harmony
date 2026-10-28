const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");
const roomStore = require("../stores/adminRoomStore");
const guardStore = require("../stores/communityGuardStore");
const guardService = require("./communityGuardService");
const birthdayManager = require("./birthdayManagerService");
const welcomePassStore = require("../stores/welcomePassStore");
const greetingStore = require("../stores/greetingStore");
const memberCountStore = require("../stores/memberCountStore");
const collectionStore = require("../stores/collectionStore");
const messageLogStore = require("../stores/messageLogStore");
const errorInboxStore = require("../stores/errorInboxStore");
const errorMonitorStore = require("../stores/errorMonitorStore");
const { isAdminRoomAuthorized } = require("./adminAuthorization");
const statusCommand = require("../commands/status");

const HISTORY_PAGE_SIZE = 8;
const ADMIN_CONTROLS = [
  ["guard", "Harmony Guard", ButtonStyle.Primary],
  ["guard-history-open", "Guard History", ButtonStyle.Secondary],
  ["welcome", "Welcome Pass", ButtonStyle.Secondary],
  ["greetings", "Greetings", ButtonStyle.Secondary],
  ["members", "Member Counts", ButtonStyle.Secondary],
  ["collections", "Collections", ButtonStyle.Secondary],
  ["logs", "Message Logs", ButtonStyle.Secondary],
  ["birthdays", "Birthdays", ButtonStyle.Success],
  ["status", "Status / Health", ButtonStyle.Primary],
  ["media", "Media & Errors", ButtonStyle.Secondary],
];

function buildHomeComponents() {
  const buttons = ADMIN_CONTROLS.map(([action, label, style]) => new ButtonBuilder()
    .setCustomId(`harmony-admin-room:${action}`)
    .setLabel(label)
    .setStyle(style));
  return [
    new ActionRowBuilder().addComponents(...buttons.slice(0, 5)),
    new ActionRowBuilder().addComponents(...buttons.slice(5)),
  ];
}

async function buildHomePayload() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("💜 HARMONY ADMIN CONTROLS")
    .setDescription("Use these controls for Harmony’s community, system, and media tools. The Stray Kids and Youtiful Stays Schedule Manager panels in this channel remain your calendar controls.")
    .addFields(
      { name: "COMMUNITY", value: "Guard · Guard History · Welcome Pass · Greetings · Member Counts", inline: false },
      { name: "OTHER ADMIN TOOLS", value: "Collections · Message Logs · Birthdays · Status / Health · Media & Errors", inline: false },
    );
  return { embeds: [embed], components: buildHomeComponents(), allowedMentions: { parse: [] } };
}

function pagePayload(title, description, components = []) {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(description.slice(0, 4000));
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

function commandHelp(names) {
  return names.map(([command, purpose]) => `• \`/${command}\` — ${purpose}`).join("\n");
}

function mediaPage(guildId) {
  const commands = commandHelp([
    ["harmony-errors", "Configure or check the media error inbox"],
    ["harmony-monitor", "Control sanitized automatic error reporting"],
    ["harmony-forget", "Reset duplicate tracking for a specific shared post"],
  ]);
  const inbox = errorInboxStore.getErrorInboxSettings();
  const monitor = errorMonitorStore.getErrorMonitorSettings();
  const inboxState = !inbox?.enabled ? "Off or not configured" : inbox.destination_guild_id === guildId
    ? `On${inbox.destination_channel_id ? ` · <#${inbox.destination_channel_id}>` : ""}`
    : "On for the configured central server";
  const text = `Media error inbox: **${inboxState}**\nAutomatic error reporting: **${monitor.enabled ? "On" : "Off"}**\n\n${commands}\n\nSocial media retrieval runs through Harmony’s existing message pipeline. Session state is not actively tested here; use Status / Health for the current signals. Refresh Session appears only for explicit expiry evidence and authorized credential managers.`;
  return pagePayload("🎞️ Media & System", text, [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-status:open").setLabel("Status / Health").setStyle(ButtonStyle.Primary),
  )]);
}

async function guardPage(guild) {
  const settings = guardStore.getSettings(guild.id);
  const rules = guardStore.listRules(guild.id);
  const channel = settings?.channel_id ? `<#${settings.channel_id}>` : "Not configured";
  const room = settings?.channel_id
    ? (guild.channels.cache.get(settings.channel_id) || await guild.channels.fetch(settings.channel_id).catch(() => null))
    : null;
  const warning = settings?.channel_id
    ? guardService.reviewRoomVisibilityWarning(room)
    : "Choose a Review Room before enabling automatic Guard rules.";
  const text = [
    `Automatic monitoring: **${settings?.enabled ? "On" : "Off"}**`,
    `Review Room: ${channel}`,
    `Active rules: **${rules.length}**`,
    warning,
    "",
    commandHelp([
      ["harmony-guard setup", "choose or change the Review Room"],
      ["harmony-guard rules", "view configured rules"],
      ["harmony-guard rule-add", "add a rule"],
      ["harmony-guard rule-edit", "edit a rule"],
      ["harmony-guard off", "turn automatic monitoring off"],
    ]),
  ].join("\n");
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-admin-room:guard-history:0").setLabel("Moderation History").setStyle(ButtonStyle.Primary),
    ...(settings?.channel_id ? [new ButtonBuilder().setLabel("Open Review Room").setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${guild.id}/${settings.channel_id}`)] : []),
  )];
  return pagePayload("🛡️ Harmony Guard", text, rows);
}

function welcomePassPage(guildId) {
  const settings = welcomePassStore.getWelcomePassSettings(guildId);
  const text = settings
    ? `Setup: **Configured**\nGrant mode: **${settings.grant_mode || "automatic"}**\nRole: <@&${settings.role_id}>\nPrivate alerts: <#${settings.channel_id}>\nMember channel: <#${settings.release_channel_id}>\n\nApprovals come from the connected Welcome Pass site. Harmony processes the approval and role assignment; there is no Discord approval queue.`
    : "Welcome Pass is not configured for this server. Configure the role, alert channel, and member message using the existing setup command.";
  return pagePayload("🎟️ Welcome Pass", `${text}\n\n${commandHelp([
    ["harmony-pass-setup", "configure Welcome Pass role automation and messages"],
    ["harmony-pass-mode", "choose automatic or manual role granting"],
  ])}`);
}

function communityToolPage(guildId, area) {
  if (area === "guard") return null;
  if (area === "welcome") return welcomePassPage(guildId);
  if (area === "greetings") {
    const settings = greetingStore.getGreetingSettings(guildId);
    return pagePayload("👋 Greetings", `Status: **${settings ? (settings.enabled ? "On" : "Off") : "Not configured"}**${settings?.channel_id ? `\nChannel: <#${settings.channel_id}>` : ""}\n\n${commandHelp([["harmony-greetings", "setup, preview, test, or turn greetings off"]])}`);
  }
  if (area === "members") {
    const settings = memberCountStore.getMemberCountSettings(guildId);
    return pagePayload("📊 Member Counts", `Status: **${settings ? (settings.enabled ? "On" : "Off") : "Not configured"}**\n\n${commandHelp([["harmony-member-counts", "setup, refresh, check, or turn counters off"]])}`);
  }
  if (area === "collections") {
    const settings = collectionStore.getCollectionSettings(guildId);
    return pagePayload("💜 Collections", `Status: **${settings ? "Configured" : "Not configured"}**${settings ? `\nMilestones: **${settings.milestones_enabled ? "On" : "Off"}** · Weekly recap: **${settings.schedule_enabled ? "On" : "Off"}**\nChannel: <#${settings.channel_id}>` : ""}\n\n${commandHelp([["harmony-collection", "configure milestones, recaps, or check settings"]])}`);
  }
  if (area === "logs") {
    const settings = messageLogStore.getLogSettings(guildId);
    return pagePayload("🧾 Message Logs", `Status: **${settings ? (settings.enabled ? "On" : "Off") : "Not configured"}**${settings?.channel_id ? `\nLog channel: <#${settings.channel_id}>` : ""}\nRetention: **3 days**\n\n${commandHelp([["harmony-logs", "configure logging, exclusions, or status"]])}`);
  }
  return null;
}

function historyEntry(row) {
  const category = row.category ? (guardService.CATEGORY_LABELS[row.category] || row.category) : "Reason not retained";
  const result = row.result === "safe" ? "Marked Safe" : "Removed";
  const source = row.result === "safe" ? "Admin Review" : (row.source || "Moderation");
  const rule = row.rule_id ? `Rule #${row.rule_id}${row.rule_name ? ` · ${row.rule_name}` : ""}` : "Rule unavailable";
  const member = row.user_id ? `<@${row.user_id}>` : "Not recorded for this decision";
  const actor = row.actor_id ? `<@${row.actor_id}>` : "Not recorded";
  const dm = row.dm_delivered == null ? "N/A" : (row.dm_delivered ? "Delivered" : "Failed" );
  const timestamp = Math.floor(new Date(row.created_at).getTime() / 1000);
  return `**${result}** · ${source}\n<t:${timestamp}:f>\n${rule} · ${category}\nMember: ${member} · By: ${actor} · DM: ${dm}`;
}

function guardHistoryPayload(guildId, page = 0) {
  const total = guardStore.countHistory(guildId);
  const lastPage = Math.max(0, Math.ceil(total / HISTORY_PAGE_SIZE) - 1);
  const currentPage = Math.min(Math.max(0, Number(page) || 0), lastPage);
  const rows = guardStore.listHistory(guildId, { limit: HISTORY_PAGE_SIZE, offset: currentPage * HISTORY_PAGE_SIZE });
  const body = rows.length
    ? rows.map(historyEntry).join("\n\n")
    : "No saved Guard actions or Admin Review safe decisions were found.";
  const pager = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`harmony-admin-room:guard-history:${currentPage - 1}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 0),
    new ButtonBuilder().setCustomId(`harmony-admin-room:guard-history:${currentPage + 1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= lastPage),
    new ButtonBuilder().setCustomId("harmony-admin-room:guard:ephemeral").setLabel("Back to Guard").setStyle(ButtonStyle.Secondary),
  );
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("🛡️ Guard Moderation History")
    .setDescription(body.slice(0, 4000)).setFooter({ text: `Page ${currentPage + 1} of ${lastPage + 1} · ${total} saved decisions/actions · Message content is not shown.` });
  return { embeds: [embed], components: [pager], allowedMentions: { parse: [] } };
}

async function fetchChannel(guild, channelId) {
  return guild.channels.cache.get(channelId) || guild.channels.fetch(channelId).catch(() => null);
}

async function panelMessage(guild, panel) {
  const channel = await fetchChannel(guild, panel.channel_id);
  if (!channel?.isTextBased?.()) return { channel, message: null };
  const message = await channel.messages.fetch(panel.message_id).catch(() => null);
  return { channel, message };
}

async function validateRoomChannel(guild, channel) {
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) throw new Error("Choose a server text or announcement channel.");
  const permissions = channel.permissionsFor(guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages) || !permissions?.has(PermissionFlagsBits.EmbedLinks)) {
    throw new Error(`Harmony needs View Channel, Send Messages, and Embed Links in <#${channel.id}>.`);
  }
  return channel;
}

async function postHome(guild, client, channel) {
  const payload = await buildHomePayload(guild, client);
  return channel.send(payload);
}

async function deactivateOldPanel(guild, panel, exceptMessageId = null) {
  if (!panel || panel.message_id === exceptMessageId) return;
  const { message } = await panelMessage(guild, panel);
  if (message) await message.edit({ content: "Harmony Admin Room panel moved or turned off. Use `/harmony-admin-room` to manage the active panel.", embeds: [], components: [] }).catch(() => {});
}

async function setupAdminRoom(interaction) {
  if (!isAdminRoomAuthorized(interaction)) return interaction.reply({ content: "Only server admins can manage the Harmony Admin Room.", flags: MessageFlags.Ephemeral });
  if (!interaction.guild) return interaction.reply({ content: "Use this command inside a server.", flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const action = interaction.options.getSubcommand();
  const existing = roomStore.getPanel(interaction.guildId);
  try {
    if (action === "off") {
      if (!existing || !existing.enabled) return interaction.editReply("The Harmony Admin Room is already off.");
      await deactivateOldPanel(interaction.guild, existing);
      roomStore.setEnabled(interaction.guildId, false);
      return interaction.editReply("Harmony Admin Room is off. Its panel is inactive; Harmony’s commands and services are unchanged.");
    }

    if (action === "refresh") {
      if (!existing || !existing.enabled) return interaction.editReply("No active Admin Room is installed. Use `/harmony-admin-room install` first.");
      const { channel, message } = await panelMessage(interaction.guild, existing);
      if (!channel?.isTextBased?.()) return interaction.editReply("The saved Admin Room channel is unavailable. Use `/harmony-admin-room move` to choose a new channel.");
      const payload = await buildHomePayload(interaction.guild, interaction.client);
      if (message) await message.edit(payload);
      else {
        const replacement = await postHome(interaction.guild, interaction.client, channel);
        roomStore.savePanel({ guildId: interaction.guildId, channelId: channel.id, messageId: replacement.id, enabled: true });
      }
      return interaction.editReply("Harmony Admin Room panel refreshed.");
    }

    const channel = await validateRoomChannel(interaction.guild, interaction.options.getChannel("channel", true));
    if (action === "install" && existing?.enabled) return interaction.editReply("An Admin Room is already active. Use `move` or `refresh` to manage it.");
    if (action === "move" && !existing?.enabled) return interaction.editReply("No active Admin Room exists. Use `install` to choose its first channel.");
    const posted = await postHome(interaction.guild, interaction.client, channel);
    await deactivateOldPanel(interaction.guild, existing, posted.id);
    roomStore.savePanel({ guildId: interaction.guildId, channelId: channel.id, messageId: posted.id, enabled: true });
    return interaction.editReply(`Harmony Admin Room ${action === "move" ? "moved" : "installed"} in <#${channel.id}>.`);
  } catch (error) {
    return interaction.editReply(error.message || "Harmony could not update the Admin Room.");
  }
}

async function refreshConfiguredAdminRooms(client) {
  for (const panel of roomStore.getEnabledPanels()) {
    const guild = client.guilds.cache.get(panel.guild_id);
    if (!guild) continue;
    try {
      const { channel, message } = await panelMessage(guild, panel);
      if (!channel?.isTextBased?.()) continue;
      const payload = await buildHomePayload(guild, client);
      if (message) await message.edit(payload);
      else {
        const replacement = await postHome(guild, client, channel);
        roomStore.savePanel({ guildId: guild.id, channelId: channel.id, messageId: replacement.id, enabled: true });
      }
    } catch (error) {
      console.warn("Admin Room startup refresh failed", { guildId: panel.guild_id, error: error.message });
    }
  }
}

async function handleAdminRoomInteraction(interaction) {
  if (!interaction.customId?.startsWith("harmony-admin-room:")) return false;
  if (!interaction.guild || !isAdminRoomAuthorized(interaction)) {
    await interaction.reply({ content: "Only authorized server admins can use the Harmony Admin Room.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }
  const [, action, parameter] = interaction.customId.split(":");
  const panelActions = new Set(["guard", "guard-history-open", "welcome", "greetings", "members", "collections", "logs", "birthdays", "status", "media"]);
  if (panelActions.has(action) && !(action === "guard" && parameter === "ephemeral")) {
    const active = roomStore.getPanel(interaction.guildId);
    if (!active?.enabled || active.message_id !== interaction.message?.id || active.channel_id !== interaction.channelId) {
      await interaction.reply({ content: "This Admin Room panel is no longer active. Use the current panel or ask an admin to install it.", flags: MessageFlags.Ephemeral });
      return true;
    }
  }
  if (action === "panel-refresh") {
    const saved = roomStore.getPanel(interaction.guildId);
    if (!saved?.enabled || saved.message_id !== interaction.message?.id) {
      await interaction.reply({ content: "This is not the active Admin Room panel.", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.deferUpdate();
    await interaction.message.edit(await buildHomePayload(interaction.guild, interaction.client));
    return true;
  }
  if (action === "status") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await statusCommand.respondWithStatus(interaction);
    return true;
  }
  if (action === "guard") {
    const payload = await guardPage(interaction.guild);
    if (parameter === "ephemeral") await interaction.update(payload);
    else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "guard-history-open") {
    await interaction.reply({ ...guardHistoryPayload(interaction.guildId), flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "birthdays") {
    await interaction.reply({ content: birthdayManager.birthdayManagerContent(interaction.guildId), components: birthdayManager.birthdayManagerComponents(), flags: MessageFlags.Ephemeral });
    return true;
  }
  if (["welcome", "greetings", "members", "collections", "logs"].includes(action)) {
    const area = action === "welcome" ? "welcome" : action;
    const payload = communityToolPage(interaction.guildId, area);
    if (payload) await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "media") {
    await interaction.reply({ ...mediaPage(interaction.guildId), flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "guard-history") {
    await interaction.update(guardHistoryPayload(interaction.guildId, Number(parameter) || 0));
    return true;
  }
  return false;
}

const data = new (require("discord.js").SlashCommandBuilder)()
  .setName("harmony-admin-room")
  .setDescription("Install and manage Harmony’s Admin Room panel")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) => sub.setName("install").setDescription("Install the Admin Room in a channel")
    .addChannelOption((option) => option.setName("channel").setDescription("Admin Room channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
  .addSubcommand((sub) => sub.setName("move").setDescription("Move the Admin Room to another channel")
    .addChannelOption((option) => option.setName("channel").setDescription("New Admin Room channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
  .addSubcommand((sub) => sub.setName("refresh").setDescription("Refresh or restore the installed Admin Room panel"))
  .addSubcommand((sub) => sub.setName("off").setDescription("Turn off the Admin Room panel"));

module.exports = {
  data,
  execute: setupAdminRoom,
  buildHomePayload,
  buildHomeComponents,
  mediaPage,
  guardPage,
  guardHistoryPayload,
  handleAdminRoomInteraction,
  refreshConfiguredAdminRooms,
  HISTORY_PAGE_SIZE,
};
