const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require("discord.js");
const roomStore = require("../stores/adminRoomStore");
const guardStore = require("../stores/communityGuardStore");
const guardService = require("./communityGuardService");
const statusService = require("./operationsStatusService");
const eventStore = require("../stores/eventSchedulerStore");
const calendarService = require("./eventSchedulerService");
const birthdayManager = require("./birthdayManagerService");
const welcomePassStore = require("../stores/welcomePassStore");
const greetingStore = require("../stores/greetingStore");
const memberCountStore = require("../stores/memberCountStore");
const collectionStore = require("../stores/collectionStore");
const messageLogStore = require("../stores/messageLogStore");
const errorInboxStore = require("../stores/errorInboxStore");
const errorMonitorStore = require("../stores/errorMonitorStore");
const { isAdminRoomAuthorized } = require("./adminAuthorization");

const HISTORY_PAGE_SIZE = 8;
const STATUS_ICONS = Object.freeze({
  [statusService.STATUS.healthy]: "🟢",
  [statusService.STATUS.attention]: "🟡",
  [statusService.STATUS.owner]: "🔴",
  [statusService.STATUS.unknown]: "⚪",
});
const HOME_CATEGORIES = [
  { label: "Calendar & Events", value: "calendar", description: "Schedules, discovery, birthdays, and Discord events" },
  { label: "Community", value: "community", description: "Guard, Welcome Pass, and community tools" },
  { label: "Media & System", value: "media", description: "Health, social sessions, and error tools" },
];
const COMMUNITY_AREAS = [
  { label: "Harmony Guard", value: "guard" },
  { label: "Welcome Pass", value: "welcome" },
  { label: "Greetings", value: "greetings" },
  { label: "Member Counts", value: "members" },
  { label: "Collections", value: "collections" },
  { label: "Message Logs", value: "logs" },
];

function statusIcon(status) { return STATUS_ICONS[status] || STATUS_ICONS[statusService.STATUS.unknown]; }

function summaryStatus(rows, ids) {
  const selected = rows.filter((row) => ids.includes(row.id));
  if (!selected.length) return statusService.STATUS.unknown;
  if (selected.some((row) => row.status === statusService.STATUS.owner)) return statusService.STATUS.owner;
  if (selected.some((row) => row.status === statusService.STATUS.attention)) return statusService.STATUS.attention;
  if (selected.every((row) => row.status === statusService.STATUS.healthy)) return statusService.STATUS.healthy;
  return statusService.STATUS.unknown;
}

function buildHomeComponents() {
  return [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId("harmony-admin-room:category")
      .setPlaceholder("Choose an Admin Room section")
      .addOptions(HOME_CATEGORIES.map((item) => ({ ...item })))),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-status:open").setLabel("Status / Health").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("harmony-admin-room:panel-refresh").setLabel("Refresh Home Summary").setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function buildHomePayload(guild, client, { statusRows } = {}) {
  let rows = statusRows;
  if (!rows) rows = await statusService.collectStatus({ guild, client });
  const attention = rows.filter((row) => [statusService.STATUS.attention, statusService.STATUS.owner].includes(row.status));
  const discord = rows.find((row) => row.id === "discord");
  const database = rows.find((row) => row.id === "database");
  const discovery = rows.find((row) => row.id === "discovery");
  const guard = rows.find((row) => row.id === "guard");
  const events = rows.find((row) => row.id === "event-sync");
  const social = summaryStatus(rows, ["social-instagram", "social-threads", "social-facebook", "social-youtube"]);
  const embed = new EmbedBuilder()
    .setColor(attention.length ? 0xfee75c : 0x5865f2)
    .setTitle("💜 HARMONY ADMIN ROOM")
    .setDescription("Your central place to check Harmony and open its existing admin tools.")
    .addFields(
      { name: "SYSTEM", value: `Harmony ${statusIcon(discord?.status)}  ·  Discord ${statusIcon(discord?.status)}  ·  Database ${statusIcon(database?.status)}\n${attention.length ? `Needs attention: **${attention.length}**` : "No current local alerts."}`, inline: false },
      { name: "CALENDAR & EVENTS", value: `Discovery ${statusIcon(discovery?.status)}  ·  Event sync ${statusIcon(events?.status)}  ·  Birthdays open from this section`, inline: false },
      { name: "COMMUNITY & MEDIA", value: `Guard ${statusIcon(guard?.status)}  ·  Social sessions ${statusIcon(social)}\n⚪ means not configured or not currently verifiable. Social platforms are not probed from this panel.`, inline: false },
    )
    .setFooter({ text: `Updated ${new Date().toISOString()} · Use Status / Health for the full report.` });
  return { embeds: [embed], components: buildHomeComponents(), allowedMentions: { parse: [] } };
}

function homeEphemeralButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-admin-room:home").setLabel("Admin Room Home").setStyle(ButtonStyle.Secondary)
  );
}

function pagePayload(title, description, components = []) {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(description.slice(0, 4000));
  return { embeds: [embed], components: [...components, homeEphemeralButton()], allowedMentions: { parse: [] } };
}

function jumpButton(label, guildId, panel) {
  if (!panel?.channel_id || !panel?.message_id) return null;
  return new ButtonBuilder()
    .setLabel(label)
    .setStyle(ButtonStyle.Link)
    .setURL(`https://discord.com/channels/${guildId}/${panel.channel_id}/${panel.message_id}`);
}

function commandHelp(names) {
  return names.map(([command, purpose]) => `• \`/${command}\` — ${purpose}`).join("\n");
}

