const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
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
const GUARD_RULE_PAGE_SIZE = 5;
const GUARD_RULE_PICKER_PAGE_SIZE = 25;
const REQUESTED_GUARD_REVIEW_ROOM_ID = "1554747061252005938";
const guardManagerSessions = new Map();
const GUARD_SESSION_TTL_MS = 15 * 60 * 1000;
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

async function guardPage(guild, notice = null) {
  const settings = guardStore.getSettings(guild.id);
  const rules = guardStore.listRules(guild.id);
  const channel = settings?.channel_id ? `<#${settings.channel_id}>` : "Not configured";
  const room = settings?.channel_id
    ? (guild.channels.cache.get(settings.channel_id) || await guild.channels.fetch(settings.channel_id).catch(() => null))
    : null;
  const warning = settings?.channel_id
    ? guardService.reviewRoomVisibilityWarning(room)
    : "Choose a Review Room before enabling automatic Guard rules.";
  const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle("🛡️ Harmony Guard Manager")
    .setDescription([
      notice,
      `**Monitoring:** ${settings?.enabled ? "On" : "Off"}`,
      `**Review Room:** ${channel}`,
      `**Active rules:** ${rules.length}`,
      warning,
    ].filter(Boolean).join("\n\n"));
  const monitoringLabel = settings?.enabled ? "Turn Monitoring Off" : "Turn Monitoring On";
  const monitoringStyle = settings?.enabled ? ButtonStyle.Danger : ButtonStyle.Success;
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("harmony-admin-room:guard-room").setLabel("Review Room").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("harmony-admin-room:guard-toggle").setLabel(monitoringLabel).setStyle(monitoringStyle),
        new ButtonBuilder().setCustomId("harmony-admin-room:guard-rules:0").setLabel("Rules").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("harmony-admin-room:guard-add").setLabel("Add Rule").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("harmony-admin-room:guard-edit").setLabel("Edit Rule").setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("harmony-admin-room:guard-remove").setLabel("Remove Rule").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("harmony-admin-room:guard-history:0").setLabel("Moderation History").setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

function guardSessionKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

function getGuardSession(interaction, expectedKind = null) {
  const key = guardSessionKey(interaction);
  const session = guardManagerSessions.get(key);
  if (!session || Date.now() - session.updatedAt > GUARD_SESSION_TTL_MS || (expectedKind && session.kind !== expectedKind)) {
    guardManagerSessions.delete(key);
    return null;
  }
  session.updatedAt = Date.now();
  return session;
}

function setGuardSession(interaction, session) {
  session.updatedAt = Date.now();
  guardManagerSessions.set(guardSessionKey(interaction), session);
}

function clearGuardSession(interaction) {
  guardManagerSessions.delete(guardSessionKey(interaction));
}

function rulePickerPayload(guildId, mode, page = 0) {
  const rules = guardStore.listRules(guildId);
  const pageCount = Math.max(1, Math.ceil(rules.length / GUARD_RULE_PICKER_PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, Number(page) || 0), pageCount - 1);
  const visible = rules.slice(currentPage * GUARD_RULE_PICKER_PAGE_SIZE, (currentPage + 1) * GUARD_RULE_PICKER_PAGE_SIZE);
  const components = [];
  if (visible.length) {
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`harmony-admin-room:guard-${mode}-select`)
      .setPlaceholder(mode === "edit" ? "Choose a rule to edit" : "Choose a rule to remove")
      .addOptions(visible.map((rule) => ({
        label: `#${rule.id} ${String(rule.name || guardService.conditionLabel(guardService.normalizeConditions(rule)[0])).slice(0, 85)}`,
        value: String(rule.id),
        description: `${guardService.CATEGORY_LABELS[rule.category] || rule.category} · ${rule.action === "remove" ? "Automatic Removal" : "Admin Review"}`.slice(0, 100),
      })))));
  }
  const pageButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`harmony-admin-room:guard-${mode}-page:${currentPage - 1}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 0),
    new ButtonBuilder().setCustomId(`harmony-admin-room:guard-${mode}-page:${currentPage + 1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= pageCount - 1),
    new ButtonBuilder().setCustomId("harmony-admin-room:guard-cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
  components.push(pageButtons);
  const body = rules.length ? `Choose one of ${rules.length} active rules. Page ${currentPage + 1} of ${pageCount}.` : "There are no active rules to choose.";
  return pagePayload(mode === "edit" ? "Edit a Guard Rule" : "Remove a Guard Rule", body, components);
}

