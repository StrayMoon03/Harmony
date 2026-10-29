const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { runStatusCheck, resolveAdminCapabilities, STATUS, SOCIAL } = require("../services/operationsStatusService");
const { isServiceRefreshAvailable } = require("../services/sessionRefreshConfig");

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

function statusView(status) {
  return STATUS_PRESENTATION[status] || STATUS_PRESENTATION[STATUS.unknown];
}

function isSocialRow(row) {
  return /^social-(instagram|threads|facebook|youtube)$/.test(row?.id || "");
}

function hasCookieRefreshEvidence(row) {
  return isSocialRow(row) && row.status === STATUS.attention &&
    /(?:cookies need to be refreshed|session refresh required)/i.test(row.action || "");
}

function statusAction(row, capabilities = {}) {
  if (hasCookieRefreshEvidence(row)) {
    const platform = row.name;
    if (!capabilities.canManageCredentials) {
      return `${platform} cookies need to be refreshed. Ask the owner or a Credential Manager.`;
    }
    const service = row.id.slice("social-".length);
    return isServiceRefreshAvailable(service)
      ? `Click **Refresh ${platform} Cookies** below to open the secure refresh page.`
      : `${platform} cookies need to be refreshed, but secure cookie refresh is not fully set up. Ask the owner to complete setup.`;
  }
  return row.action || "No action available.";
}

function adminPresentationRows(report) {
  const sourceRows = report.rows || [];
  const rows = [];
  const discord = sourceRows.find((row) => row.id === "discord");
  if (discord) rows.push({ ...discord, name: "Harmony / Discord" });

  const socialRows = sourceRows.filter(isSocialRow);
  const socialIssues = socialRows.filter((row) => row.status === STATUS.attention || row.status === STATUS.owner);
  const quietSocialRows = socialRows.filter((row) => row.status !== STATUS.attention && row.status !== STATUS.owner);
  if (quietSocialRows.length) {
    const healthy = quietSocialRows.filter((row) => row.status === STATUS.healthy);
    const unverified = quietSocialRows.filter((row) => row.status !== STATUS.healthy);
    const summaryStatus = unverified.length ? STATUS.unknown : STATUS.healthy;
    const explanation = unverified.length
      ? `No explicit login failure is currently recorded for ${unverified.map((row) => row.name).join(", ")}. Harmony does not actively test external logins during a Status check.`
      : `Recent authenticated media retrieval succeeded for ${healthy.map((row) => row.name).join(", ")}.`;
    rows.push({
      id: "social-summary",
      name: "Social Media Links",
      status: summaryStatus,
      explanation,
      action: unverified.length ? "No cookie change is indicated unless a media request reports a login problem." : "No action needed.",
    });
  }
  rows.push(...socialIssues);

  for (const id of ["discovery", "guard"]) {
    const row = sourceRows.find((candidate) => candidate.id === id);
    if (row && row.status !== STATUS.healthy) rows.push(row);
  }
  return rows;
}

