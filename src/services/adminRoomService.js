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
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const roomStore = require("../stores/adminRoomStore");
const guardStore = require("../stores/communityGuardStore");
const guardService = require("./communityGuardService");
const {
  withAdminRoomLock, fetchRoomChannel, fetchRoomMessage, ensureRoomMessage, retireRoomMessage,
} = require("./adminRoomMessages");
const welcomePassStore = require("../stores/welcomePassStore");
const welcomePassService = require("./welcomePassService");
const greetingStore = require("../stores/greetingStore");
const memberCountStore = require("../stores/memberCountStore");
const memberCountService = require("./memberCountService");
const collectionStore = require("../stores/collectionStore");
const messageLogStore = require("../stores/messageLogStore");
const errorInboxStore = require("../stores/errorInboxStore");
const errorMonitorStore = require("../stores/errorMonitorStore");
const errorInboxService = require("./errorInboxService");
const errorMonitorService = require("./errorMonitorService");
const forgetShareCommand = require("../commands/forgetShare");
const { isAdminRoomAuthorized } = require("./adminAuthorization");
const statusCommand = require("../commands/status");
const welcomePassBiasRoleService = require("./welcomePassBiasRoleService");
const { BIAS_ROLE_KEYS } = require("./memberBiases");

const HISTORY_PAGE_SIZE = 8;
const GUARD_RULE_PAGE_SIZE = 5;
const GUARD_RULE_PICKER_PAGE_SIZE = 25;
const REQUESTED_GUARD_REVIEW_ROOM_ID = "1554747061252005938";
const guardManagerSessions = new Map();
const GUARD_SESSION_TTL_MS = 15 * 60 * 1000;
const welcomeManagerSessions = new Map();
const welcomeNavigationSessions = new Map();
const greetingsNavigationSessions = new Map();
const GREETINGS_SESSION_TTL_MS = 15 * 60 * 1000;
const memberCountNavigationSessions = new Map();
const MEMBER_COUNT_SESSION_TTL_MS = 15 * 60 * 1000;
const messageLogNavigationSessions = new Map();
const MESSAGE_LOG_SESSION_TTL_MS = 15 * 60 * 1000;
const MESSAGE_LOG_EXCLUSION_PAGE_SIZE = 15;
const mediaNavigationSessions = new Map();
const MEDIA_SESSION_TTL_MS = 15 * 60 * 1000;
const ADMIN_CONTROLS = [
  ["guard", "Harmony Guard", ButtonStyle.Primary],
  ["moderation-history", "Moderation History", ButtonStyle.Secondary],
  ["welcome", "Welcome Pass", ButtonStyle.Secondary],
  ["greetings", "Greetings", ButtonStyle.Secondary],
  ["members", "Member Counts", ButtonStyle.Secondary],
  ["collections", "Collections", ButtonStyle.Secondary],
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
      { name: "COMMUNITY", value: "Guard · Moderation History · Welcome Pass · Greetings · Member Counts", inline: false },
      { name: "OTHER ADMIN TOOLS", value: "Collections · Status / Health · Media & Errors", inline: false },
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

function mediaSessionKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

function setMediaNavigation(interaction) {
  mediaNavigationSessions.set(mediaSessionKey(interaction), {
    panelMessageId: interaction.message?.id,
    channelId: interaction.channelId,
    updatedAt: Date.now(),
  });
}

function hasActiveMediaNavigation(interaction) {
  const key = mediaSessionKey(interaction);
  const session = mediaNavigationSessions.get(key);
  if (!session || Date.now() - session.updatedAt > MEDIA_SESSION_TTL_MS) {
    mediaNavigationSessions.delete(key);
    return false;
  }
  const panel = roomStore.getPanel(interaction.guildId);
  if (!panel?.enabled || panel.message_id !== session.panelMessageId || panel.channel_id !== session.channelId) {
    mediaNavigationSessions.delete(key);
    return false;
  }
  session.updatedAt = Date.now();
  return true;
}

async function mediaManagerPayload(guild, client, notice = null) {
  const inbox = errorInboxStore.getErrorInboxSettings();
  const destinationGuild = inbox?.destination_guild_id
    ? (client.guilds.cache.get(inbox.destination_guild_id) || await client.guilds.fetch(inbox.destination_guild_id).catch(() => null))
    : null;
  const destinationChannel = destinationGuild && inbox?.destination_channel_id
    ? (destinationGuild.channels.cache.get(inbox.destination_channel_id) || await destinationGuild.channels.fetch(inbox.destination_channel_id).catch(() => null))
    : null;
  const destination = inbox
    ? `${destinationGuild?.name || `Server ${inbox.destination_guild_id}`} · ${destinationChannel?.name ? `#${destinationChannel.name}` : `Channel ${inbox.destination_channel_id}`}`
    : "Not configured";
  const monitor = errorMonitorStore.getErrorMonitorSettings();
  const monitorConfigured = errorMonitorService.isErrorMonitorConfigured();
  const inboxStatus = inbox ? (inbox.enabled ? "On" : "Off") : "Not configured";
  const monitorStatus = monitor.enabled ? "On" : "Off";
  const description = [
    notice,
    "**MEDIA ERROR INBOX**",
    `**Status:** ${inboxStatus}`,
    `**Destination:** ${destination}`,
    "**Scope:** Media failures from every server Harmony serves.",
    "Use a private troubleshooting channel that trusted admins can access.",
    "",
    "**AUTOMATIC ERROR MONITOR**",
    `**Status:** ${monitorStatus}`,
    `**Private repository:** ${monitorConfigured ? "Configured" : "Not configured"}`,
    "Sanitized media failures only. Automatic merging/deployment: **Off**.",
    "",
    "**FORGET SHARED POST**",
    "Reset duplicate tracking for one post so that exact post can be shared again. This does not delete a member or media.",
  ].filter(Boolean).join("\n\n");
  const inboxToggle = inbox?.enabled
    ? new ButtonBuilder().setCustomId("harmony-admin-room:media-inbox-toggle").setLabel("Turn Inbox Off").setStyle(ButtonStyle.Danger)
    : new ButtonBuilder().setCustomId("harmony-admin-room:media-inbox-toggle").setLabel("Turn Inbox On").setStyle(ButtonStyle.Success).setDisabled(!inbox);
  const monitorToggle = new ButtonBuilder().setCustomId("harmony-admin-room:media-monitor-toggle")
    .setLabel(monitor.enabled ? "Turn Monitor Off" : "Turn Monitor On")
    .setStyle(monitor.enabled ? ButtonStyle.Danger : ButtonStyle.Success);
  const components = [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
      .setCustomId("harmony-admin-room:media-error-inbox-select")
      .setPlaceholder(inbox ? "Change Error Inbox" : "Choose Error Inbox")
      .setChannelTypes(ChannelType.GuildText)
      .setMinValues(1)
      .setMaxValues(1)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-admin-room:media-inbox-test").setLabel("Send Test").setStyle(ButtonStyle.Primary).setDisabled(!inbox?.enabled),
      inboxToggle,
      monitorToggle,
      new ButtonBuilder().setCustomId("harmony-admin-room:media-forget").setLabel("Forget Shared Post").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-admin-room:media-refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId("harmony-admin-room:media-close").setLabel("Close").setStyle(ButtonStyle.Secondary)),
  ];
  return pagePayload("🎞️ Media & Errors Manager", description, components);
}

function forgetSharedPostModal() {
  const modal = new ModalBuilder()
    .setCustomId("harmony-admin-room:media-forget-submit")
    .setTitle("Forget Shared Post");
  modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
    .setCustomId("link")
    .setLabel("Social Post Link")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Instagram, Facebook, TikTok, X, YouTube, or Threads")
    .setMaxLength(2000)
    .setRequired(true)));
  return modal;
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

function welcomeSessionKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

function getWelcomeDraft(interaction) {
  const key = welcomeSessionKey(interaction);
  const draft = welcomeManagerSessions.get(key);
  if (!draft || Date.now() - draft.updatedAt > GUARD_SESSION_TTL_MS) {
    welcomeManagerSessions.delete(key);
    return null;
  }
  draft.updatedAt = Date.now();
  return draft;
}

function setWelcomeDraft(interaction, draft) {
  draft.updatedAt = Date.now();
  welcomeManagerSessions.set(welcomeSessionKey(interaction), draft);
}

function clearWelcomeDraft(interaction) {
  welcomeManagerSessions.delete(welcomeSessionKey(interaction));
}

function setWelcomeNavigation(interaction) {
  welcomeNavigationSessions.set(welcomeSessionKey(interaction), {
    panelId: interaction.message?.id,
    updatedAt: Date.now(),
  });
}

function hasActiveWelcomeNavigation(interaction) {
  const key = welcomeSessionKey(interaction);
  const session = welcomeNavigationSessions.get(key);
  const panel = roomStore.getPanel(interaction.guildId);
  if (!session || Date.now() - session.updatedAt > GUARD_SESSION_TTL_MS ||
    !panel?.enabled || panel.message_id !== session.panelId) {
    welcomeNavigationSessions.delete(key);
    clearWelcomeDraft(interaction);
    return false;
  }
  session.updatedAt = Date.now();
  return true;
}

function welcomeDraft(interaction) {
  const existing = getWelcomeDraft(interaction);
  if (existing) return existing;
  const settings = welcomePassStore.getWelcomePassSettings(interaction.guildId);
  const draft = {
    roleId: settings?.role_id || null,
    channelId: settings?.channel_id || null,
    releaseChannelId: settings?.release_channel_id || null,
    entryChannelId: settings?.entry_channel_id || greetingStore.getGreetingSettings(interaction.guildId)?.channel_id || null,
    entryMessage: settings?.entry_message || null,
    releaseMessage: settings?.release_message || welcomePassStore.DEFAULT_RELEASE_MESSAGE,
  };
  setWelcomeDraft(interaction, draft);
  return draft;
}