function ruleListPayload(guildId, page = 0) {
  const rules = guardStore.listRules(guildId);
  const lastPage = Math.max(0, Math.ceil(rules.length / GUARD_RULE_PAGE_SIZE) - 1);
  const currentPage = Math.min(Math.max(0, Number(page) || 0), lastPage);
  const visible = rules.slice(currentPage * GUARD_RULE_PAGE_SIZE, (currentPage + 1) * GUARD_RULE_PAGE_SIZE);
  const description = visible.length
    ? visible.map(guardService.formatRule).join("\n\n")
    : "No Guard rules have been added yet.";
  const controls = [];
  if (rules.length > GUARD_RULE_PAGE_SIZE) {
    controls.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`harmony-admin-room:guard-rules:${currentPage - 1}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 0),
      new ButtonBuilder().setCustomId(`harmony-admin-room:guard-rules:${currentPage + 1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= lastPage),
    ));
  }
  controls.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId("harmony-admin-room:guard:ephemeral").setLabel("Back to Guard").setStyle(ButtonStyle.Secondary)));
  const payload = pagePayload("🛡️ Harmony Guard Rules", description, controls);
  payload.embeds[0].setFooter({ text: `Page ${currentPage + 1} of ${lastPage + 1} · ${rules.length} active rules` });
  return payload;
}

function reviewRoomPayload(guild) {
  const settings = guardStore.getSettings(guild.id);
  const components = [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
    .setCustomId("harmony-admin-room:guard-room-select")
    .setPlaceholder("Choose a text channel for Guard reviews and logs")
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1))];
  components.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId("harmony-admin-room:guard:ephemeral").setLabel("Back to Guard").setStyle(ButtonStyle.Secondary)));
  const current = settings?.channel_id ? `<#${settings.channel_id}>` : "Not configured";
  return pagePayload("Guard Review Room", `Current Review Room: **${current}**\nChoose a server text channel. Changing the room preserves Monitoring On/Off.`, components);
}

function guardConditionTypePayload(session) {
  const descriptions = session.conditions.length
    ? `Current conditions:\n${session.conditions.map((condition, i) => `${i + 1}. ${guardService.conditionLabel(condition)}`).join("\n")}\n\nChoose the next condition type.`
    : "Choose the first condition type. Text, domain, and URL conditions will ask for a value; attachment conditions do not need one.";
  return pagePayload("Add a Rule Condition", descriptions, [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId("harmony-admin-room:guard-condition-type")
      .setPlaceholder("Choose a condition type")
      .addOptions(guardService.RULE_TYPE_CHOICES.map(({ name, value }) => ({ label: name, value })))),
    new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId("harmony-admin-room:guard-condition-cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)),
  ]);
}

function guardConditionsPayload(session) {
  const description = session.conditions.length
    ? `Conditions:\n${session.conditions.map((condition, index) => `${index + 1}. ${guardService.conditionLabel(condition)}`).join("\n")}\n\nYou can add up to ${5 - session.conditions.length} more.`
    : "No conditions have been added yet.";
  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-admin-room:guard-condition-add").setLabel("Add Condition").setStyle(ButtonStyle.Secondary).setDisabled(session.conditions.length >= 5),
    new ButtonBuilder().setCustomId("harmony-admin-room:guard-condition-done").setLabel("Continue").setStyle(ButtonStyle.Primary).setDisabled(session.conditions.length === 0),
    new ButtonBuilder().setCustomId("harmony-admin-room:guard-cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  )];
  return pagePayload("Guard Rule Conditions", description, components);
}

function choiceRow(customId, placeholder, choices, selected) {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(choices.map((choice) => ({ label: choice.name, value: choice.value, default: choice.value === selected }))));
}