function makeStatusPayload(report, capabilities = {}) {
  const rows = adminPresentationRows(report);
  const hasAttention = rows.some((row) => row.status === STATUS.attention || row.status === STATUS.owner);
  const embed = new EmbedBuilder()
    .setTitle("Harmony Status / Health")
    .setColor(hasAttention ? 0xfee75c : 0x5865f2)
    .setDescription(`Admin overview · checked ${new Date(report.checkedAt).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" })}. External platform login validity is not actively probed.`)
    .addFields(rows.map((row) => {
      const view = statusView(row.status);
      return {
        name: `${view.icon} ${row.name} — ${view.label}`,
        value: `${row.explanation}\n**Next:** ${statusAction(row, capabilities)}`.slice(0, 1024),
        inline: false,
      };
    }));

  const refreshButtons = capabilities.canManageCredentials
    ? (report.rows || []).filter((row) => hasCookieRefreshEvidence(row) &&
      isServiceRefreshAvailable(row.id.slice("social-".length)))
      .slice(0, 4).map((row) => new ButtonBuilder()
        .setCustomId(`harmony-session-refresh:${row.id.slice("social-".length)}`)
        .setLabel(`Refresh ${row.name} Cookies`)
        .setStyle(ButtonStyle.Success))
    : [];
  const statusButtons = [
    new ButtonBuilder().setCustomId("harmony-status:refresh").setLabel("Refresh Status").setStyle(ButtonStyle.Primary),
    ...(capabilities.canViewOwnerDiagnostics ? [new ButtonBuilder()
      .setCustomId("harmony-status:diagnostics")
      .setLabel("Owner Diagnostics")
      .setStyle(ButtonStyle.Secondary)] : []),
  ];
  const components = [];
  if (refreshButtons.length) components.push(new ActionRowBuilder().addComponents(...refreshButtons));
  components.push(new ActionRowBuilder().addComponents(...statusButtons));
  return {
    embeds: [embed],
    components,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}

function makeOwnerDiagnosticsPayload(report) {
  const rows = report.rows || [];
  const detailFields = rows.map((row) => {
    const view = statusView(row.status);
    const lastSignal = row.lastChecked
      ? new Date(row.lastChecked).toISOString()
      : "No signal/check recorded.";
    return {
      name: `${view.icon} ${row.name} — ${view.label}`.slice(0, 256),
      value: `**Details:** ${row.explanation}\n**Suggested action:** ${row.action || "No action available."}\n**Last signal/check:** ${lastSignal}`.slice(0, 1024),
      inline: false,
    };
  });
  const refreshReadiness = Object.entries(SOCIAL).map(([service, name]) =>
    `${name}: ${isServiceRefreshAvailable(service) ? "Secure cookie refresh available" : "Secure cookie refresh not fully configured"}`
  ).join("\n");
  const embed = new EmbedBuilder()
    .setTitle("Harmony Owner Diagnostics")
    .setColor(0x5865f2)
    .setDescription(`Detailed local system signals · checked ${new Date(report.checkedAt).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" })}. Social platforms are not actively logged into by this check.`)
    .addFields(detailFields)
    .addFields({ name: "Secure Cookie Refresh Readiness", value: refreshReadiness, inline: false })
    .setFooter({ text: "No cookie contents, credential values, OAuth secrets, or Railway tokens are shown." });
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("harmony-status:back").setLabel("Back to Status").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("harmony-status:diagnostics-refresh").setLabel("Refresh Diagnostics").setStyle(ButtonStyle.Primary),
    )],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}

async function capabilitiesFor(interaction) {
  return resolveAdminCapabilities({ guild: interaction.guild, member: interaction.member, userId: interaction.user?.id });
}

async function respondWithStatus(interaction, { update = false } = {}) {
  const capabilities = await capabilitiesFor(interaction);
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

async function respondWithOwnerDiagnostics(interaction, { update = false } = {}) {
  const capabilities = await capabilitiesFor(interaction);
  if (!capabilities.canViewOwnerDiagnostics) {
    const payload = { content: "Owner diagnostics are available only to the server owner.", flags: MessageFlags.Ephemeral };
    if (update && interaction.message) return interaction.update({ content: payload.content, embeds: [], components: [] });
    if (interaction.deferred || interaction.replied) return interaction.editReply({ content: payload.content, components: [] });
    return interaction.reply(payload);
  }
  const report = await runStatusCheck({ client: interaction.client, guild: interaction.guild, actorId: interaction.user.id });
  const payload = makeOwnerDiagnosticsPayload(report);
  if (update && interaction.message) return interaction.update({ embeds: payload.embeds, components: payload.components, allowedMentions: payload.allowedMentions });
  if (interaction.deferred || interaction.replied) return interaction.editReply({ embeds: payload.embeds, components: payload.components, allowedMentions: payload.allowedMentions });
  return interaction.reply(payload);
}

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return respondWithStatus(interaction);
}

async function handleStatusInteraction(interaction) {
  const actions = new Set([
    "harmony-status:open",
    "harmony-status:refresh",
    "harmony-status:diagnostics",
    "harmony-status:diagnostics-refresh",
    "harmony-status:back",
  ]);
  if (!interaction.isButton?.() || !actions.has(interaction.customId)) return false;
  if (interaction.customId === "harmony-status:diagnostics" || interaction.customId === "harmony-status:diagnostics-refresh") {
    await respondWithOwnerDiagnostics(interaction, { update: true });
  } else {
    await respondWithStatus(interaction, { update: interaction.customId !== "harmony-status:open" });
  }
  return true;
}

module.exports = {
  data,
  execute,
  makeStatusPayload,
  makeOwnerDiagnosticsPayload,
  adminPresentationRows,
  hasCookieRefreshEvidence,
  statusAction,
  respondWithStatus,
  respondWithOwnerDiagnostics,
  handleStatusInteraction,
};