function welcomePassPage(guild, userId, notice = null) {
  const settings = welcomePassStore.getWelcomePassSettings(guild.id);
  const greetingSettings = greetingStore.getGreetingSettings(guild.id);
  const draft = userId ? getWelcomeDraft({ guildId: guild.id, user: { id: userId } }) : null;
  const baseConfigured = Boolean(settings?.role_id && settings?.channel_id && settings?.release_channel_id);
  const entryChannelId = settings?.entry_channel_id || draft?.entryChannelId || greetingSettings?.channel_id;
  // Existing installations keep their configured state and continue using the
  // prior Greetings channel until an explicit Welcome Pass entry channel is set.
  const complete = baseConfigured && (Boolean(entryChannelId) || Boolean(settings));
  const roleId = settings?.role_id || draft?.roleId;
  const privateChannelId = settings?.channel_id || draft?.channelId;
  const memberChannelId = settings?.release_channel_id || draft?.releaseChannelId;
  const entryMessage = settings?.entry_message || draft?.entryMessage || greetingSettings?.entrance_message || greetingStore.DEFAULT_ENTRANCE_MESSAGE;
  const releaseMessage = settings?.release_message || draft?.releaseMessage || welcomePassStore.DEFAULT_RELEASE_MESSAGE;
  const role = roleId ? guild.roles.cache.get(roleId) : null;
  const description = [
    notice,
    `**Status:** ${complete ? "Configured" : "Setup needed"}`,
    `**Approved Role:** ${role?.name ? `@${role.name}` : (roleId ? `<@&${roleId}>` : "Not selected")}`,
    `**Welcome Pass Entry Channel:** ${entryChannelId ? `<#${entryChannelId}>` : "Not selected"}${!settings?.entry_channel_id && greetingSettings?.channel_id ? " (following the current entrance greeting channel)" : ""}`,
    `**New-member entrance greeting:** ${!greetingSettings ? "Not configured" : greetingSettings.enabled ? "On" : "Off"}`,
    `**Pass Submission Alerts:** ${privateChannelId ? `<#${privateChannelId}>` : "Not selected"}`,
    "This room’s primary purpose is to alert staff when a new pass is waiting for review. A separate STAY-role confirmation may also be posted after admission.",
    `**Approved Member Welcome Channel:** ${memberChannelId ? `<#${memberChannelId}>` : "Not selected"}`,
    `**Grant Mode:** ${baseConfigured ? (settings.grant_mode || "automatic") : "Set after setup"}`,
    `**New-Member Entrance Message:**\n${entryMessage.slice(0, 500)}`,
    `**Approved Member Welcome Message:**\n${releaseMessage.slice(0, 500)}`,
    complete
      ? (settings.grant_mode === "manual"
        ? "Manual mode: an admin grants the configured role; Harmony then sends the member message and private confirmation. Approvals and member linking remain available. A separate Disable control is not provided because the current backend has no non-destructive disabled state."
        : "Automatic mode: after approval and an exact Discord account match, Harmony grants the role and sends the configured messages.")
      : "Select the role, Entry Channel, Pass Submission Alerts, and Approved Member Welcome Channel to finish setup. Selections stay in this private setup session until saved; existing configuration is not cleared.",
    !greetingSettings || !greetingSettings.enabled
      ? "The Entry Channel routes the existing entrance greeting. Greetings must be configured and On for Harmony to send that message; this screen does not change Greetings settings."
      : null,
    "The current backend has no separate non-destructive Disable state. Manual mode changes role granting, but does not turn off approvals or member linking.",
  ].filter(Boolean).join("\n\n");
  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-admin-room:welcome-role").setLabel("Approved Role").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("harmony-admin-room:welcome-entry").setLabel("Welcome Pass Entry Channel").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("harmony-admin-room:welcome-private").setLabel("Pass Submission Alerts").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("harmony-admin-room:welcome-member").setLabel("Approved Member Welcome Channel").setStyle(ButtonStyle.Secondary),
  )];
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-admin-room:welcome-entry-message").setLabel("New-Member Entrance Message").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("harmony-admin-room:welcome-approved-message").setLabel("Approved Member Welcome Message").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
    .setCustomId("harmony-admin-room:welcome-mode")
    .setLabel(baseConfigured ? `Switch to ${settings.grant_mode === "manual" ? "Automatic" : "Manual"}` : "Grant Mode")
    .setStyle(ButtonStyle.Primary).setDisabled(!baseConfigured)));
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-admin-room:welcome-bias-roles").setLabel("Member Bias Roles").setStyle(ButtonStyle.Secondary)));
  if (!complete && draft) components.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId("harmony-admin-room:welcome-cancel").setLabel("Cancel Setup").setStyle(ButtonStyle.Secondary)));
  return pagePayload("🎟️ Welcome Pass Manager", description, components);
}

const WELCOME_BIAS_ROLE_PAGE_SIZE = 25;

function isAssignableBiasRole(role) {
  return role.editable === true && !role.managed && !role.tags?.botId && !role.tags?.integrationId;
}

function welcomeBiasRolePage(guildId, selectedBias = null, notice = null, roles = [], requestedPage = 0) {
  const mappings = welcomePassStore.listWelcomePassBiasRoles(guildId);
  const description = [
    notice,
    "Choose a bias, then assign its server role. Harmony manages only the roles mapped here; other member roles are left alone.",
    ...BIAS_ROLE_KEYS.map((bias) => {
      const mapping = mappings.find((row) => row.bias === bias);
      return `**${bias}:** ${mapping ? `<@&${mapping.role_id}>` : "Not mapped"}`;
    }),
    "Existing members are not changed until you run the explicit reconciliation below.",
  ];
  const components = [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("harmony-admin-room:welcome-bias-role-bias")
      .setPlaceholder("Choose a bias role to configure")
      .addOptions(BIAS_ROLE_KEYS.map((bias) => ({ label: bias, value: bias, default: bias === selectedBias }))),
  )];
  if (selectedBias) {
    const biasKey = encodeURIComponent(selectedBias);
    const currentRoleId = mappings.find((row) => row.bias === selectedBias)?.role_id;
    const eligibleRoles = [...roles.values()]
      .filter((role) => role.id !== guildId && isAssignableBiasRole(role))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const pageCount = Math.max(1, Math.ceil(eligibleRoles.length / WELCOME_BIAS_ROLE_PAGE_SIZE));
    const page = Math.min(Math.max(Number.parseInt(requestedPage, 10) || 0, 0), pageCount - 1);
    const start = page * WELCOME_BIAS_ROLE_PAGE_SIZE;
    const current = eligibleRoles.slice(start, start + WELCOME_BIAS_ROLE_PAGE_SIZE);
    if (current.length) {
      description.push(`Role choices · Page ${page + 1} of ${pageCount}`);
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`harmony-admin-room:welcome-bias-role-value:${biasKey}:${page}`)
          .setPlaceholder(`Choose the ${selectedBias} role`).setMinValues(1).setMaxValues(1)
          .addOptions(current.map((role, index) => {
            const position = start + index;
            const duplicateName = eligibleRoles[position - 1]?.name === role.name ||
              eligibleRoles[position + 1]?.name === role.name;
            return {
              label: role.name,
              value: role.id,
              default: role.id === currentRoleId,
              ...(duplicateName ? { description: `Role ID ${role.id}` } : {}),
            };
          })),
      ));
    } else {
      description.push("Harmony found no assignable server roles.");
    }

    const controls = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`harmony-admin-room:welcome-bias-role-clear:${biasKey}`)
        .setLabel(`Clear ${selectedBias} Mapping`).setStyle(ButtonStyle.Danger).setDisabled(!currentRoleId),
    );
    if (pageCount > 1) {
      controls.addComponents(
        new ButtonBuilder().setCustomId(`harmony-admin-room:welcome-bias-role-page:${biasKey}:${page - 1}`)
          .setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`harmony-admin-room:welcome-bias-role-page:${biasKey}:${page + 1}`)
          .setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page === pageCount - 1),
      );
    }
    components.push(controls);
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-admin-room:welcome-bias-reconcile").setLabel("Reconcile Existing Members").setStyle(ButtonStyle.Primary),
  ));
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-admin-room:welcome:ephemeral").setLabel("Back to Welcome Pass").setStyle(ButtonStyle.Secondary),
  ));
  return pagePayload("Welcome Pass · Member Bias Roles", description.filter(Boolean).join("\n"), components);
}

function welcomeBiasReconcileConfirmPage() {
  return pagePayload("Reconcile Existing Bias Roles?", "Harmony will compare each linked member’s saved bias with the configured bias-role mappings and add/remove only those mapped roles. This does not resend Welcome Pass messages or change birthday opt-in.", [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-admin-room:welcome-bias-reconcile-confirm").setLabel("Confirm Role Reconciliation").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("harmony-admin-room:welcome-bias-roles").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    ),
  ]);
}

function welcomePickerPayload(field) {
  const back = new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId("harmony-admin-room:welcome:ephemeral").setLabel("Back to Welcome Pass").setStyle(ButtonStyle.Secondary));
  if (field === "role") {
    return pagePayload("Choose the Approved Role", "Choose the server role Harmony grants after approval.", [
      new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId("harmony-admin-room:welcome-role-select").setPlaceholder("Choose an approved role").setMinValues(1).setMaxValues(1)),
      back,
    ]);
  }
  const labels = {
    entry: ["Choose the Welcome Pass Entry Channel", "Choose where Harmony sends new arrivals to complete the Welcome Pass."],
    private: ["Choose Pass Submission Alerts", "Choose where Harmony notifies staff when a new Welcome Pass is submitted and waiting for review."],
    member: ["Choose the Approved Member Welcome Channel", "Choose where Harmony posts the member’s existing approved Welcome Pass message."],
  };
  return pagePayload(labels[field][0], labels[field][1], [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
      .setCustomId(`harmony-admin-room:welcome-${field}-select`)
      .setPlaceholder(`Choose ${labels[field][0].replace(/^Choose /, "").toLowerCase()}`)
      .setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)),
    back,
  ]);
}

function welcomeMessageModal(kind, value) {
  const entry = kind === "entry";
  const title = entry ? "Edit Entrance Message" : "Edit Approved Welcome Message";
  const input = new TextInputBuilder().setCustomId("message").setLabel(entry ? "New-member entrance message" : "Approved member welcome message")
    .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
    .setPlaceholder("Use {member} to mention the member. Leave blank to restore the current fallback.");
  if (value) input.setValue(value.slice(0, 1000));
  return new ModalBuilder().setCustomId(`harmony-admin-room:welcome-${entry ? "entry" : "approved"}-message-submit`)
    .setTitle(title).addComponents(new ActionRowBuilder().addComponents(input));
}

