const {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require("discord.js");
const store = require("../stores/communityGuardStore");
const {
  createRule,
  editRule,
  removeRule,
  reviewRoomVisibilityWarning,
  RULE_TYPE_CHOICES,
  REASON_CHOICES,
  ACTION_CHOICES,
  MATCH_CHOICES,
  formatRule,
} = require("../services/communityGuardService");

function addConditionOptions(sub, { edit = false } = {}) {
  const start = 2;
  const end = 5;
  if (edit) {
    sub.addStringOption((option) => option.setName("condition-1-type")
      .setDescription("Start replacing conditions here; include condition 1 when changing conditions")
      .setRequired(false).addChoices(...RULE_TYPE_CHOICES));
    sub.addStringOption((option) => option.setName("condition-1-value")
      .setDescription("Value for condition 1; leave blank for attachment conditions")
      .setRequired(false).setMaxLength(300));
  }
  for (let index = start; index <= end; index += 1) {
    sub.addStringOption((option) => option.setName(`condition-${index}-type`)
      .setDescription(`Optional condition ${index}; when editing, also provide condition 1`)
      .setRequired(false).addChoices(...RULE_TYPE_CHOICES));
    sub.addStringOption((option) => option.setName(`condition-${index}-value`)
      .setDescription(`Condition ${index} text, domain, or URL value`)
      .setRequired(false).setMaxLength(300));
  }
  return sub;
}

function addRuleOptions(sub) {
  sub.addStringOption((option) => option.setName("type").setDescription("First condition to check")
    .setRequired(true).addChoices(...RULE_TYPE_CHOICES));
  sub.addStringOption((option) => option.setName("reason").setDescription("Private explanation Harmony should use")
    .setRequired(true).addChoices(...REASON_CHOICES));
  sub.addStringOption((option) => option.setName("name").setDescription("Short name shown to moderators")
    .setRequired(false).setMaxLength(80));
  sub.addStringOption((option) => option.setName("value").setDescription("Text, domain, or URL value; leave blank for attachment conditions")
    .setRequired(false).setMaxLength(300));
  for (let index = 2; index <= 5; index += 1) {
    sub.addStringOption((option) => option.setName(`condition-${index}-type`)
      .setDescription(`Optional condition ${index} type`).setRequired(false).addChoices(...RULE_TYPE_CHOICES));
    sub.addStringOption((option) => option.setName(`condition-${index}-value`)
      .setDescription(`Condition ${index} text, domain, or URL value`).setRequired(false).setMaxLength(300));
  }
  sub.addStringOption((option) => option.setName("match-mode").setDescription("How conditions combine; defaults to ALL")
    .setRequired(false).addChoices(...MATCH_CHOICES));
  sub.addStringOption((option) => option.setName("action").setDescription("New rules default to Admin Review")
    .setRequired(false).addChoices(...ACTION_CHOICES));
  return sub;
}

const data = new SlashCommandBuilder()
  .setName("harmony-guard")
  .setDescription("Configure Harmony Guard rules and review settings")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) => sub.setName("setup")
    .setDescription("Choose the Guard Review Room and turn automatic monitoring on")
    .addChannelOption((option) => option.setName("channel")
      .setDescription("Channel for Guard review cards and removal logs")
      .addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand((sub) => addRuleOptions(sub.setName("rule-add")
    .setDescription("Add a rule with one or more conditions")))
  .addSubcommand((sub) => {
    sub.setName("rule-edit").setDescription("Edit a rule without changing its ID or history")
      .addIntegerOption((option) => option.setName("rule-id").setDescription("Rule number shown by rules")
        .setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName("name").setDescription("New short name")
        .setRequired(false).setMaxLength(80))
      .addStringOption((option) => option.setName("match-mode").setDescription("ALL or ANY; defaults to current mode")
        .setRequired(false).addChoices(...MATCH_CHOICES))
      .addStringOption((option) => option.setName("reason").setDescription("New member-facing reason")
        .setRequired(false).addChoices(...REASON_CHOICES))
      .addStringOption((option) => option.setName("action").setDescription("Admin Review or automatic removal")
        .setRequired(false).addChoices(...ACTION_CHOICES));
    return addConditionOptions(sub, { edit: true });
  })
  .addSubcommand((sub) => sub.setName("rule-remove").setDescription("Remove one configured rule")
    .addIntegerOption((option) => option.setName("rule-id").setDescription("Rule number shown by rules")
      .setRequired(true).setMinValue(1)))
  .addSubcommand((sub) => sub.setName("rules").setDescription("List configured Guard rules"))
  .addSubcommand((sub) => sub.setName("status").setDescription("Show Guard monitoring and review-room setup"))
  .addSubcommand((sub) => sub.setName("off").setDescription("Turn automatic monitoring off; manual removal remains available"));

function readString(interaction, name) {
  return interaction.options.getString(name, false) ?? null;
}

function collectConditions(interaction, { editing = false } = {}) {
  const conditions = [];
  const firstType = readString(interaction, editing ? "condition-1-type" : "type");
  if (!firstType && editing) {
    const hasOtherCondition = Array.from({ length: 4 }, (_, index) => index + 2).some((index) =>
      readString(interaction, `condition-${index}-type`) || readString(interaction, `condition-${index}-value`)
    );
    if (hasOtherCondition) throw new Error("To replace a rule’s conditions, provide condition 1 and each condition you want to keep.");
    return null;
  }
  if (!firstType) throw new Error("Choose the first condition type.");
  conditions.push({ type: firstType, value: readString(interaction, editing ? "condition-1-value" : "value") });
  for (let index = 2; index <= 5; index += 1) {
    const type = readString(interaction, `condition-${index}-type`);
    const value = readString(interaction, `condition-${index}-value`);
    if (!type && value) throw new Error(`Choose a type for condition ${index}.`);
    if (type) conditions.push({ type, value });
  }
  return conditions;
}

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) return interaction.editReply("Use this command inside a server.");
  const action = interaction.options.getSubcommand();

  if (action === "setup") {
    const channel = interaction.options.getChannel("channel", true);
    store.saveSettings(interaction.guild.id, channel.id);
    return interaction.editReply([
      `💜 **Guard Review Room set:** <#${channel.id}>`,
      "Automatic monitoring is on. Existing rules are preserved; setup does not create rules.",
      reviewRoomVisibilityWarning(channel),
    ].join("\n\n"));
  }

  if (action === "off") {
    store.disableSettings(interaction.guild.id);
    return interaction.editReply("Automatic Guard monitoring is off. Rules and the manual right-click moderation action remain available.");
  }

  if (action === "rule-add") {
    if (!store.getSettings(interaction.guild.id)?.enabled) return interaction.editReply("Choose a Guard Review Room with `/harmony-guard setup` first.");
    try {
      const conditions = collectConditions(interaction);
      const id = createRule({
        guildId: interaction.guild.id,
        name: readString(interaction, "name"),
        conditions,
        matchMode: readString(interaction, "match-mode") || "all",
        category: interaction.options.getString("reason", true),
        action: readString(interaction, "action") || "flag",
      });
      return interaction.editReply(`Rule **#${id}** added. It will use **${String(readString(interaction, "action") || "flag").toLowerCase() === "remove" ? "Automatic Removal" : "Admin Review"}**.`);
    } catch (error) {
      return interaction.editReply(error.message || "I couldn’t add that Guard rule.");
    }
  }

  if (action === "rule-edit") {
    const ruleId = interaction.options.getInteger("rule-id", true);
    try {
      const conditions = collectConditions(interaction, { editing: true });
      const changes = {
        name: readString(interaction, "name") ?? undefined,
        matchMode: readString(interaction, "match-mode") ?? undefined,
        category: readString(interaction, "reason") ?? undefined,
        action: readString(interaction, "action") ?? undefined,
        conditions: conditions ?? undefined,
      };
      const saved = editRule(interaction.guild.id, ruleId, changes);
      return interaction.editReply(saved ? `Rule **#${ruleId}** updated.` : `I couldn’t find enabled rule **#${ruleId}** in this server.`);
    } catch (error) {
      return interaction.editReply(error.message || "I couldn’t update that Guard rule.");
    }
  }

  if (action === "rule-remove") {
    const id = interaction.options.getInteger("rule-id", true);
    return interaction.editReply(removeRule(interaction.guild.id, id)
      ? `Guard rule **#${id}** was removed.`
      : `I couldn’t find rule **#${id}** in this server.`);
  }

  const settings = store.getSettings(interaction.guild.id);
  const rules = store.listRules(interaction.guild.id);
  if (action === "status") {
    return interaction.editReply([
      "💜 **Harmony Guard**",
      `Automatic monitoring: **${settings?.enabled ? "On" : "Off"}**`,
      `Guard Review Room: ${settings?.channel_id ? `<#${settings.channel_id}>` : "Not configured"}`,
      `Configured rules: **${rules.length}**`,
      "Manual right-click moderation: **Available**",
    ].join("\n"));
  }

  if (!rules.length) return interaction.editReply("No Guard rules have been added yet.");
  return interaction.editReply({
    content: rules.map(formatRule).join("\n\n").slice(0, 1900),
    allowedMentions: { parse: [] },
  });
}

module.exports = { data, execute, collectConditions, formatRule };
