const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} = require("discord.js");
const {
  DEFAULT_ENTRANCE_MESSAGE,
  DEFAULT_EXIT_MESSAGE,
  getGreetingSettings,
  saveGreetingSettings,
  disableGreetingSettings,
  renderGreetingMessage,
} = require("../stores/greetingStore");

const data = new SlashCommandBuilder()
  .setName("harmony-greetings")
  .setDescription("Configure Harmony’s member entrance and exit messages")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("setup")
      .setDescription("Choose a channel and save the greeting messages")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel for entrance and exit messages")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("entrance-message")
          .setDescription("Use {member}, {name}, and {server}; blank uses the default")
          .setMaxLength(1000)
          .setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName("exit-message")
          .setDescription("Use {name} and {server}; blank uses the default")
          .setMaxLength(1000)
          .setRequired(false)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("preview")
      .setDescription("Privately preview the saved entrance and exit messages")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("test")
      .setDescription("Send the saved entrance message in the configured channel")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("off")
      .setDescription("Turn off Harmony’s entrance and exit messages")
  );

function buildPreview(interaction, settings) {
  const memberName =
    interaction.member?.displayName ||
    interaction.user.globalName ||
    interaction.user.username;
  const values = {
    memberMention: "<@" + interaction.user.id + ">",
    memberName,
    serverName: interaction.guild.name,
  };

  return [
    "💜 **Harmony Greetings Preview**",
    "",
    "**Entrance**",
    renderGreetingMessage(settings.entrance_message, values),
    "",
    "**Exit**",
    renderGreetingMessage(settings.exit_message, values),
    "",
    "Channel: <#" + settings.channel_id + ">",
  ].join("\n");
}

async function execute(interaction) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  if (!interaction.guild) {
    await interaction.editReply({
      content: "This command can only be used inside a Discord server.",
    });
    return;
  }

  try {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "setup") {
      const channel = interaction.options.getChannel("channel", true);
      const entranceMessage =
        interaction.options.getString("entrance-message") ||
        DEFAULT_ENTRANCE_MESSAGE;
      const exitMessage =
        interaction.options.getString("exit-message") ||
        DEFAULT_EXIT_MESSAGE;

      saveGreetingSettings({
        guildId: interaction.guild.id,
        channelId: channel.id,
        entranceMessage,
        exitMessage,
      });

      const settings = getGreetingSettings(interaction.guild.id);
      await interaction.editReply({
        content:
          "Harmony’s entrance and exit messages are now on.\n\n" +
          buildPreview(interaction, settings),
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === "preview") {
      const settings = getGreetingSettings(interaction.guild.id);
      if (!settings || !settings.enabled) {
        await interaction.editReply({
          content:
            "Harmony’s greetings are currently off. Use /harmony-greetings setup first.",
        });
        return;
      }

      await interaction.editReply({
        content: buildPreview(interaction, settings),
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === "test") {
      const settings = getGreetingSettings(interaction.guild.id);
      if (!settings || !settings.enabled) {
        await interaction.editReply({
          content:
            "Harmony’s greetings are currently off. Use /harmony-greetings setup first.",
        });
        return;
      }

      const channel =
        interaction.guild.channels.cache.get(settings.channel_id) ||
        (await interaction.guild.channels
          .fetch(settings.channel_id)
          .catch(() => null));

      if (!channel || !channel.isTextBased()) {
        await interaction.editReply({
          content:
            "The saved greeting channel is unavailable. Run setup again and choose a text channel.",
        });
        return;
      }

      const memberName =
        interaction.member?.displayName ||
        interaction.user.globalName ||
        interaction.user.username;
      const content = renderGreetingMessage(settings.entrance_message, {
        memberMention: "<@" + interaction.user.id + ">",
        memberName,
        serverName: interaction.guild.name,
      });

      try {
        await channel.send({
          content,
          allowedMentions: { users: [interaction.user.id] },
        });
        await interaction.editReply({
          content:
            "Test delivered successfully in <#" + channel.id + ">. Harmony can post greetings there.",
        });
      } catch (error) {
        console.error("Harmony greeting delivery test failed:", error);
        const code = error?.code ? " Discord error: " + error.code + "." : "";
        await interaction.editReply({
          content:
            "Harmony could not post in <#" + channel.id +
            ">. Check **View Channel** and **Send Messages** permissions." + code,
        });
      }
      return;
    }

    const disabled = disableGreetingSettings(interaction.guild.id);
    await interaction.editReply({
      content: disabled
        ? "Harmony’s entrance and exit messages are now off."
        : "Harmony’s greetings were not configured yet.",
    });
  } catch (error) {
    console.error("Harmony greetings command error:", error);
    await interaction.editReply({
      content:
        "I couldn’t update the greeting settings. Please check the Railway logs.",
    }).catch(() => {});
  }
}

module.exports = {
  data,
  execute,
};
