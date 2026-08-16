const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} = require("discord.js");
const {
  getCollectionSettings,
  saveCollectionSettings,
} = require("../stores/collectionStore");
const { buildRecapEmbed } = require("../services/collectionService");

const TIMEZONE_PATTERN = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/;

const data = new SlashCommandBuilder()
  .setName("harmony-collection")
  .setDescription("Configure and post Harmony collection celebrations")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("setup")
      .setDescription("Choose the celebration channel and automatic features")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel for recaps and milestones")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
      .addBooleanOption((option) =>
        option
          .setName("milestones")
          .setDescription("Celebrate first shares and contribution milestones")
          .setRequired(true)
      )
      .addBooleanOption((option) =>
        option
          .setName("weekly-recap")
          .setDescription("Post a recap automatically every week")
          .setRequired(true)
      )
      .addIntegerOption((option) =>
        option
          .setName("weekday")
          .setDescription("0 Sunday, 1 Monday … 6 Saturday")
          .setMinValue(0)
          .setMaxValue(6)
          .setRequired(false)
      )
      .addIntegerOption((option) =>
        option
          .setName("hour")
          .setDescription("Posting hour from 0–23 in your selected timezone")
          .setMinValue(0)
          .setMaxValue(23)
          .setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName("timezone")
          .setDescription("Example: America/New_York")
          .setMaxLength(50)
          .setRequired(false)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("recap")
      .setDescription("Preview privately or post a collection recap")
      .addStringOption((option) =>
        option
          .setName("period")
          .setDescription("Recap period")
          .setRequired(true)
          .addChoices(
            { name: "This week", value: "week" },
            { name: "This month", value: "month" },
            { name: "All time", value: "all" }
          )
      )
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("Preview privately or post publicly")
          .setRequired(true)
          .addChoices(
            { name: "Preview", value: "preview" },
            { name: "Post", value: "post" }
          )
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("status")
      .setDescription("View saved collection celebration settings")
  );

function validTimezone(value) {
  if (!TIMEZONE_PATTERN.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) return;

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "setup") {
    const channel = interaction.options.getChannel("channel", true);
    const milestones = interaction.options.getBoolean("milestones", true);
    const schedule = interaction.options.getBoolean("weekly-recap", true);
    const weekday = interaction.options.getInteger("weekday") ?? 0;
    const hour = interaction.options.getInteger("hour") ?? 10;
    const timezone =
      interaction.options.getString("timezone") || "America/New_York";

    if (!validTimezone(timezone)) {
      await interaction.editReply(
        "That timezone is not valid. Use a name such as `America/New_York`."
      );
      return;
    }

    saveCollectionSettings({
      guildId: interaction.guild.id,
      channelId: channel.id,
      milestonesEnabled: milestones,
      scheduleEnabled: schedule,
      weekday,
      hour,
      timezone,
    });

    await interaction.editReply({
      content: [
        "Harmony’s collection celebrations are ready. 💜",
        "",
        "Channel: <#" + channel.id + ">",
        "Milestones: **" + (milestones ? "On" : "Off") + "**",
        "Automatic weekly recap: **" + (schedule ? "On" : "Off") + "**",
        schedule
          ? "Schedule: weekday **" + weekday + "** at **" +
            String(hour).padStart(2, "0") + ":00** (" + timezone + ")"
          : null,
      ].filter(Boolean).join("\n"),
      allowedMentions: { parse: [] },
    });
    return;
  }

  const settings = getCollectionSettings(interaction.guild.id);
  if (!settings) {
    await interaction.editReply(
      "Run `/harmony-collection setup` first."
    );
    return;
  }

  if (subcommand === "status") {
    await interaction.editReply({
      content: [
        "💜 **Harmony Collection Settings**",
        "",
        "Channel: <#" + settings.channel_id + ">",
        "Milestones: **" + (settings.milestones_enabled ? "On" : "Off") + "**",
        "Automatic weekly recap: **" + (settings.schedule_enabled ? "On" : "Off") + "**",
        "Schedule: weekday **" + settings.weekday + "** at **" +
          String(settings.hour).padStart(2, "0") + ":00** (" +
          settings.timezone + ")",
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
    return;
  }

  const period = interaction.options.getString("period", true);
  const action = interaction.options.getString("action", true);
  const embed = buildRecapEmbed(interaction.guild.id, period);

  if (action === "preview") {
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const channel =
    interaction.guild.channels.cache.get(settings.channel_id) ||
    (await interaction.guild.channels
      .fetch(settings.channel_id)
      .catch(() => null));
  if (!channel || !channel.isTextBased()) {
    await interaction.editReply(
      "The saved collection channel is unavailable. Run setup again."
    );
    return;
  }

  await channel.send({
    embeds: [embed],
    allowedMentions: { parse: ["users"] },
  });
  await interaction.editReply(
    "The collection recap was posted in <#" + channel.id + ">."
  );
}

module.exports = { data, execute };