function calendarPage(guildId) {
  const stray = jumpButton("Open Stray Kids Schedule Manager", guildId, eventStore.getManagerPanel(guildId, "stray_kids"));
  const community = jumpButton("Open Youtiful Stays Schedule Manager", guildId, eventStore.getManagerPanel(guildId, "community"));
  const rows = [];
  const managerButtons = [stray, community].filter(Boolean);
  if (managerButtons.length) rows.push(new ActionRowBuilder().addComponents(...managerButtons));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-admin-room:discovery").setLabel("Check Event Discovery").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("harmony-admin-room:review").setLabel("Review Discovered Events").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("harmony-admin-room:reconcile").setLabel("Reconcile Discord Events").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("harmony-admin-room:birthdays").setLabel("Birthday Manager").setStyle(ButtonStyle.Success),
  ));
  let text = `Open either existing Schedule Manager, run the official schedule check, review submitted/discovered candidates, or reconcile Discord Scheduled Events.\n\nDirect command access: ${commandHelp([
    ["harmony-schedule", "create, list, cancel, edit, and publish calendar events"],
    ["harmony-calendar", "submit, discover, review, and reconcile events"],
  ])}`;
  if (!stray || !community) text += "\n\nA missing manager link means that panel has not been installed yet. Use `/harmony-schedule setup-manager` to install or refresh it.";
  return pagePayload("📅 Calendar & Events", text, rows);
}

function communityPage() {
  const select = new StringSelectMenuBuilder().setCustomId("harmony-admin-room:community-area")
    .setPlaceholder("Choose a community tool")
    .addOptions(COMMUNITY_AREAS.map((area) => ({ label: area.label, value: area.value })));
  return pagePayload("👥 Community", "Choose an existing community system to view its current setup and open its established controls.", [new ActionRowBuilder().addComponents(select)]);
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
    new ButtonBuilder().setCustomId("harmony-admin-room:community-guard").setLabel("Back to Guard").setStyle(ButtonStyle.Secondary),
  );
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("🛡️ Guard Moderation History")
    .setDescription(body.slice(0, 4000)).setFooter({ text: `Page ${currentPage + 1} of ${lastPage + 1} · ${total} saved decisions/actions · Message content is not shown.` });
  return { embeds: [embed], components: [pager, homeEphemeralButton()], allowedMentions: { parse: [] } };
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

async function discoveryResult(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { runDiscovery } = require("./calendarDiscoveryService");
  const result = await runDiscovery(interaction.client, { guildIds: [interaction.guildId] });
  if (result.locked) return interaction.editReply("A discovery check is already running. Please try again shortly.");
  const totals = result.results.reduce((sum, item) => ({
    fetched: sum.fetched + (item.fetched || 0), newCount: sum.newCount + (item.newCount || 0),
    updated: sum.updated + (item.updated || 0), duplicate: sum.duplicate + (item.duplicate || 0),
    failed: sum.failed + (item.ok ? 0 : 1),
  }), { fetched: 0, newCount: 0, updated: 0, duplicate: 0, failed: 0 });
  return interaction.editReply(`Official schedule check complete. Fetched ${totals.fetched}; new ${totals.newCount}; updated ${totals.updated}; already known ${totals.duplicate}${totals.failed ? `; failed ${totals.failed}` : ""}. No calendar event was created automatically.`);
}

async function handleAdminRoomInteraction(interaction) {
  if (!interaction.customId?.startsWith("harmony-admin-room:")) return false;
  if (!interaction.guild || !isAdminRoomAuthorized(interaction)) {
    await interaction.reply({ content: "Only authorized server admins can use the Harmony Admin Room.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }
  const [, action, parameter] = interaction.customId.split(":");
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
  if (action === "category") {
    const active = roomStore.getPanel(interaction.guildId);
    if (!active?.enabled || active.message_id !== interaction.message?.id || active.channel_id !== interaction.channelId) {
      await interaction.reply({ content: "This Admin Room panel is no longer active. Use the current panel or ask an admin to install it.", flags: MessageFlags.Ephemeral });
      return true;
    }
  }
  if (action === "home") {
    await interaction.update(await buildHomePayload(interaction.guild, interaction.client));
    return true;
  }
  if (action === "category" && interaction.isStringSelectMenu?.()) {
    const selected = interaction.values[0];
    const payload = selected === "calendar" ? calendarPage(interaction.guildId)
      : selected === "community" ? communityPage()
        : mediaPage(interaction.guildId);
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "discovery") { await discoveryResult(interaction); return true; }
  if (action === "review") {
    const payload = calendarService.discoveredCandidatePickerPayload(interaction.guildId);
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "reconcile") {
    const payload = await calendarService.nativeReconciliationPickerPayload(interaction.guild);
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "birthdays") {
    await interaction.reply({ content: birthdayManager.birthdayManagerContent(interaction.guildId), components: birthdayManager.birthdayManagerComponents(), flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "community-area" && interaction.isStringSelectMenu?.()) {
    const selected = interaction.values[0];
    const payload = selected === "guard" ? await guardPage(interaction.guild) : communityToolPage(interaction.guildId, selected);
    if (!payload) return false;
    await interaction.update(payload);
    return true;
  }
  if (action === "community-guard") {
    await interaction.update(await guardPage(interaction.guild));
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
  calendarPage,
  communityPage,
  mediaPage,
  guardPage,
  guardHistoryPayload,
  handleAdminRoomInteraction,
  refreshConfiguredAdminRooms,
  HISTORY_PAGE_SIZE,
};