function guardRuleDetailsPayload(session) {
  const isEdit = session.kind === "edit";
  const conditions = session.conditions.map((condition, index) => `${index + 1}. ${guardService.conditionLabel(condition)}`).join("\n") || "No conditions added.";
  const components = [
    choiceRow("harmony-admin-room:guard-detail-reason", "Choose a reason", guardService.REASON_CHOICES, session.category),
    choiceRow("harmony-admin-room:guard-detail-mode", "Choose how conditions match", guardService.MATCH_CHOICES, session.matchMode),
    choiceRow("harmony-admin-room:guard-detail-action", "Choose what Harmony does", guardService.ACTION_CHOICES, session.action),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-admin-room:guard-detail-name").setLabel(session.name ? "Change Rule Name" : "Set Rule Name").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-admin-room:guard-condition-replace").setLabel(isEdit ? "Replace Conditions" : "Add Conditions").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-admin-room:guard-detail-save").setLabel(isEdit ? "Save Changes" : "Create Rule").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("harmony-admin-room:guard-cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    ),
  ];
  return pagePayload(isEdit ? `Edit Rule #${session.ruleId}` : "New Guard Rule", `**Conditions**\n${conditions}\n\n**Name:** ${session.name || "No name"}\n**Reason:** ${guardService.CATEGORY_LABELS[session.category] || "Choose a reason"}\n**Match:** ${String(session.matchMode || "all").toUpperCase()}\n**Action:** ${session.action === "remove" ? "Automatic Removal + private DM" : "Admin Review"}`, components);
}

function guardRemoveConfirmPayload(rule) {
  return pagePayload(`Remove Guard Rule #${rule.id}?`, `${guardService.formatRule(rule)}\n\nThis removes the rule from active monitoring.`, [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-admin-room:guard-remove-confirm").setLabel("Confirm Remove").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("harmony-admin-room:guard-cancel").setLabel("Keep Rule").setStyle(ButtonStyle.Secondary),
    ),
  ]);
}

function conditionValueModal() {
  const input = new TextInputBuilder().setCustomId("value").setLabel("Text, website/domain, or URL pattern")
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300);
  return new ModalBuilder().setCustomId("harmony-admin-room:guard-condition-value")
    .setTitle("Guard Condition Value").addComponents(new ActionRowBuilder().addComponents(input));
}

function ruleNameModal(name = null) {
  const input = new TextInputBuilder().setCustomId("name").setLabel("Rule name (leave blank for no name)")
    .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80);
  if (name) input.setValue(name.slice(0, 80));
  return new ModalBuilder().setCustomId("harmony-admin-room:guard-rule-name")
    .setTitle("Guard Rule Name").addComponents(new ActionRowBuilder().addComponents(input));
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

async function configureRequestedGuardReviewRoom(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const channel = guild.channels.cache.get(REQUESTED_GUARD_REVIEW_ROOM_ID) ||
        await guild.channels.fetch(REQUESTED_GUARD_REVIEW_ROOM_ID).catch(() => null);
      if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText || !guild.members?.me) continue;
      const permissions = channel.permissionsFor(guild.members.me);
      if (!permissions?.has(PermissionFlagsBits.ViewChannel) ||
        !permissions?.has(PermissionFlagsBits.SendMessages) ||
        !permissions?.has(PermissionFlagsBits.EmbedLinks)) continue;
      const settings = guardStore.getSettings(guild.id);
      // Seed the owner-confirmed destination only when Guard has no Review Room.
      // An administrator's later selection must survive future restarts.
      if (!settings?.channel_id) guardStore.setReviewRoom(guild.id, channel.id);
      return { guildId: guild.id, channelId: settings?.channel_id || channel.id, changed: !settings?.channel_id };
    } catch (error) {
      console.warn("Harmony Guard Review Room initialization skipped for a guild", { guildId: guild.id, error: error.message });
    }
  }
  return null;
}

