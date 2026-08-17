const {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require("discord.js");
const store = require("../stores/communityGuardStore");
const { CATEGORY_LABELS, normalizeDomain } = require("../services/communityGuardService");

const data = new SlashCommandBuilder()
  .setName("harmony-guard")
  .setDescription("Configure Harmony’s private Community Guard")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) => sub.setName("setup")
    .setDescription("Turn Community Guard on and choose its private review channel")
    .addChannelOption((option) => option.setName("channel")
      .setDescription("Private channel for reviews and removal records")
      .addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand((sub) => sub.setName("rule-add")
    .setDescription("Add a website, URL pattern, word, or phrase supplied by an admin")
    .addStringOption((option) => option.setName("type").setDescription("What Harmony should match")
      .setRequired(true).addChoices(
        { name: "Website/domain", value: "domain" },
        { name: "URL pattern", value: "url" },
        { name: "Word or phrase", value: "phrase" }
      ))
    .addStringOption((option) => option.setName("value").setDescription("Exact domain, URL text, word, or phrase")
      .setRequired(true).setMaxLength(300))
    .addStringOption((option) => option.setName("reason").setDescription("Private explanation Harmony should use")
      .setRequired(true).addChoices(
        { name: "Paid content", value: "paid" },
        { name: "Self-promotion", value: "promotion" },
        { name: "Inappropriate content", value: "inappropriate" },
        { name: "Harmful or ridiculing AI", value: "harmful_ai" },
        { name: "Spam or scam", value: "spam" },
        { name: "Other rule violation", value: "other" }
      ))
    .addStringOption((option) => option.setName("action").setDescription("Flag privately or remove automatically")
      .setRequired(true).addChoices(
        { name: "Flag for private admin review", value: "flag" },
        { name: "Automatically remove and privately DM", value: "remove" }
      )))
  .addSubcommand((sub) => sub.setName("rule-remove").setDescription("Remove one configured rule")
    .addIntegerOption((option) => option.setName("rule-id").setDescription("Rule number shown by the rules command")
      .setRequired(true).setMinValue(1)))
  .addSubcommand((sub) => sub.setName("rules").setDescription("List configured Community Guard rules"))
  .addSubcommand((sub) => sub.setName("status").setDescription("Show Community Guard’s current setup"))
  .addSubcommand((sub) => sub.setName("off").setDescription("Turn automatic monitoring off; manual removal remains available"));

function cleanRuleValue(type, value) {
  const trimmed = String(value || "").trim();
  return type === "domain" ? normalizeDomain(trimmed) : trimmed.toLowerCase();
}

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) return interaction.editReply("Use this command inside a server.");
  const action = interaction.options.getSubcommand();

  if (action === "setup") {
    const channel = interaction.options.getChannel("channel", true);
    store.saveSettings(interaction.guild.id, channel.id);
    return interaction.editReply([
      "💜 **Harmony Community Guard is ready.**",
      "Private review channel: <#" + channel.id + ">",
      "No automatic rules are created by setup. Add only the websites, URL patterns, words, or phrases your admin team chooses.",
      "Admins can also right-click any member message and choose **Apps → Harmony: Moderate Message**.",
    ].join("\n\n"));
  }

  if (action === "off") {
    store.disableSettings(interaction.guild.id);
    return interaction.editReply("Automatic Community Guard monitoring is off. The manual right-click removal remains available to admins.");
  }

  if (action === "rule-add") {
    const settings = store.getSettings(interaction.guild.id);
    if (!settings?.enabled) return interaction.editReply("Run `/harmony-guard setup` first.");
    const type = interaction.options.getString("type", true);
    const pattern = cleanRuleValue(type, interaction.options.getString("value", true));
    const category = interaction.options.getString("reason", true);
    const ruleAction = interaction.options.getString("action", true);
    if (!pattern || (type === "domain" && !pattern.includes("."))) {
      return interaction.editReply("Please enter a valid rule value. Domains should look like `example.com`.");
    }
    const id = store.addRule({ guildId: interaction.guild.id, type, pattern, action: ruleAction, category });
    return interaction.editReply(
      "Rule **#" + id + "** added. Harmony will **" +
      (ruleAction === "remove" ? "automatically remove and privately DM" : "flag privately for review") +
      "** matches for **" + CATEGORY_LABELS[category] + "**."
    );
  }

  if (action === "rule-remove") {
    const id = interaction.options.getInteger("rule-id", true);
    return interaction.editReply(
      store.removeRule(interaction.guild.id, id)
        ? "Community Guard rule **#" + id + "** was removed."
        : "I couldn’t find rule **#" + id + "** in this server."
    );
  }

  const settings = store.getSettings(interaction.guild.id);
  const rules = store.listRules(interaction.guild.id);
  if (action === "status") {
    return interaction.editReply([
      "💜 **Harmony Community Guard**",
      "Status: **" + (settings?.enabled ? "On" : "Off") + "**",
      "Private channel: " + (settings?.channel_id ? "<#" + settings.channel_id + ">" : "Not configured"),
      "Configured rules: **" + rules.length + "**",
      "Manual private-DM removal: **Available**",
    ].join("\n"));
  }

  if (!rules.length) return interaction.editReply("No Community Guard rules have been added yet.");
  return interaction.editReply({
    content: rules.map((rule) =>
      "**#" + rule.id + "** · " + rule.rule_type + " · `" + rule.pattern.replace(/`/g, "") + "`\n" +
      CATEGORY_LABELS[rule.category] + " · " + (rule.action === "remove" ? "Automatic removal + private DM" : "Private review")
    ).join("\n\n").slice(0, 1900),
    allowedMentions: { parse: [] },
  });
}

module.exports = { data, execute };