function welcomeMessagePromptPayload(guild, userId, kind, notice = null) {
  const settings = welcomePassStore.getWelcomePassSettings(guild.id);
  const draft = userId ? getWelcomeDraft({ guildId: guild.id, user: { id: userId } }) : null;
  const greeting = greetingStore.getGreetingSettings(guild.id);
  const entry = kind === "entry";
  const title = entry ? "👋 New-Member Entrance Message" : "💜 Approved Member Welcome Message";
  const channelId = entry
    ? (settings?.entry_channel_id || draft?.entryChannelId || greeting?.channel_id)
    : (settings?.release_channel_id || draft?.releaseChannelId);
  const message = entry
    ? (settings?.entry_message || draft?.entryMessage || greeting?.entrance_message || greetingStore.DEFAULT_ENTRANCE_MESSAGE)
    : (settings?.release_message || draft?.releaseMessage || welcomePassStore.DEFAULT_RELEASE_MESSAGE);
  const action = entry ? "welcome-entry-message-edit" : "welcome-approved-message-edit";
  return pagePayload(title, [notice, channelId ? `**Channel:** <#${channelId}>` : "**Channel:** Select a channel in the manager first.", "**Current message:**", message, "Use `{member}` where Harmony should mention the member."].filter(Boolean).join("\n\n"), [
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`harmony-admin-room:${action}`).setLabel("Edit Message").setStyle(ButtonStyle.Primary)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("harmony-admin-room:welcome:ephemeral").setLabel("Back to Welcome Pass").setStyle(ButtonStyle.Secondary)),
  ]);
}

async function saveWelcomeManagerField(interaction, field, value, promptMessage = false) {
  const settings = welcomePassStore.getWelcomePassSettings(interaction.guildId);
  const isComplete = Boolean(settings?.role_id && settings?.channel_id && settings?.release_channel_id);
  let notice;
  if (isComplete) {
    try {
      await welcomePassService.updateWelcomePassSetting(interaction.client, interaction.guildId, field, value);
    } catch (error) {
    await interaction.update(promptMessage
      ? welcomeMessagePromptPayload(interaction.guild, interaction.user.id, field === "entryChannelId" ? "entry" : "approved", `Setting was not changed: ${error.message || "Please check the selected value."}`)
      : welcomePassPage(interaction.guild, interaction.user.id, `Setting was not changed: ${error.message || "Please check the selected value."}`));
      return;
    }
    clearWelcomeDraft(interaction);
    notice = field === "roleId" ? `Approved role updated to <@&${value}>.`
      : field === "channelId" ? `Pass Submission Alerts updated to <#${value}>.`
        : field === "releaseChannelId" ? `Approved Member Welcome Channel updated to <#${value}>.`
          : field === "entryChannelId" ? `Welcome Pass Entry Channel updated to <#${value}>.`
            : field === "entryMessage" ? "New-member entrance message updated."
              : field === "releaseMessage" ? "Approved Member Welcome Message updated."
          : "Welcome Pass message template updated.";
  } else {
    const draft = welcomeDraft(interaction);
    draft[field] = value;
    setWelcomeDraft(interaction, draft);
    if (draft.roleId && draft.entryChannelId && draft.channelId && draft.releaseChannelId) {
      try {
        await welcomePassService.configureWelcomePass(interaction.client, {
          guildId: interaction.guildId,
          ...draft,
        });
        clearWelcomeDraft(interaction);
        notice = "Welcome Pass setup is complete. Existing approvals were checked using the current workflow.";
      } catch (error) {
        notice = `Setup was not saved: ${error.message || "Please check the selected role and channels."}`;
      }
    } else {
      const missing = [
        !draft.roleId && "Approved Role",
        !draft.entryChannelId && "Welcome Pass Entry Channel",
        !draft.channelId && "Pass Submission Alerts",
        !draft.releaseChannelId && "Approved Member Welcome Channel",
      ].filter(Boolean);
      notice = `Selection held for this setup session only. Still needed: ${missing.join(", ")}. Select the remaining controls to save setup.`;
    }
  }
  if (promptMessage && ["entryChannelId", "releaseChannelId"].includes(field)) {
    await interaction.update(welcomeMessagePromptPayload(interaction.guild, interaction.user.id, field === "entryChannelId" ? "entry" : "approved", notice));
  } else {
    await interaction.update(welcomePassPage(interaction.guild, interaction.user.id, notice));
  }
}

function communityToolPage(guildId, area) {
  if (area === "guard") return null;
  if (area === "welcome") return null;
  if (area === "members") {
    return null;
  }
  if (area === "collections") {
    const settings = collectionStore.getCollectionSettings(guildId);
    return pagePayload("💜 Collections", `Status: **${settings ? "Configured" : "Not configured"}**${settings ? `\nMilestones: **${settings.milestones_enabled ? "On" : "Off"}** · Weekly recap: **${settings.schedule_enabled ? "On" : "Off"}**\nChannel: <#${settings.channel_id}>` : ""}\n\n${commandHelp([["harmony-collection", "configure milestones, recaps, or check settings"]])}`);
  }
  if (area === "logs") {
    return null;
  }
  return null;
}

function messageLogSessionKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

function setMessageLogNavigation(interaction, panelMessageId = interaction.message?.id) {
  messageLogNavigationSessions.set(messageLogSessionKey(interaction), {
    panelMessageId,
    channelId: interaction.channelId,
    updatedAt: Date.now(),
  });
}

function hasActiveMessageLogNavigation(interaction) {
  const key = messageLogSessionKey(interaction);
  const session = messageLogNavigationSessions.get(key);
  if (!session || Date.now() - session.updatedAt > MESSAGE_LOG_SESSION_TTL_MS) {
    messageLogNavigationSessions.delete(key);
    return false;
  }
  const panel = roomStore.getPanel(interaction.guildId);
  if (!panel?.enabled || panel.message_id !== session.panelMessageId || panel.channel_id !== session.channelId) {
    messageLogNavigationSessions.delete(key);
    return false;
  }
  session.updatedAt = Date.now();
  return true;
}

function messageLogManagerPayload(guildId, guild, requestedPage = 0, notice = null) {
  const settings = messageLogStore.getLogSettings(guildId);
  const excluded = messageLogStore.listExcludedChannels(guildId);
  const pageCount = Math.max(1, Math.ceil(excluded.length / MESSAGE_LOG_EXCLUSION_PAGE_SIZE));
  const page = Math.min(Math.max(0, Number(requestedPage) || 0), pageCount - 1);
  const start = page * MESSAGE_LOG_EXCLUSION_PAGE_SIZE;
  const visibleExcluded = excluded.slice(start, start + MESSAGE_LOG_EXCLUSION_PAGE_SIZE);
  const excludedText = excluded.length
    ? `${visibleExcluded.map((id) => `<#${id}>`).join(", ")}${pageCount > 1 ? `\nPage ${page + 1} of ${pageCount} · ${excluded.length} excluded channels` : ""}`
    : "None";
  const description = [
    notice,
    `**Status:** ${settings ? (settings.enabled ? "On" : "Off") : "Not configured"}`,
    `**Log channel:** ${settings?.channel_id ? `<#${settings.channel_id}>` : "Not selected"}`,
    "**Retention:** 3 days",
    `**Excluded channels:** ${excludedText}`,
    "Choose a private log channel that only trusted admins can view.",
  ].filter(Boolean).join("\n\n");
  const components = [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
      .setCustomId("harmony-admin-room:logs-channel-select")
      .setPlaceholder(settings?.channel_id ? "Change the private log channel" : "Choose a private log channel")
      .setChannelTypes(ChannelType.GuildText)
      .setMinValues(1)
      .setMaxValues(1)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
      .setCustomId("harmony-admin-room:logs-exclude-channel-select")
      .setPlaceholder("Exclude a text channel from logging")
      .setChannelTypes(ChannelType.GuildText)
      .setMinValues(1)
      .setMaxValues(1)),
  ];
  if (visibleExcluded.length) {
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`harmony-admin-room:logs-include-channel-select:${page}`)
      .setPlaceholder("Choose an excluded channel to include")
      .addOptions(visibleExcluded.map((id) => {
        const channel = guild?.channels.cache.get(id);
        const label = channel?.name ? `#${channel.name}` : `Channel ${id}`;
        return { label: label.slice(0, 100), value: id, description: "Resume logging in this channel" };
      }))));
  }
  const buttons = [];
  if (pageCount > 1) {
    buttons.push(
      new ButtonBuilder().setCustomId(`harmony-admin-room:logs-exclusion-page:${page - 1}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(`harmony-admin-room:logs-exclusion-page:${page + 1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1),
    );
  }
  buttons.push(
    new ButtonBuilder().setCustomId("harmony-admin-room:logs-toggle").setLabel(!settings ? "Not Configured" : settings.enabled ? "Turn Off" : "Turn On").setStyle(settings?.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setDisabled(!settings),
    new ButtonBuilder().setCustomId("harmony-admin-room:logs-close").setLabel("Close Manager").setStyle(ButtonStyle.Secondary),
  );
  components.push(new ActionRowBuilder().addComponents(...buttons));
  return pagePayload("🧾 Message Logs Manager", description, components);
}

function memberCountSessionKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

function setMemberCountNavigation(interaction) {
  memberCountNavigationSessions.set(memberCountSessionKey(interaction), {
    panelMessageId: interaction.message?.id,
    channelId: interaction.channelId,
    updatedAt: Date.now(),
  });
}

function hasActiveMemberCountNavigation(interaction) {
  const key = memberCountSessionKey(interaction);
  const session = memberCountNavigationSessions.get(key);
  if (!session || Date.now() - session.updatedAt > MEMBER_COUNT_SESSION_TTL_MS) {
    memberCountNavigationSessions.delete(key);
    return false;
  }
  const panel = roomStore.getPanel(interaction.guildId);
  if (!panel?.enabled || panel.message_id !== session.panelMessageId || panel.channel_id !== session.channelId) {
    memberCountNavigationSessions.delete(key);
    return false;
  }
  session.updatedAt = Date.now();
  return true;
}

function memberCountManagerPayload(guild, notice = null) {
  const settings = memberCountStore.getMemberCountSettings(guild.id);
  const { stayRoleId, adminRoleId, moderatorRoleId } = memberCountService.getMemberCountRoles(guild);
  const role = (id) => id ? `<@&${id}>` : "Not configured";
  const channel = (id) => id ? `<#${id}>` : "Not configured";
  const enabled = Boolean(settings?.enabled);
  const description = [
    notice,
    `**STAY Role:** ${stayRoleId ? `${role(stayRoleId)} (Welcome Pass Approved Role)` : "Set the Approved Role in Welcome Pass"}`,
    `**Admin Role:** ${role(adminRoleId)}`,
    `**Moderator Role:** ${role(moderatorRoleId)}`,
    "",
    `**Public SERVER STATS:** ${settings ? (enabled ? "On" : "Off") : "Not configured"}`,
    ...(settings ? [
      `Category: ${channel(settings.category_id)}`,
      `Total Members: ${channel(settings.total_channel_id)}`,
      `STAY Role: ${channel(settings.stay_channel_id)}`,
      `No STAY Role: ${channel(settings.no_role_channel_id)}`,
    ] : []),
  ].filter((line) => line != null).join("\n");
  return pagePayload("📊 Member Counts Manager", description, [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-admin-room:members-pick-admin").setLabel("Set Admin Role").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-admin-room:members-pick-moderator").setLabel("Set Moderator Role").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      settings
        ? new ButtonBuilder().setCustomId("harmony-admin-room:members-toggle").setLabel(enabled ? "Turn Public Stats Off" : "Turn Public Stats On").setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success)
        : new ButtonBuilder().setCustomId("harmony-admin-room:members-public-setup").setLabel("Set Up Public Stats").setStyle(ButtonStyle.Secondary).setDisabled(!stayRoleId),
      new ButtonBuilder().setCustomId("harmony-admin-room:members-refresh").setLabel("Refresh Now").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("harmony-admin-room:members-close").setLabel("Close Manager").setStyle(ButtonStyle.Secondary),
    ),
  ]);
}

