const {
  SlashCommandBuilder,
  MessageFlags,
} = require("discord.js");
const {
  normalizeWelcomePassCode,
  isValidWelcomePassCode,
  linkWelcomePassCode,
} = require("../stores/welcomePassStore");
const {
  assignApprovedWelcomePass,
} = require("../services/welcomePassService");

const data = new SlashCommandBuilder()
  .setName("harmony-pass")
  .setDescription("Link your completed Welcome Pass to your Discord account")
  .addStringOption((option) =>
    option
      .setName("code")
      .setDescription("Your confirmation code, such as YS-AB12CD34")
      .setRequired(true)
      .setMaxLength(20)
  );

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.guild) {
    await interaction.editReply(
      "Please use this command inside the Youtiful Stay server."
    );
    return;
  }

  const code = normalizeWelcomePassCode(
    interaction.options.getString("code", true)
  );
  if (!isValidWelcomePassCode(code)) {
    await interaction.editReply(
      "That code doesn’t look right. Please enter the full code shown after your Welcome Pass, such as `YS-AB12CD34`."
    );
    return;
  }

  const linked = linkWelcomePassCode({
    code,
    guildId: interaction.guild.id,
    userId: interaction.user.id,
  });

  if (!linked.ok) {
    const message =
      linked.reason === "claimed"
        ? "That confirmation code is already connected to another Discord account. Please ask an admin for help."
        : "Your STAY role was already granted from a different confirmation code. Please ask an admin if this needs changing.";
    await interaction.editReply(message);
    return;
  }

  try {
    const result = await assignApprovedWelcomePass(
      interaction.client,
      code
    );

    if (result.status === "assigned" || result.status === "already_assigned") {
      await interaction.editReply(
        "You’re all set! Your Welcome Pass is approved and your **STAY** role has been added. 💜"
      );
      return;
    }

    if (result.status === "waiting_for_setup") {
      await interaction.editReply(
        "Your code is linked. An admin still needs to finish Harmony’s STAY-role setup."
      );
      return;
    }

    await interaction.editReply(
      "Your Welcome Pass code is linked to your Discord account. Harmony will add your **STAY** role as soon as an admin approves it. 💜"
    );
  } catch (error) {
    console.error("Welcome Pass link command error:", error);
    await interaction.editReply(
      "Your code was saved, but Harmony couldn’t add the role yet. An admin can check the Railway logs; Harmony will retry it."
    );
  }
}

module.exports = { data, execute };
