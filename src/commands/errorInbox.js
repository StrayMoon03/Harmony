const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} = require("discord.js");
const {
  getErrorInboxSettings,
  saveErrorInboxSettings,
  disableErrorInbox,
} = require("../stores/errorInboxStore");
const { sendErrorInboxTest } = require("../services/errorInboxService");

const data = new SlashCommandBuilder()
  .setName("harmony-errors")
  .setDescription("Configure Harmony’s central private media-error inbox")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName("setup")
      .setDescription("Send errors from every server to one private channel")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Private troubleshooting channel")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("Show the central error-inbox status")
  )
  .addSubcommand((sub) =>
    sub.setName("test").setDescription("Send a test report to the saved inbox")
  )
  .addSubcommand((sub) =>
    sub.setName("off").setDescription("Turn the central error inbox off")
  );

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.guild) {
    return interaction.editReply("Use this command inside your private troubleshooting server.");
  }

  try {
    const action = interaction.options.getSubcommand();

    if (action === "setup") {
      const channel = interaction.options.getChannel("channel", true);

      try {
        await channel.send({
          content: "💜 Harmony is checking this private troubleshooting channel...",
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        console.error("Harmony error-inbox permission test failed:", error);
        return interaction.editReply(
          `I cannot post in <#${channel.id}>. Give Harmony **View Channel**, **Send Messages**, and **Embed Links**, then try again.`
        );
      }

      saveErrorInboxSettings(interaction.guild.id, channel.id);
      await sendErrorInboxTest(interaction.client, interaction);

      return interaction.editReply(
        `Harmony’s central error inbox is now <#${channel.id}>. Media failures from **every server Harmony is in** will be reported there privately.`
      );
    }

    if (action === "off") {
      disableErrorInbox();
      return interaction.editReply("Harmony’s central media-error inbox is now off.");
    }

    const settings = getErrorInboxSettings();
    if (!settings?.enabled) {
      return interaction.editReply(
        "Harmony’s central error inbox is off. Use harmony-errors setup in your private server."
      );
    }

    if (action === "test") {
      const delivered = await sendErrorInboxTest(interaction.client, interaction);
      return interaction.editReply(
        delivered
          ? "Test delivered to Harmony’s central error inbox."
          : "The saved error channel is unavailable. Run setup again."
      );
    }

    const destinationGuild =
      interaction.client.guilds.cache.get(settings.destination_guild_id);
    const destinationChannel =
      destinationGuild?.channels.cache.get(settings.destination_channel_id);

    return interaction.editReply([
      "Status: **On**",
      `Server: **${destinationGuild?.name || settings.destination_guild_id}**`,
      `Channel: **${destinationChannel?.name ? "#" + destinationChannel.name : settings.destination_channel_id}**`,
      "Scope: **Media failures from every server Harmony serves**",
    ].join("\n"));
  } catch (error) {
    console.error("Harmony error-inbox command failed:", error);
    return interaction.editReply(
      "I couldn’t update the error inbox. Please check Railway’s logs."
    );
  }
}

module.exports = { data, execute };
