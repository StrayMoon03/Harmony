const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { runStatusCheck, getAdminCapabilities, STATUS } = require("../services/operationsStatusService");

const data = new SlashCommandBuilder()
  .setName("harmony-status")
  .setDescription("Check Harmony systems and services")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const STATUS_PRESENTATION = {
  [STATUS.healthy]: { icon: "🟢", label: "Healthy", color: 0x57f287 },
  [STATUS.attention]: { icon: "🟡", label: "Needs Attention", color: 0xfee75c },
  [STATUS.owner]: { icon: "🔴", label: "Owner/Developer Required", color: 0xed4245 },
  [STATUS.unknown]: { icon: "⚪", label: "Not Configured / Unable to Verify", color: 0x99aab5 },
};

function makeStatusPayload(report, capabilities) {
  const rows = report.rows || [];
  const hasAttention = rows.some((row) => row.status === STATUS.attention || row.status === STATUS.owner);
  const embed = new EmbedBuilder()
    .setTitle("Harmony Status / Health")
    .setColor(hasAttention ? 0xfee75c : 0x5865f2)
    .setDescription(`Fresh local checks · ${new Date(report.checkedAt).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" })}\nExternal platform login validity is not probed.`)
    .addFields(rows.map((row) => {
      const view = STATUS_PRESENTATION[row.status] || STATUS_PRESENTATION[STATUS.unknown];
      return {
        name: `${view.icon} ${row.name} — ${view.label}`,
        value: `${row.explanation}\n**Next:** ${statusAction(row, capabilities)}\n**Last signal/check:** ${row.lastChecked ? new Date(row.lastChecked).toISOString() : "Not recorded"}`.slice(0, 1024),
        inline: false,
      };
    }))
    .setFooter({ text: capabilities.canManageCredentials
      ? "Credential manager capability recognized; session refresh is not available yet."
      : "Session refresh is not available. Ask the owner or trusted Credential Manager if a session needs attention." });
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-status:refresh").setLabel("Refresh Status").setStyle(ButtonStyle.Primary)
    )],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}

function statusAction(row, capabilities) {
  if (/^social-(instagram|threads|facebook|youtube)$/.test(row.id || "") && row.status === STATUS.attention && /session refresh required/i.test(row.action || "")) {
    return capabilities.canManageCredentials
      ? "Secure session refresh is not available yet. No credentials were changed; ask the owner to provision the secure refresh service."
      : "Session refresh required — ask the owner or a Credential Manager. Secure refresh is not available yet.";
  }
  return row.action;
}

function capabilitiesFor(interaction) {
  return getAdminCapabilities({ guild: interaction.guild, member: interaction.member, userId: interaction.user?.id });
}

async function respondWithStatus(interaction, { update = false } = {}) {
  const capabilities = capabilitiesFor(interaction);
  if (!capabilities.canDiagnose) {
    const payload = { content: "Only authorized server admins can view Harmony Status.", flags: MessageFlags.Ephemeral };
    if (update) return interaction.update({ content: payload.content, embeds: [], components: [] });
    if (interaction.deferred || interaction.replied) return interaction.editReply({ content: payload.content, components: [] });
    return interaction.reply(payload);
  }
  const report = await runStatusCheck({ client: interaction.client, guild: interaction.guild, actorId: interaction.user.id });
  const payload = makeStatusPayload(report, capabilities);
  if (update && interaction.message) return interaction.update({ embeds: payload.embeds, components: payload.components, allowedMentions: payload.allowedMentions });
  if (interaction.deferred || interaction.replied) return interaction.editReply({ embeds: payload.embeds, components: payload.components, allowedMentions: payload.allowedMentions });
  return interaction.reply(payload);
}

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return respondWithStatus(interaction);
}

async function handleStatusInteraction(interaction) {
  if (!interaction.isButton?.() || !["harmony-status:open", "harmony-status:refresh"].includes(interaction.customId)) return false;
  await respondWithStatus(interaction, { update: interaction.customId === "harmony-status:refresh" });
  return true;
}

module.exports = {
  data,
  execute,
  makeStatusPayload,
  statusAction,
  handleStatusInteraction,
};