const MEMBER_COUNT_ROLE_PAGE_SIZE = 25;

async function fetchMemberCountStaffChoices(guild, kind) {
  const roles = await guild.roles.fetch();
  const accounting = memberCountStore.getMemberCountAccounting(guild.id);
  const otherRoleId = kind === "admin" ? accounting.moderator_role_id : accounting.admin_role_id;
  const excluded = new Set([
    guild.id,
    welcomePassStore.getWelcomePassSettings(guild.id)?.role_id,
    otherRoleId,
    ...welcomePassStore.listWelcomePassBiasRoles(guild.id).map(({ role_id }) => role_id),
  ]);
  // This is a read-only role reference. Higher roles are valid choices.
  return [...roles.values()].filter((role) =>
    !excluded.has(role.id) && !role.managed && !role.tags?.botId && !role.tags?.integrationId
  );
}

function memberCountStaffPicker(kind, roles, requestedPage) {
  const label = kind === "admin" ? "Admin" : "Moderator";
  const sorted = [...roles].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const pageCount = Math.max(1, Math.ceil(sorted.length / MEMBER_COUNT_ROLE_PAGE_SIZE));
  const page = Math.min(Math.max(Number.parseInt(requestedPage, 10) || 0, 0), pageCount - 1);
  const start = page * MEMBER_COUNT_ROLE_PAGE_SIZE;
  const current = sorted.slice(start, start + MEMBER_COUNT_ROLE_PAGE_SIZE);
  const components = [];
  if (current.length) {
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`harmony-admin-room:members-save-${kind}`)
      .setPlaceholder(`Choose the ${label} role`).setMinValues(1).setMaxValues(1)
      .addOptions(current.map((role, index) => {
        const position = start + index;
        const duplicate = sorted[position - 1]?.name === role.name || sorted[position + 1]?.name === role.name;
        return { label: role.name, value: role.id, ...(duplicate ? { description: `Role ID ${role.id}` } : {}) };
      }))));
  }
  const navigation = new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId("harmony-admin-room:members-back").setLabel("Back to Member Counts").setStyle(ButtonStyle.Secondary));
  if (pageCount > 1) {
    navigation.addComponents(
      new ButtonBuilder().setCustomId(`harmony-admin-room:members-pick-${kind}:${page - 1}`)
        .setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`harmony-admin-room:members-pick-${kind}:${page + 1}`)
        .setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page === pageCount - 1),
    );
  }
  components.push(navigation);
  const description = roles.length
    ? `Choose the one role Harmony should count as ${label}.\nPage ${page + 1} of ${pageCount}`
    : `There are no eligible server roles to count as ${label}.`;
  return pagePayload(`Set ${label} Role`, description, components);
}

function greetingsSessionKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

function setGreetingsNavigation(interaction) {
  greetingsNavigationSessions.set(greetingsSessionKey(interaction), {
    panelMessageId: interaction.message?.id,
    channelId: interaction.channelId,
    updatedAt: Date.now(),
  });
}

function hasActiveGreetingsNavigation(interaction) {
  const key = greetingsSessionKey(interaction);
  const session = greetingsNavigationSessions.get(key);
  if (!session || Date.now() - session.updatedAt > GREETINGS_SESSION_TTL_MS) {
    greetingsNavigationSessions.delete(key);
    return false;
  }
  const panel = roomStore.getPanel(interaction.guildId);
  if (!panel?.enabled || panel.message_id !== session.panelMessageId || panel.channel_id !== session.channelId) {
    greetingsNavigationSessions.delete(key);
    return false;
  }
  session.updatedAt = Date.now();
  return true;
}

function isGreetingTestAuthorized(interaction) {
  const isOwner = interaction.guild?.ownerId === interaction.user?.id;
  return Boolean(isOwner || interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator));
}

function greetingsManagerPayload(interaction, guildId, notice = null) {
  const settings = greetingStore.getGreetingSettings(guildId);
  const configured = Boolean(settings);
  const enabled = Boolean(settings?.enabled);
  const testAuthorized = Boolean(interaction && isGreetingTestAuthorized(interaction));
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("👋 Greetings Manager")
    .setDescription([
      notice,
      `**Current Status:** ${configured ? (enabled ? "On" : "Off") : "Not configured"}`,
      `**Greeting Channel:** ${settings?.channel_id ? `<#${settings.channel_id}>` : "Not selected"}`,
      `**Current Entrance Message:**\n${settings?.entrance_message || "Not configured"}`,
      `**Current Exit Message:**\n${settings?.exit_message || "Not configured"}`,
    ].filter(Boolean).join("\n\n").slice(0, 4000));
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("harmony-admin-room:greetings-entrance-edit").setLabel("Entrance Message").setStyle(ButtonStyle.Secondary).setDisabled(!configured),
    new ButtonBuilder().setCustomId("harmony-admin-room:greetings-exit-edit").setLabel("Exit Message").setStyle(ButtonStyle.Secondary).setDisabled(!configured),
    new ButtonBuilder().setCustomId("harmony-admin-room:greetings-preview").setLabel("Preview").setStyle(ButtonStyle.Secondary).setDisabled(!configured || !enabled),
    ...(testAuthorized ? [new ButtonBuilder().setCustomId("harmony-admin-room:greetings-test").setLabel("Send Test").setStyle(ButtonStyle.Primary).setDisabled(!configured || !enabled)] : []),
    new ButtonBuilder()
      .setCustomId("harmony-admin-room:greetings-toggle")
      .setLabel(!configured ? "Not Configured" : (enabled ? "Turn Greetings Off" : "Turn Greetings On"))
      .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success)
      .setDisabled(!configured),
  );
  const rows = [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
      .setCustomId("harmony-admin-room:greetings-channel-select")
      .setPlaceholder(settings?.channel_id ? "Change the greeting channel" : "Choose a greeting channel")
      .setChannelTypes(ChannelType.GuildText)
      .setMinValues(1)
      .setMaxValues(1)),
    buttonRow,
    new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId("harmony-admin-room:greetings-close")
      .setLabel("Close Manager")
      .setStyle(ButtonStyle.Secondary)),
  ];
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

function greetingMessageModal(kind, currentValue) {
  const entrance = kind === "entrance";
  const modal = new ModalBuilder()
    .setCustomId(`harmony-admin-room:greetings-${kind}-submit`)
    .setTitle(entrance ? "Edit Entrance Message" : "Edit Exit Message");
  const input = new TextInputBuilder()
    .setCustomId("message")
    .setLabel(entrance ? "Entrance message" : "Exit message")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(entrance ? "Placeholders: {member}, {name}, {server}" : "Placeholders: {name}, {server}")
    .setMaxLength(1000)
    .setRequired(true)
    .setValue(String(currentValue || "").slice(0, 1000));
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function greetingPreview(interaction, settings) {
  const memberName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
  const values = { memberMention: `<@${interaction.user.id}>`, memberName, serverName: interaction.guild.name };
  return {
    content: [
      "💜 **Harmony Greetings Preview**",
      "",
      "**Entrance**",
      greetingStore.renderGreetingMessage(settings.entrance_message, values),
      "",
      "**Exit**",
      greetingStore.renderGreetingMessage(settings.exit_message, values),
      "",
      `Channel: <#${settings.channel_id}>`,
    ].join("\n"),
    allowedMentions: { parse: [] },
  };
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

const MODERATION_HISTORY = [
  ["guard", "Guard Logs", (interaction, panelId) => guardHistoryPayload(interaction.guildId, 0, panelId)],
  ["messages", "Message Logs", (interaction, panelId) => {
    setMessageLogNavigation(interaction, panelId);
    return messageLogManagerPayload(interaction.guildId, interaction.guild);
  }],
];

function moderationHistoryPayload(panelId) {
  const buttons = MODERATION_HISTORY.map(([action, label]) => new ButtonBuilder()
    .setCustomId(`harmony-admin-room:moderation-history:${action}:${panelId}`)
    .setLabel(label).setStyle(ButtonStyle.Secondary));
  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder().addComponents(...buttons.slice(index, index + 5)));
  }
  return pagePayload("Moderation History", "Choose the history to open.", rows);
}