function newAddRuleSession() {
  return { kind: "add", conditions: [], replaceConditions: true, name: null, category: null, matchMode: "all", action: "flag" };
}

function editRuleSession(rule) {
  return {
    kind: "edit", ruleId: rule.id, original: rule,
    conditions: guardService.normalizeConditions(rule).map(({ type, value }) => value == null ? { type } : { type, value }),
    replaceConditions: false, name: rule.name || null, category: rule.category,
    matchMode: rule.match_mode || "all", action: rule.action || "flag",
  };
}

function getLiveRule(interaction, session) {
  return session?.ruleId ? guardStore.getRule(interaction.guildId, Number(session.ruleId)) : null;
}

async function saveGuardRule(interaction, session) {
  try {
    let notice;
    if (session.kind === "add") {
      const id = guardService.createRule({
        guildId: interaction.guildId,
        name: session.name,
        conditions: session.conditions,
        matchMode: session.matchMode,
        category: session.category,
        action: session.action,
      });
      notice = `Rule #${id} was added. ${session.action === "remove" ? "Automatic Removal + private DM" : "Admin Review"} is set.`;
    } else {
      const saved = guardService.editRule(interaction.guildId, session.ruleId, {
        name: session.name,
        category: session.category,
        action: session.action,
        matchMode: session.matchMode,
        conditions: session.replaceConditions ? session.conditions : undefined,
      });
      if (!saved) throw new Error("That Guard rule is no longer active.");
      notice = `Rule #${session.ruleId} was updated.`;
    }
    clearGuardSession(interaction);
    await interaction.update(await guardPage(interaction.guild, notice));
  } catch (error) {
    await interaction.reply({ content: error.message || "Harmony couldn’t save that Guard rule.", flags: MessageFlags.Ephemeral });
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
  if (action === "guard-room") {
    await interaction.update(reviewRoomPayload(interaction.guild));
    return true;
  }
  if (action === "guard-room-select") {
    const channelId = interaction.values?.[0];
    const channel = channelId && (interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null));
    if (!channel || channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: "Choose a text channel in this server for the Guard Review Room.", flags: MessageFlags.Ephemeral });
      return true;
    }
    const permissions = channel.permissionsFor(interaction.guild.members.me);
    if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages) || !permissions?.has(PermissionFlagsBits.EmbedLinks)) {
      await interaction.reply({ content: `Harmony needs View Channel, Send Messages, and Embed Links in <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
      return true;
    }
    guardStore.setReviewRoom(interaction.guildId, channel.id);
    const warning = guardService.reviewRoomVisibilityWarning(channel);
    await interaction.update(await guardPage(interaction.guild, `Review Room set to <#${channel.id}>. ${warning}`));
    return true;
  }
  if (action === "guard-toggle") {
    const settings = guardStore.getSettings(interaction.guildId);
    if (!settings?.channel_id && !settings?.enabled) {
      await interaction.reply({ content: "Choose a Guard Review Room before turning monitoring on.", flags: MessageFlags.Ephemeral });
      return true;
    }
    const enabled = !settings?.enabled;
    if (!guardStore.setMonitoringEnabled(interaction.guildId, enabled)) {
      await interaction.reply({ content: "Choose a Guard Review Room before turning monitoring on.", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.update(await guardPage(interaction.guild, `Automatic monitoring is now **${enabled ? "On" : "Off"}**.`));
    return true;
  }
  if (action === "guard-rules") {
    await interaction.update(ruleListPayload(interaction.guildId, Number(parameter) || 0));
    return true;
  }
  if (action === "guard-add") {
    setGuardSession(interaction, newAddRuleSession());
    await interaction.update(guardConditionTypePayload(getGuardSession(interaction)));
    return true;
  }
  if (action === "guard-edit") {
    const rules = guardStore.listRules(interaction.guildId);
    if (!rules.length) {
      await interaction.update(await guardPage(interaction.guild, "There are no active rules to edit yet."));
      return true;
    }
    setGuardSession(interaction, { kind: "edit-picker", ruleSelectPage: 0 });
    await interaction.update(rulePickerPayload(interaction.guildId, "edit", 0));
    return true;
  }
  if (action === "guard-remove") {
    const rules = guardStore.listRules(interaction.guildId);
    if (!rules.length) {
      await interaction.update(await guardPage(interaction.guild, "There are no active rules to remove."));
      return true;
    }
    setGuardSession(interaction, { kind: "remove-picker", ruleSelectPage: 0 });
    await interaction.update(rulePickerPayload(interaction.guildId, "remove", 0));
    return true;
  }
  if (action === "guard-edit-page" || action === "guard-remove-page") {
    const mode = action === "guard-edit-page" ? "edit" : "remove";
    const session = getGuardSession(interaction, `${mode}-picker`);
    if (!session) {
      await interaction.reply({ content: "That Guard rule selection expired. Open the Guard Manager and try again.", flags: MessageFlags.Ephemeral });
      return true;
    }
    session.ruleSelectPage = Math.max(0, Number(parameter) || 0);
    await interaction.update(rulePickerPayload(interaction.guildId, mode, session.ruleSelectPage));
    return true;
  }
  if (action === "guard-edit-select") {
    const picker = getGuardSession(interaction, "edit-picker");
    const rule = guardStore.getRule(interaction.guildId, Number(interaction.values?.[0]));
    if (!picker || !rule) {
      await interaction.reply({ content: "That rule is no longer active. Reopen Edit Rule and try again.", flags: MessageFlags.Ephemeral });
      return true;
    }
    setGuardSession(interaction, editRuleSession(rule));
    await interaction.update(guardRuleDetailsPayload(getGuardSession(interaction)));
    return true;
  }
  if (action === "guard-remove-select") {
    const picker = getGuardSession(interaction, "remove-picker");
    const rule = guardStore.getRule(interaction.guildId, Number(interaction.values?.[0]));
    if (!picker || !rule) {
      await interaction.reply({ content: "That rule is no longer active. Reopen Remove Rule and try again.", flags: MessageFlags.Ephemeral });
      return true;
    }
    setGuardSession(interaction, { kind: "remove", ruleId: rule.id });
    await interaction.update(guardRemoveConfirmPayload(rule));
    return true;
  }
  if (action === "guard-remove-confirm") {
    const session = getGuardSession(interaction, "remove");
    const rule = session && guardStore.getRule(interaction.guildId, Number(session.ruleId));
    if (!rule) {
      clearGuardSession(interaction);
      await interaction.update(await guardPage(interaction.guild, "That rule is no longer active."));
      return true;
    }
    const removed = guardService.removeRule(interaction.guildId, rule.id);
    clearGuardSession(interaction);
    await interaction.update(await guardPage(interaction.guild, removed ? `Rule #${rule.id} was removed.` : "That rule is no longer active."));
    return true;
  }
  if (action === "guard-condition-add" || action === "guard-condition-replace") {
    const session = getGuardSession(interaction);
    if (!session || !["add", "edit"].includes(session.kind)) {
      await interaction.reply({ content: "That Guard rule form expired. Start again from Add Rule or Edit Rule.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (action === "guard-condition-replace" && session.kind === "edit") {
      session.conditions = [];
      session.replaceConditions = true;
    }
    await interaction.update(guardConditionTypePayload(session));
    return true;
  }
  if (action === "guard-condition-type") {
    const session = getGuardSession(interaction);
    const type = interaction.values?.[0];
    if (!session || !["add", "edit"].includes(session.kind) || !guardService.CONDITION_TYPES.has(type) || session.conditions.length >= 5) {
      await interaction.reply({ content: "That condition selection is no longer available. Reopen the Guard Manager and try again.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (["has_attachment", "has_image_attachment"].includes(type)) {
      session.conditions.push({ type });
      if (session.kind === "edit") session.replaceConditions = true;
      await interaction.update(guardConditionsPayload(session));
    } else {
      session.pendingConditionType = type;
      await interaction.showModal(conditionValueModal());
    }
    return true;
  }
  if (action === "guard-condition-value" && interaction.isModalSubmit?.()) {
    const session = getGuardSession(interaction);
    const type = session?.pendingConditionType;
    const value = interaction.fields.getTextInputValue("value");
    if (!session || !type || !value?.trim()) {
      await interaction.reply({ content: "That Guard condition form expired or had no value. Start the rule again.", flags: MessageFlags.Ephemeral });
      return true;
    }
    session.conditions.push({ type, value: value.trim() });
    session.pendingConditionType = null;
    if (session.kind === "edit") session.replaceConditions = true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(guardConditionsPayload(session));
    return true;
  }
  if (action === "guard-condition-done") {
    const session = getGuardSession(interaction);
    if (!session || !["add", "edit"].includes(session.kind) || !session.conditions.length) {
      await interaction.reply({ content: "Add at least one valid condition first.", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.update(guardRuleDetailsPayload(session));
    return true;
  }
  if (["guard-detail-reason", "guard-detail-mode", "guard-detail-action"].includes(action)) {
    const session = getGuardSession(interaction);
    const value = interaction.values?.[0];
    if (!session || !["add", "edit"].includes(session.kind)) {
      await interaction.reply({ content: "That Guard rule form expired. Start again from the Guard Manager.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (action === "guard-detail-reason") session.category = value;
    if (action === "guard-detail-mode") session.matchMode = value;
    if (action === "guard-detail-action") session.action = value;
    await interaction.update(guardRuleDetailsPayload(session));
    return true;
  }
  if (action === "guard-detail-name") {
    const session = getGuardSession(interaction);
    if (!session || !["add", "edit"].includes(session.kind)) {
      await interaction.reply({ content: "That Guard rule form expired. Start again from the Guard Manager.", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.showModal(ruleNameModal(session.name));
    return true;
  }
  if (action === "guard-rule-name" && interaction.isModalSubmit?.()) {
    const session = getGuardSession(interaction);
    if (!session || !["add", "edit"].includes(session.kind)) {
      await interaction.reply({ content: "That Guard rule form expired. Start again from the Guard Manager.", flags: MessageFlags.Ephemeral });
      return true;
    }
    session.name = interaction.fields.getTextInputValue("name").trim() || null;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(guardRuleDetailsPayload(session));
    return true;
  }
  if (action === "guard-detail-save") {
    const session = getGuardSession(interaction);
    if (!session || !["add", "edit"].includes(session.kind)) {
      await interaction.reply({ content: "That Guard rule form expired. Start again from the Guard Manager.", flags: MessageFlags.Ephemeral });
      return true;
    }
    await saveGuardRule(interaction, session);
    return true;
  }
  if (action === "guard-cancel" || action === "guard-condition-cancel") {
    clearGuardSession(interaction);
    await interaction.update(await guardPage(interaction.guild, "Guard Manager action cancelled."));
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
  ruleListPayload,
  rulePickerPayload,
  guardRuleDetailsPayload,
  configureRequestedGuardReviewRoom,
  handleAdminRoomInteraction,
  refreshConfiguredAdminRooms,
  HISTORY_PAGE_SIZE,
};
