const {
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType,
} = require("discord.js");
const store = require("../stores/messageLogStore");

const data = new SlashCommandBuilder()
  .setName("harmony-logs")
  .setDescription("Configure Harmony’s private three-day message log")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) => sub.setName("setup")
    .setDescription("Turn logging on and choose its private channel")
    .addChannelOption((option) => option.setName("channel")
      .setDescription("Private channel where Harmony sends logs")
      .addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand((sub) => sub.setName("status").setDescription("Show the current logging setup"))
  .addSubcommand((sub) => sub.setName("off").setDescription("Turn message logging off"))
  .addSubcommand((sub) => sub.setName("exclude")
    .setDescription("Stop logging one channel")
    .addChannelOption((option) => option.setName("channel")
      .setDescription("Channel Harmony should ignore")
      .addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand((sub) => sub.setName("include")
    .setDescription("Resume logging one excluded channel")
    .addChannelOption((option) => option.setName("channel")
      .setDescription("Channel Harmony should log again")
      .addChannelTypes(ChannelType.GuildText).setRequired(true)));

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) return interaction.editReply("Use this command inside a server.");
  try {
    const action = interaction.options.getSubcommand();
    if (action === "setup") {
      const channel = interaction.options.getChannel("channel", true);
      store.saveLogSettings(interaction.guild.id, channel.id);
      return interaction.editReply(
        `Harmony’s message log is on in <#${channel.id}>. New messages, edits, and deletions will be logged and automatically erased after 3 days. Make sure only trusted admins can view that channel.`
      );
    }
    if (action === "off") {
      store.disableLogSettings(interaction.guild.id);
      return interaction.editReply("Harmony’s message logging is now off. Existing log entries will still expire on schedule.");
    }
    if (action === "exclude" || action === "include") {
      const channel = interaction.options.getChannel("channel", true);
      if (action === "exclude") store.addExcludedChannel(interaction.guild.id, channel.id);
      else store.removeExcludedChannel(interaction.guild.id, channel.id);
      return interaction.editReply(
        action === "exclude" ? `<#${channel.id}> will no longer be logged.` : `<#${channel.id}> will be logged again.`
      );
    }
    const settings = store.getLogSettings(interaction.guild.id);
    const excluded = store.listExcludedChannels(interaction.guild.id);
    return interaction.editReply([
      `Status: **${settings?.enabled ? "On" : "Off"}**`,
      `Log channel: ${settings ? `<#${settings.channel_id}>` : "Not configured"}`,
      `Retention: **3 days**`,
      `Excluded: ${excluded.length ? excluded.map((id) => `<#${id}>`).join(", ") : "None"}`,
    ].join("\n"));
  } catch (error) {
    console.error("Harmony message-log command failed:", error);
    return interaction.editReply("I couldn’t update the message-log settings. Check the Railway logs.");
  }
}

module.exports = { data, execute };
