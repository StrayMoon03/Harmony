const {
  ActionRowBuilder,
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require("discord.js");

const data = new ContextMenuCommandBuilder()
  .setName("Harmony: Moderate Message")
  .setType(ApplicationCommandType.Message)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);

async function execute(interaction) {
  const message = interaction.targetMessage;
  if (!message || message.author.bot) {
    return interaction.reply({
      content: "Choose a message written by a member.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("guard_manual:" + message.channelId + ":" + message.id)
    .setPlaceholder("Choose the private removal explanation")
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel("Paid content").setValue("paid").setEmoji("💜"),
      new StringSelectMenuOptionBuilder().setLabel("Self-promotion").setValue("promotion"),
      new StringSelectMenuOptionBuilder().setLabel("Inappropriate content").setValue("inappropriate"),
      new StringSelectMenuOptionBuilder().setLabel("Harmful or ridiculing AI").setValue("harmful_ai"),
      new StringSelectMenuOptionBuilder().setLabel("Spam or scam").setValue("spam"),
      new StringSelectMenuOptionBuilder().setLabel("Other rule violation").setValue("other")
    );

  return interaction.reply({
    content: "Choose why Harmony should remove this message. The member will be contacted **privately**, never corrected in public.",
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = { data, execute };