function isActiveRoomPanel(interaction, messageId) {
  const active = roomStore.getPanel(interaction.guildId);
  return active?.enabled && active.message_id === messageId && active.channel_id === interaction.channelId;
}

function guardHistoryPayload(guildId, page = 0, panelId) {
  const pageId = (number) => `harmony-admin-room:guard-history:${number}${panelId ? ":" + panelId : ""}`;
  const total = guardStore.countHistory(guildId);
  const lastPage = Math.max(0, Math.ceil(total / HISTORY_PAGE_SIZE) - 1);
  const currentPage = Math.min(Math.max(0, Number(page) || 0), lastPage);
  const rows = guardStore.listHistory(guildId, { limit: HISTORY_PAGE_SIZE, offset: currentPage * HISTORY_PAGE_SIZE });
  const body = rows.length
    ? rows.map(historyEntry).join("\n\n")
    : "No saved Guard actions or Admin Review safe decisions were found.";
  const pager = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(pageId(currentPage - 1)).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 0),
    new ButtonBuilder().setCustomId(pageId(currentPage + 1)).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= lastPage),
    new ButtonBuilder().setCustomId(panelId ? `harmony-admin-room:moderation-history:menu:${panelId}` : "harmony-admin-room:guard:ephemeral")
      .setLabel(panelId ? "Back to Moderation History" : "Back to Guard").setStyle(ButtonStyle.Secondary),
  );
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("🛡️ Guard Moderation History")
    .setDescription(body.slice(0, 4000)).setFooter({ text: `Page ${currentPage + 1} of ${lastPage + 1} · ${total} saved decisions/actions · Message content is not shown.` });
  return { embeds: [embed], components: [pager], allowedMentions: { parse: [] } };
}

async function validateRoomChannel(guild, channel) {
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) throw new Error("Choose a server text or announcement channel.");
  const permissions = channel.permissionsFor(guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages) || !permissions?.has(PermissionFlagsBits.EmbedLinks)) {
    throw new Error(`Harmony needs View Channel, Send Messages, and Embed Links in <#${channel.id}>.`);
  }
  return channel;
}

async function deactivateOldPanel(guild, panel, exceptMessageId = null) {
  if (!panel || panel.message_id === "0" || panel.message_id === exceptMessageId) return;
  const channel = await fetchRoomChannel(guild, panel.channel_id);
  const message = channel?.isTextBased?.() && await fetchRoomMessage(channel, panel.message_id);
  if (message) await message.edit({ content: "Harmony Admin Room panel moved or turned off. Use `/harmony-admin-room` to manage the active panel.", embeds: [], components: [] });
}

async function syncLiveCounter(guild, channel, snapshot) {
  const visibleToEveryone = channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel);
  if (visibleToEveryone !== false) {
    await retireRoomMessage(guild, "counter");
    return null;
  }
  await validateRoomChannel(guild, channel);
  const counts = snapshot || await memberCountService.getMemberCounts(guild);
  const roles = counts.privateCounts;
  const week = memberCountStore.getWeeklyMemberCountActivity(guild.id);
  const payload = pagePayload("👥 YOUTIFUL STAY — LIVE MEMBER COUNT", [
    `**Total Members:** ${roles.total}`,
    `**STAY:** ${roles.stay ?? "—"}`,
    `**Bots:** ${roles.bots}`,
    `**Admins:** ${roles.admins ?? "—"}`,
    `**Moderators:** ${roles.moderators ?? "—"}`,
    `**No Role:** ${roles.noRole ?? "—"}`,
    ...(roles.noRole === null
      ? ["", "Configure distinct STAY, Admin, and Moderator roles to show staff and No Role counts."]
      : ["", "STAY includes everyone holding the role, including staff and bots."]),
    "",
    "**This week**",
    `**Joined:** ${week.joined}`,
    `**Left:** ${week.left}`,
    `**Net change:** ${week.net > 0 ? "+" : ""}${week.net}`,
  ].join("\n"));
  const counter = await ensureRoomMessage(guild, channel, "counter", payload);
  if (counter.embeds[0]?.description !== payload.embeds[0].data.description) {
    if (counter.embeds[0]?.footer) payload.embeds[0].setFooter({ text: counter.embeds[0].footer.text });
    await counter.edit(payload);
  }
  return counter;
}

async function syncAdminRoom(guild, panel, { snapshot, refreshPanel = true, channel } = {}) {
  channel ||= await fetchRoomChannel(guild, panel.channel_id);
  if (!channel?.isTextBased?.()) throw new Error("The saved Admin Room channel is unavailable. Use `/harmony-admin-room move` to choose a new channel.");

  let counter;
  let counterFailed = false;
  try {
    counter = await syncLiveCounter(guild, channel, snapshot);
  } catch (error) {
    if (!refreshPanel) throw error;
    counterFailed = true;
    console.warn("Harmony Admin Room live member count is unavailable:", error.message);
  }
  if (!refreshPanel && !counter) throw new Error("The Admin Room must be private to display member counts.");

  if (!refreshPanel && BigInt(panel.message_id) > BigInt(counter.id)) return counterFailed;

  // Messages are chronological. When the counter is new or has been deleted,
  // place the controls below it and retire the previous controls.
  const current = panel.message_id === "0" ? null : await fetchRoomMessage(channel, panel.message_id);
  const followsCounter = (message) => !counter || BigInt(message.id) > BigInt(counter.id);
  if (current && followsCounter(current)) {
    if (refreshPanel) await current.edit(await buildHomePayload());
    return counterFailed;
  }
  const replacement = await ensureRoomMessage(guild, channel, "panel", await buildHomePayload(), followsCounter);
  if (current) await deactivateOldPanel(guild, panel, replacement.id);
  roomStore.savePanel({ guildId: guild.id, channelId: channel.id, messageId: replacement.id });
  return counterFailed;
}

function refreshMemberCountDisplay(guild, snapshot) {
  return withAdminRoomLock(guild.id, async () => {
    const panel = roomStore.getPanel(guild.id);
    if (!panel?.enabled) throw new Error("The Admin Room is disabled.");
    await syncAdminRoom(guild, panel, { snapshot, refreshPanel: false });
    return true;
  });
}

function handleMemberCountDisplayDeletion(message) {
  if (!message.guild) return;
  const delivery = roomStore.getDelivery(message.guild.id, "counter");
  if (delivery?.channel_id === message.channelId && delivery.message_id === message.id) {
    memberCountService.scheduleMemberCountRefresh(message.guild, 0);
  }
}

async function setupAdminRoom(interaction) {
  if (!isAdminRoomAuthorized(interaction)) return interaction.reply({ content: "Only server admins can manage the Harmony Admin Room.", flags: MessageFlags.Ephemeral });
  if (!interaction.guild) return interaction.reply({ content: "Use this command inside a server.", flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { guild } = interaction;
  const action = interaction.options.getSubcommand();
  return withAdminRoomLock(guild.id, async () => {
    const existing = roomStore.getPanel(guild.id);
    try {
      if (action === "off") {
        if (!existing?.enabled) return interaction.editReply("The Harmony Admin Room is already off.");
        await retireRoomMessage(guild, "counter");
        await deactivateOldPanel(guild, existing);
        const delivery = roomStore.getDelivery(guild.id, "panel");
        if (delivery?.message_id === existing.message_id) roomStore.clearDelivery(delivery);
        else await retireRoomMessage(guild, "panel");
        roomStore.setEnabled(guild.id, false);
        return interaction.editReply("Harmony Admin Room is off. Its panel is inactive; Harmony’s commands and services are unchanged.");
      }

      if (action === "refresh") {
        if (!existing?.enabled) return interaction.editReply("No active Admin Room is installed. Use `/harmony-admin-room install` first.");
        const failed = await syncAdminRoom(guild, existing);
        return interaction.editReply(failed
          ? "Harmony Admin Room panel refreshed. The live member count is unavailable. Check the bot’s channel permissions and try again."
          : "Harmony Admin Room panel refreshed.");
      }

      const channel = await validateRoomChannel(guild, interaction.options.getChannel("channel", true));
      if (action === "install" && existing?.enabled) return interaction.editReply("An Admin Room is already active. Use `move` or `refresh` to manage it.");
      if (action === "move" && !existing?.enabled) return interaction.editReply("No active Admin Room exists. Use `install` to choose its first channel.");
      if (existing?.enabled && existing.channel_id === channel.id) {
        await syncAdminRoom(guild, existing, { channel });
        return interaction.editReply(`Harmony Admin Room refreshed in <#${channel.id}>.`);
      }

      await retireRoomMessage(guild, "counter");
      if (existing?.enabled) await deactivateOldPanel(guild, existing);
      const delivery = roomStore.getDelivery(guild.id, "panel");
      if (delivery && delivery.message_id === existing?.message_id) roomStore.clearDelivery(delivery);
      else await retireRoomMessage(guild, "panel");

      // Save the desired room before either Discord send so startup can finish an interrupted install.
      const pendingPanel = roomStore.savePanel({ guildId: guild.id, channelId: channel.id, messageId: "0" });
      const failed = await syncAdminRoom(guild, pendingPanel, { channel });
      const notice = failed ? " The live member count is unavailable. Check the bot’s channel permissions and refresh the room." : "";
      return interaction.editReply(`Harmony Admin Room ${action === "move" ? "moved" : "installed"} in <#${channel.id}>.${notice}`);
    } catch (error) {
      return interaction.editReply(error.message || "Harmony could not update the Admin Room.");
    }
  });
}

async function refreshConfiguredAdminRooms(client) {
  for (const { guild_id: guildId } of roomStore.getEnabledPanels()) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    try {
      await withAdminRoomLock(guildId, async () => {
        const panel = roomStore.getPanel(guildId);
        if (panel?.enabled) await syncAdminRoom(guild, panel);
      });
    } catch (error) {
      console.warn("Admin Room startup refresh failed", { guildId, error: error.message });
    }
  }
}

async function configureRequestedGuardReviewRoom(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const channel = guild.channels.cache.get(REQUESTED_GUARD_REVIEW_ROOM_ID) ||
        await guild.channels.fetch(REQUESTED_GUARD_REVIEW_ROOM_ID).catch(() => null);
      if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText || !guild.members?.me) continue;
      // This owner-confirmed channel identifies the Youtiful Stays guild without relying on its name.
      try {
        memberCountStore.seedYoutifulStaysMemberCountWeeks(guild.id);
      } catch (error) {
        console.warn("Harmony could not seed Youtiful Stays' weekly member counts:", error.message);
      }
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
  const [, action, parameter, panelId] = interaction.customId.split(":");
  const panelActions = new Set(["guard", "guard-history-open", "welcome", "greetings", "members", "collections", "logs", "status", "media"]);
  if (panelActions.has(action) && !(["guard", "welcome"].includes(action) && parameter === "ephemeral")) {
    if (!isActiveRoomPanel(interaction, interaction.message?.id)) {
      await interaction.reply({ content: "This Admin Room panel is no longer active. Use the current panel or ask an admin to install it.", flags: MessageFlags.Ephemeral });
      return true;
    }
  }
  if (action === "moderation-history" || (action === "guard-history" && panelId)) {
    const activeId = panelId || interaction.message?.id;
    if (!isActiveRoomPanel(interaction, activeId)) {
      await interaction.reply({ content: "This Moderation History screen is no longer active. Open it from the current Admin Room panel.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!parameter) {
      await interaction.reply({ ...moderationHistoryPayload(activeId), flags: MessageFlags.Ephemeral });
    } else if (action === "guard-history") {
      await interaction.update(guardHistoryPayload(interaction.guildId, Number(parameter) || 0, activeId));
    } else if (parameter === "menu") {
      await interaction.update(moderationHistoryPayload(activeId));
    } else {
      const route = MODERATION_HISTORY.find(([key]) => key === parameter);
      if (!route) return false;
      await interaction.update(route[2](interaction, activeId));
    }
    return true;
  }
  if (action === "panel-refresh") {
    const saved = roomStore.getPanel(interaction.guildId);
    if (!saved?.enabled || saved.message_id !== interaction.message?.id) {
      await interaction.reply({ content: "This is not the active Admin Room panel.", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.deferUpdate();
    await withAdminRoomLock(interaction.guildId, async () => {
      const current = roomStore.getPanel(interaction.guildId);
      if (current?.enabled) await syncAdminRoom(interaction.guild, current);
    });
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
  if (action === "welcome") {
    if (parameter === "ephemeral") {
      if (!hasActiveWelcomeNavigation(interaction)) {
        await interaction.reply({ content: "This Welcome Pass screen came from an Admin Controls panel that is no longer active. Open Welcome Pass from the current panel.", flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.update(welcomePassPage(interaction.guild, interaction.user.id));
      return true;
    }
    setWelcomeNavigation(interaction);
    welcomeDraft(interaction);
    await interaction.reply({ ...welcomePassPage(interaction.guild, interaction.user.id), flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "members") {
    setMemberCountNavigation(interaction);
    await interaction.reply({ ...memberCountManagerPayload(interaction.guild), flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action.startsWith("members-")) {
    if (!hasActiveMemberCountNavigation(interaction)) {
      await interaction.reply({ content: "This Member Counts screen came from an Admin Controls panel that is no longer active. Open Member Counts from the current panel.", flags: MessageFlags.Ephemeral });
      return true;
    }
    const { guild } = interaction;
    if (action === "members-back") {
      await interaction.update(memberCountManagerPayload(guild));
      return true;
    }
    const staffAction = /^members-(pick|save)-(admin|moderator)$/.exec(action);
    if (staffAction) {
      const [, mode, kind] = staffAction;
      await interaction.deferUpdate();
      try {
        const roles = await fetchMemberCountStaffChoices(guild, kind);
        if (!hasActiveMemberCountNavigation(interaction)) {
          await interaction.editReply(pagePayload("Member Counts", "Open Member Counts from the current Admin Controls panel."));
          return true;
        }
        if (mode === "pick") {
          await interaction.editReply(memberCountStaffPicker(kind, roles, parameter));
          return true;
        }
        const [roleId] = interaction.values || [];
        if (interaction.values?.length !== 1 || !roles.some((role) => role.id === roleId)) {
          await interaction.editReply(memberCountManagerPayload(guild, "That role is no longer an eligible choice. Open the staff role picker again."));
          return true;
        }
        memberCountStore.saveMemberCountStaffRole(guild.id, kind, roleId);
        memberCountService.scheduleMemberCountRefresh(guild, 0);
        await interaction.editReply(memberCountManagerPayload(guild));
      } catch (error) {
        console.error("Harmony Admin Room staff role setup failed:", error);
        await interaction.editReply(memberCountManagerPayload(guild, "Harmony couldn’t load or save the staff roles. Try again."));
      }
      return true;
    }
    if (action === "members-public-setup") {
      if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({ content: "Harmony needs **Manage Channels** to set up the public counters.", flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.deferUpdate();
      try {
        await memberCountService.setupMemberCounts(guild);
        await interaction.editReply(memberCountManagerPayload(guild, "The public SERVER STATS counters are ready."));
      } catch (error) {
        console.error("Harmony Admin Room member-count setup failed:", error);
        const notice = error.code === "AMBIGUOUS_SERVER_STATS" ? error.message :
          "Harmony couldn’t set up the public counters. Check the Welcome Pass Approved Role and Harmony’s channel permissions.";
        await interaction.editReply(memberCountManagerPayload(guild, notice));
      }
      return true;
    }
    if (action === "members-refresh") {
      const { stayRoleId, adminRoleId, moderatorRoleId } = memberCountService.getMemberCountRoles(guild);
      if (!stayRoleId) {
        await interaction.update(memberCountManagerPayload(guild, "Set the Approved Role in Welcome Pass to complete Member Counts setup."));
        return true;
      }
      if (!adminRoleId || !moderatorRoleId || new Set([stayRoleId, adminRoleId, moderatorRoleId]).size !== 3) {
        await interaction.update(memberCountManagerPayload(guild, "Complete Member Counts setup by selecting distinct Admin and Moderator roles."));
        return true;
      }
      await interaction.deferUpdate();
      try {
        const result = await memberCountService.refreshMemberCounts(guild);
        const notice = result.queued ? memberCountService.REFRESH_QUEUED_MESSAGE : [
          result.privateRefreshed
            ? "Private member counts refreshed."
            : `Private refresh failed: ${result.privateError?.message || "The Admin Room is unavailable."}`,
          result.publicError && `Public SERVER STATS refresh failed: ${result.publicError.message}`,
        ].filter(Boolean).join("\n");
        await interaction.editReply(memberCountManagerPayload(guild, notice));
      } catch (error) {
        console.error("Harmony Admin Room member-count refresh failed:", error);
        await interaction.editReply(memberCountManagerPayload(guild, `Private refresh failed: ${error.message}`));
      }
      return true;
    }
    if (action === "members-toggle") {
      const settings = memberCountStore.getMemberCountSettings(guild.id);
      if (!settings) {
        await interaction.update(memberCountManagerPayload(guild, "Set up the public SERVER STATS counters first."));
        return true;
      }
      const nextEnabled = !settings.enabled;
      memberCountStore.setMemberCountEnabled(guild.id, nextEnabled);
      if (nextEnabled) memberCountService.scheduleMemberCountRefresh(guild, 0);
      await interaction.update(memberCountManagerPayload(guild));
      return true;
    }
    if (action === "members-close") {
      memberCountNavigationSessions.delete(memberCountSessionKey(interaction));
      await interaction.update({ content: "Member Counts Manager closed.", embeds: [], components: [] });
      return true;
    }
  }
  if (action === "logs") {
    setMessageLogNavigation(interaction);
    await interaction.reply({ ...messageLogManagerPayload(interaction.guildId, interaction.guild), flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action.startsWith("logs-")) {
    if (!hasActiveMessageLogNavigation(interaction)) {
      await interaction.reply({ content: "This Message Logs screen came from an Admin Controls panel that is no longer active. Open Message Logs from the current panel.", flags: MessageFlags.Ephemeral });
      return true;
    }
    const page = Number(parameter) || 0;
    if (action === "logs-exclusion-page") {
      await interaction.update(messageLogManagerPayload(interaction.guildId, interaction.guild, page));
      return true;
    }
    if (action === "logs-channel-select" || action === "logs-exclude-channel-select") {
      const channelId = interaction.values?.[0];
      const channel = channelId && (interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null));
      if (!channel || channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildText) {
        await interaction.reply({ content: "Choose a text channel in this server.", flags: MessageFlags.Ephemeral });
        return true;
      }
      if (action === "logs-channel-select") {
        messageLogStore.saveLogSettings(interaction.guildId, channel.id);
        await interaction.update(messageLogManagerPayload(interaction.guildId, interaction.guild, page, `Message logging is on in <#${channel.id}>.`));
        return true;
      }
      const settings = messageLogStore.getLogSettings(interaction.guildId);
      if (channel.id === settings?.channel_id) {
        await interaction.reply({ content: "The configured log channel is already excluded from logging automatically; it does not need a separate exclusion.", flags: MessageFlags.Ephemeral });
        return true;
      }
      messageLogStore.addExcludedChannel(interaction.guildId, channel.id);
      await interaction.update(messageLogManagerPayload(interaction.guildId, interaction.guild, page, `<#${channel.id}> was added to Excluded Channels.`));
      return true;
    }
    if (action === "logs-include-channel-select") {
      const channelId = interaction.values?.[0];
      if (!channelId || !messageLogStore.listExcludedChannels(interaction.guildId).includes(channelId)) {
        await interaction.reply({ content: "That channel is no longer excluded. Refresh the manager and choose an excluded channel.", flags: MessageFlags.Ephemeral });
        return true;
      }
      messageLogStore.removeExcludedChannel(interaction.guildId, channelId);
      const remaining = messageLogStore.listExcludedChannels(interaction.guildId);
      const lastPage = Math.max(0, Math.ceil(remaining.length / MESSAGE_LOG_EXCLUSION_PAGE_SIZE) - 1);
      await interaction.update(messageLogManagerPayload(interaction.guildId, interaction.guild, Math.min(page, lastPage), `<#${channelId}> will be logged again.`));
      return true;
    }
    if (action === "logs-toggle") {
      const settings = messageLogStore.getLogSettings(interaction.guildId);
      if (!settings) {
        await interaction.update(messageLogManagerPayload(interaction.guildId, interaction.guild, page, "Choose a log channel before turning logging on."));
        return true;
      }
      const nextEnabled = !settings.enabled;
      if (nextEnabled) messageLogStore.enableLogSettings(interaction.guildId);
      else messageLogStore.disableLogSettings(interaction.guildId);
      await interaction.update(messageLogManagerPayload(interaction.guildId, interaction.guild, page, `Message logging is now **${nextEnabled ? "On" : "Off"}**. Saved exclusions were preserved; existing log entries will still expire after 3 days.`));
      return true;
    }
    if (action === "logs-close") {
      messageLogNavigationSessions.delete(messageLogSessionKey(interaction));
      await interaction.update({ content: "Message Logs Manager closed.", embeds: [], components: [] });
      return true;
    }
  }
  if (action === "greetings") {
    setGreetingsNavigation(interaction);
    await interaction.reply({ ...greetingsManagerPayload(interaction, interaction.guildId), flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action.startsWith("greetings-")) {
    if (!hasActiveGreetingsNavigation(interaction)) {
      await interaction.reply({ content: "This Greetings screen came from an Admin Controls panel that is no longer active. Open Greetings from the current panel.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (action === "greetings-channel-select") {
      const channelId = interaction.values?.[0];
      const channel = channelId && (interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null));
      if (!channel || channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildText) {
        await interaction.reply({ content: "Choose a text channel in this server for Greetings.", flags: MessageFlags.Ephemeral });
        return true;
      }
      const existing = greetingStore.getGreetingSettings(interaction.guildId);
      if (existing) {
        greetingStore.updateGreetingSetting(interaction.guildId, "channelId", channel.id);
      } else {
        greetingStore.saveGreetingSettings({
          guildId: interaction.guildId,
          channelId: channel.id,
          entranceMessage: greetingStore.DEFAULT_ENTRANCE_MESSAGE,
          exitMessage: greetingStore.DEFAULT_EXIT_MESSAGE,
        });
      }
      await interaction.update(greetingsManagerPayload(interaction, interaction.guildId, `Greeting Channel set to <#${channel.id}>.`));
      return true;
    }
    if (["greetings-entrance-edit", "greetings-exit-edit"].includes(action)) {
      const settings = greetingStore.getGreetingSettings(interaction.guildId);
      if (!settings) {
        await interaction.update(greetingsManagerPayload(interaction, interaction.guildId, "Choose a Greeting Channel before editing saved messages."));
        return true;
      }
      const entrance = action === "greetings-entrance-edit";
      await interaction.showModal(greetingMessageModal(
        entrance ? "entrance" : "exit",
        entrance ? settings.entrance_message : settings.exit_message
      ));
      return true;
    }
    if (action === "greetings-entrance-submit" || action === "greetings-exit-submit") {
      const settings = greetingStore.getGreetingSettings(interaction.guildId);
      if (!settings) {
        await interaction.reply({ content: "Choose a Greeting Channel before editing saved messages.", flags: MessageFlags.Ephemeral });
        return true;
      }
      const field = action === "greetings-entrance-submit" ? "entranceMessage" : "exitMessage";
      const message = interaction.fields.getTextInputValue("message");
      try {
        greetingStore.updateGreetingSetting(interaction.guildId, field, message);
      } catch (error) {
        await interaction.reply({ content: error.message || "Enter a message before saving.", flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.reply({ ...greetingsManagerPayload(interaction, interaction.guildId, `${field === "entranceMessage" ? "Entrance" : "Exit"} Message saved.`), flags: MessageFlags.Ephemeral });
      return true;
    }
    if (action === "greetings-preview") {
      const settings = greetingStore.getGreetingSettings(interaction.guildId);
      if (!settings || !settings.enabled) {
        await interaction.reply({ content: "Harmony’s greetings are currently off. Choose a Greeting Channel and turn Greetings on first.", flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.reply({ ...greetingPreview(interaction, settings), flags: MessageFlags.Ephemeral });
      return true;
    }
    if (action === "greetings-test") {
      if (!isGreetingTestAuthorized(interaction)) {
        await interaction.reply({ content: "Only the server owner or an Administrator can send a Greetings test.", flags: MessageFlags.Ephemeral });
        return true;
      }
      const settings = greetingStore.getGreetingSettings(interaction.guildId);
      if (!settings || !settings.enabled) {
        await interaction.reply({ content: "Harmony’s greetings are currently off. Choose a Greeting Channel and turn Greetings on first.", flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const channel = interaction.guild.channels.cache.get(settings.channel_id)
        || await interaction.guild.channels.fetch(settings.channel_id).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        await interaction.editReply({ content: "The saved greeting channel is unavailable. Choose a text channel in the Greetings Manager." });
        return true;
      }
      const memberName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
      const content = greetingStore.renderGreetingMessage(settings.entrance_message, {
        memberMention: `<@${interaction.user.id}>`,
        memberName,
        serverName: interaction.guild.name,
      });
      try {
        await channel.send({ content, allowedMentions: { users: [interaction.user.id] } });
        await interaction.editReply({ content: `Test delivered successfully in <#${channel.id}>. Harmony can post greetings there.` });
      } catch (error) {
        console.error("Harmony greeting delivery test failed:", error);
        const code = error?.code ? " Discord error: " + error.code + "." : "";
        await interaction.editReply({ content: `Harmony could not post in <#${channel.id}>. Check **View Channel** and **Send Messages** permissions.${code}` });
      }
      return true;
    }
    if (action === "greetings-toggle") {
      const settings = greetingStore.getGreetingSettings(interaction.guildId);
      if (!settings) {
        await interaction.update(greetingsManagerPayload(interaction, interaction.guildId, "Choose a Greeting Channel before turning Greetings on."));
        return true;
      }
      const nextEnabled = !settings.enabled;
      greetingStore.setGreetingEnabled(interaction.guildId, nextEnabled);
      await interaction.update(greetingsManagerPayload(interaction, interaction.guildId, `Greetings are now **${nextEnabled ? "On" : "Off"}**. Saved channel and messages were preserved.`));
      return true;
    }
    if (action === "greetings-close") {
      greetingsNavigationSessions.delete(greetingsSessionKey(interaction));
      await interaction.update({ content: "Greetings Manager closed.", embeds: [], components: [] });
      return true;
    }
  }
  if (action.startsWith("welcome-") && !hasActiveWelcomeNavigation(interaction)) {
    await interaction.reply({ content: "This Welcome Pass screen came from an Admin Controls panel that is no longer active. Open Welcome Pass from the current panel.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (["welcome-role", "welcome-entry", "welcome-private", "welcome-member"].includes(action)) {
    welcomeDraft(interaction);
    const field = action === "welcome-role" ? "role"
      : action === "welcome-entry" ? "entry"
        : action === "welcome-private" ? "private" : "member";
    await interaction.update(welcomePickerPayload(field));
    return true;
  }
  if (action === "welcome-role-select") {
    const roleId = interaction.values?.[0];
    const role = roleId && (interaction.guild.roles.cache.get(roleId) || await interaction.guild.roles.fetch(roleId).catch(() => null));
    try {
      welcomePassService.validateWelcomePassRole(interaction.guild, role);
      await saveWelcomeManagerField(interaction, "roleId", role.id);
    } catch (error) {
      await interaction.reply({ content: error.message || "Choose a valid approved role.", flags: MessageFlags.Ephemeral });
    }
    return true;
  }
  if (action === "welcome-bias-roles") {
    await interaction.update(welcomeBiasRolePage(interaction.guildId));
    return true;
  }
  const selectingBias = action === "welcome-bias-role-bias" && interaction.isStringSelectMenu?.();
  const savingBiasRole = action === "welcome-bias-role-value" && interaction.isStringSelectMenu?.();
  if (selectingBias || savingBiasRole || action === "welcome-bias-role-page") {
    const selectedBias = selectingBias ? interaction.values?.[0] : decodeURIComponent(parameter || "");
    if (!BIAS_ROLE_KEYS.includes(selectedBias)) {
      await interaction.reply({ content: "Choose one of the supported member biases.", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.deferUpdate();
    const roles = await interaction.guild.roles.fetch().catch(() => null);
    if (!hasActiveWelcomeNavigation(interaction)) {
      await interaction.editReply(pagePayload("Welcome Pass", "Open Welcome Pass from the current Admin Controls panel."));
      return true;
    }
    if (!roles) {
      await interaction.editReply(welcomeBiasRolePage(interaction.guildId, null, "Harmony couldn’t load the server roles. Choose a bias to try again."));
      return true;
    }

    let notice;
    if (savingBiasRole) {
      const role = roles.get(interaction.values?.[0]);
      if (!role || role.id === interaction.guildId || (role.guild?.id && role.guild.id !== interaction.guildId)) {
        notice = "Choose a valid server role other than @everyone.";
      } else if (!isAssignableBiasRole(role)) {
        notice = "Harmony cannot manage that role. Choose an unmanaged role below Harmony’s highest role.";
      } else {
        try {
          welcomePassStore.setWelcomePassBiasRole(interaction.guildId, selectedBias, role.id);
          notice = `${selectedBias} members will use <@&${role.id}>.`;
        } catch (error) {
          notice = error.message || "Harmony could not save that bias role mapping.";
        }
      }
    }
    await interaction.editReply(welcomeBiasRolePage(interaction.guildId, selectedBias, notice, roles, panelId));
    return true;
  }
  if (action === "welcome-bias-role-clear") {
    const selectedBias = decodeURIComponent(parameter || "");
    const removed = welcomePassStore.removeWelcomePassBiasRole(interaction.guildId, selectedBias);
    await interaction.update(welcomeBiasRolePage(interaction.guildId, null, removed ? `${selectedBias} mapping cleared. Existing member roles were not changed; use reconciliation after configuring the new mapping.` : "No mapping was saved for that bias."));
    return true;
  }
  if (action === "welcome-bias-reconcile") {
    await interaction.update(welcomeBiasReconcileConfirmPage());
    return true;
  }
  if (action === "welcome-bias-reconcile-confirm") {
    await interaction.deferUpdate();
    const result = await welcomePassBiasRoleService.reconcileGuildBiasRoles(interaction.client, interaction.guildId);
    const content = result.status === "guild_unavailable"
      ? "Harmony could not access this server. No member roles were changed."
      : `Bias-role reconciliation ${result.status === "complete" ? "finished" : "finished with some roles needing attention"}.\nMembers checked: **${result.processed}** · Added: **${result.added}** · Removed: **${result.removed}** · Issues: **${result.issues}**`;
    await interaction.editReply({ content, embeds: [], components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-admin-room:welcome-bias-roles").setLabel("Back to Member Bias Roles").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-admin-room:welcome:ephemeral").setLabel("Back to Welcome Pass").setStyle(ButtonStyle.Secondary),
    )] });
    return true;
  }
  if (["welcome-entry-select", "welcome-private-select", "welcome-member-select"].includes(action)) {
    const channelId = interaction.values?.[0];
    const channel = channelId && (interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null));
    if (!channel || channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: "Choose a text channel in this server.", flags: MessageFlags.Ephemeral });
      return true;
    }
    const field = action === "welcome-entry-select" ? "entryChannelId"
      : action === "welcome-private-select" ? "channelId" : "releaseChannelId";
    await saveWelcomeManagerField(interaction, field, channel.id, field !== "channelId");
    return true;
  }
  if (["welcome-entry-message", "welcome-approved-message"].includes(action)) {
    welcomeDraft(interaction);
    const kind = action === "welcome-entry-message" ? "entry" : "approved";
    await interaction.update(welcomeMessagePromptPayload(interaction.guild, interaction.user.id, kind));
    return true;
  }
  if (["welcome-entry-message-edit", "welcome-approved-message-edit"].includes(action)) {
    const draft = welcomeDraft(interaction);
    const settings = welcomePassStore.getWelcomePassSettings(interaction.guildId);
    const kind = action === "welcome-entry-message-edit" ? "entry" : "approved";
    const value = kind === "entry"
      ? (settings?.entry_message || draft.entryMessage || greetingStore.getGreetingSettings(interaction.guildId)?.entrance_message || greetingStore.DEFAULT_ENTRANCE_MESSAGE)
      : (settings?.release_message || draft.releaseMessage || welcomePassStore.DEFAULT_RELEASE_MESSAGE);
    await interaction.showModal(welcomeMessageModal(kind, value));
    return true;
  }
  if (action === "welcome-entry-message-submit" && interaction.isModalSubmit?.()) {
    const message = interaction.fields.getTextInputValue("message");
    await saveWelcomeManagerField(interaction, "entryMessage", message);
    return true;
  }
  if (action === "welcome-approved-message-submit" && interaction.isModalSubmit?.()) {
    const message = interaction.fields.getTextInputValue("message");
    await saveWelcomeManagerField(interaction, "releaseMessage", message);
    return true;
  }
  if (action === "welcome-mode") {
    const settings = welcomePassStore.getWelcomePassSettings(interaction.guildId);
    if (!settings?.role_id || !settings?.channel_id || !settings?.release_channel_id) {
      await interaction.update(welcomePassPage(interaction.guild, interaction.user.id, "Choose the approved role and both channels before changing grant mode."));
      return true;
    }
    const mode = settings.grant_mode === "manual" ? "automatic" : "manual";
    welcomePassStore.setWelcomePassGrantMode(interaction.guildId, mode);
    const notice = mode === "manual"
      ? "Grant Mode is now Manual. Harmony waits for an admin to grant the configured role, then sends the member message and private confirmation."
      : "Grant Mode is now Automatic. Harmony grants the role after approval and an exact Discord account match.";
    await interaction.update(welcomePassPage(interaction.guild, interaction.user.id, notice));
    return true;
  }
  if (action === "welcome-cancel") {
    clearWelcomeDraft(interaction);
    await interaction.update(welcomePassPage(interaction.guild, interaction.user.id, "Unfinished setup selections were discarded. Existing configuration is unchanged."));
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
  if (["collections"].includes(action)) {
    const area = action;
    const payload = communityToolPage(interaction.guildId, area);
    if (payload) await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "media") {
    setMediaNavigation(interaction);
    await interaction.reply({ ...await mediaManagerPayload(interaction.guild, interaction.client), flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action.startsWith("media-")) {
    if (!hasActiveMediaNavigation(interaction)) {
      await interaction.reply({ content: "This Media & Errors screen came from an Admin Controls panel that is no longer active. Open Media & Errors from the current panel.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (action === "media-refresh") {
      await interaction.update(await mediaManagerPayload(interaction.guild, interaction.client));
      return true;
    }
    if (action === "media-close") {
      mediaNavigationSessions.delete(mediaSessionKey(interaction));
      await interaction.update({ content: "Media & Errors Manager closed.", embeds: [], components: [] });
      return true;
    }
    if (action === "media-forget") {
      await interaction.showModal(forgetSharedPostModal());
      return true;
    }
    if (action === "media-forget-submit" && interaction.isModalSubmit?.()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const link = String(interaction.fields?.getTextInputValue?.("link") || "").trim();
        if (!link || link.length > 2000) {
          await interaction.editReply({ content: forgetShareCommand.INVALID_LINK_MESSAGE });
          return true;
        }
        const result = await forgetShareCommand.forgetSharedPost(link, interaction.guildId);
        const content = result.status === "removed"
          ? "That post has been removed from Harmony’s memory and can be shared again."
          : result.status === "not_found"
            ? "Harmony doesn’t currently have that post saved in her memory."
            : forgetShareCommand.INVALID_LINK_MESSAGE;
        await interaction.editReply({ content });
      } catch {
        await interaction.editReply({ content: "Harmony couldn’t check that post link right now. Please try again later." });
      }
      return true;
    }
    if (action === "media-error-inbox-select") {
      const channelId = interaction.values?.[0];
      const channel = channelId && (interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null));
      if (!channel || channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildText) {
        await interaction.reply({ content: "Choose a text channel in this server for the central Error Inbox.", flags: MessageFlags.Ephemeral });
        return true;
      }
      const botMember = interaction.guild.members?.me;
      const permissions = botMember && channel.permissionsFor?.(botMember);
      const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
      if (!permissions || required.some((permission) => !permissions.has(permission))) {
        await interaction.reply({ content: `Harmony needs **View Channel**, **Send Messages**, and **Embed Links** in <#${channel.id}>. The saved Error Inbox was not changed.`, flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.deferUpdate();
      try {
        const tested = await errorInboxService.sendErrorInboxTestToChannel(channel, interaction);
        if (!tested) {
          await interaction.editReply(await mediaManagerPayload(interaction.guild, interaction.client, "Harmony could not test that channel. The saved Error Inbox was not changed."));
          return true;
        }
        errorInboxStore.saveErrorInboxSettings(interaction.guildId, channel.id);
        await interaction.editReply(await mediaManagerPayload(interaction.guild, interaction.client, `The central Error Inbox was tested and saved to <#${channel.id}>. Media failures from every server Harmony serves will go there.`));
      } catch {
        await interaction.editReply(await mediaManagerPayload(interaction.guild, interaction.client, "Harmony could not post its test report there. The saved Error Inbox was not changed. Check the channel permissions and try again."));
      }
      return true;
    }
    if (action === "media-inbox-toggle") {
      const settings = errorInboxStore.getErrorInboxSettings();
      if (!settings) {
        await interaction.update(await mediaManagerPayload(interaction.guild, interaction.client, "Choose and test an Error Inbox channel before turning the inbox on."));
        return true;
      }
      const nextEnabled = !settings.enabled;
      if (nextEnabled) errorInboxStore.enableErrorInbox();
      else errorInboxStore.disableErrorInbox();
      await interaction.update(await mediaManagerPayload(interaction.guild, interaction.client, `The central Error Inbox is now **${nextEnabled ? "On" : "Off"}**. Its saved destination was preserved.`));
      return true;
    }
    if (action === "media-inbox-test") {
      await interaction.deferUpdate();
      try {
        const delivered = await errorInboxService.sendErrorInboxTest(interaction.client, interaction);
        const notice = delivered
          ? "Test delivered to the central Error Inbox."
          : "The saved Error Inbox is unavailable or off. Choose and test a destination channel.";
        await interaction.editReply(await mediaManagerPayload(interaction.guild, interaction.client, notice));
      } catch {
        await interaction.editReply(await mediaManagerPayload(interaction.guild, interaction.client, "Harmony could not send the Error Inbox test. Check the saved channel permissions and try again."));
      }
      return true;
    }
    if (action === "media-monitor-toggle") {
      const result = errorMonitorService.toggleErrorMonitor();
      const notice = result.ok
        ? result.enabled
          ? "Automatic Error Monitor is on. Only sanitized media failures are filed; nothing merges or deploys automatically."
          : "Automatic Error Monitor is off. Existing reports were left in place."
        : "Automatic Error Monitor could not be turned on because its private GitHub setup is missing or invalid. Ask the owner to complete setup.";
      await interaction.update(await mediaManagerPayload(interaction.guild, interaction.client, notice));
      return true;
    }
    if (action === "media-forget-submit") {
      await interaction.reply({ content: "That Forget Shared Post form is no longer available. Reopen it from the current Media & Errors Manager.", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.reply({ content: "That Media & Errors control is not available. Refresh the manager and try again.", flags: MessageFlags.Ephemeral });
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
  mediaManagerPayload,
  forgetSharedPostModal,
  guardPage,
  guardHistoryPayload,
  ruleListPayload,
  rulePickerPayload,
  guardRuleDetailsPayload,
  configureRequestedGuardReviewRoom,
  handleAdminRoomInteraction,
  refreshConfiguredAdminRooms,
  refreshMemberCountDisplay,
  handleMemberCountDisplayDeletion,
  HISTORY_PAGE_SIZE,
};
