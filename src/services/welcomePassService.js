const {
  getWelcomePassAssignment,
  getWelcomePassSettings,
  listWelcomePassSettings,
  linkWelcomePassCode,
  listPendingWelcomePassApprovals,
  markWelcomePassAssigned,
  renderWelcomePassReleaseMessage,
  saveWelcomePassSettings,
  updateWelcomePassSetting: updateStoredWelcomePassSetting,
} = require("../stores/welcomePassStore");
const { ChannelType, PermissionFlagsBits } = require("discord.js");
const {
  attachWelcomePassBirthdayProfile,
} = require("../stores/birthdayStore");

async function fetchTextChannel(guild, channelId) {
  if (!channelId) return null;
  const channel =
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));
  return channel && channel.isTextBased() ? channel : null;
}


function normalizeDiscordUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLocaleLowerCase();
}

function validateWelcomePassRole(guild, role) {
  if (!role || role.managed || role.id === guild.id) {
    throw new Error("Please choose a normal server role, not an integration role or @everyone.");
  }
  const harmony = guild.members.me;
  if (!harmony.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("Harmony needs the **Manage Roles** permission before it can grant STAY.");
  }
  if (harmony.roles.highest.comparePositionTo(role) <= 0) {
    throw new Error(`Move Harmony’s bot role above **${role.name}** in Server Settings → Roles, then try again.`);
  }
  return role;
}

function resolveWelcomePassEntryChannelId(welcomePassSettings, greetingSettings) {
  return welcomePassSettings?.entry_channel_id || greetingSettings?.channel_id || null;
}

async function configureWelcomePass(client, settings) {
  const guild = client.guilds.cache.get(settings.guildId) ||
    await client.guilds.fetch(settings.guildId).catch(() => null);
  if (!guild) throw new Error("Harmony could not find this server.");
  const role = guild.roles.cache.get(settings.roleId) || await guild.roles.fetch(settings.roleId).catch(() => null);
  validateWelcomePassRole(guild, role);
  const channels = [[settings.channelId, "private alert"], [settings.releaseChannelId, "member"]];
  if (settings.entryChannelId) channels.push([settings.entryChannelId, "Welcome Pass entry"]);
  for (const [id, label] of channels) {
    const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
    if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) {
      throw new Error(`Choose a server text channel for the ${label} channel.`);
    }
  }
  saveWelcomePassSettings(settings);
  await assignAllApprovedWelcomePasses(client);
}

async function updateWelcomePassSetting(client, guildId, field, value) {
  const property = { roleId: "role_id", channelId: "channel_id", releaseChannelId: "release_channel_id", entryChannelId: "entry_channel_id", releaseMessage: "release_message" }[field];
  if (!property) throw new Error("Invalid Welcome Pass setting.");
  const settings = getWelcomePassSettings(guildId);
  if (!settings) throw new Error("Complete Welcome Pass setup before changing individual settings.");
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) throw new Error("Harmony could not find this server.");
  if (field === "roleId") {
    const role = guild.roles.cache.get(value) || await guild.roles.fetch(value).catch(() => null);
    validateWelcomePassRole(guild, role);
  } else if (["channelId", "releaseChannelId", "entryChannelId"].includes(field)) {
    const channel = guild.channels.cache.get(value) || await guild.channels.fetch(value).catch(() => null);
    if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) {
      throw new Error("Choose a text channel in this server.");
    }
  }
  const changed = updateStoredWelcomePassSetting(guildId, field, value);
  if (!changed) throw new Error("Welcome Pass setup changed before this update could be saved.");
  await assignAllApprovedWelcomePasses(client);
  return getWelcomePassSettings(guildId);
}

async function notifyDiscordUsernameIssue(
  client,
  settings,
  code,
  discordUsername
) {
  const guild =
    client.guilds.cache.get(settings.guild_id) ||
    (await client.guilds.fetch(settings.guild_id).catch(() => null));
  if (!guild) return;

  const channel = await fetchTextChannel(guild, settings.channel_id);
  if (!channel) return;

  await channel.send({
    content: [
      "⚠️ **Welcome Pass needs a Discord match**",
      "",
      "Confirmation: `" + code + "`",
      "Discord @username entered: `" +
        discordUsername.replaceAll("`", "") +
        "`",
      "Harmony did not find one exact @username in this server.",
      "",
      "No role was granted. Ask the member to run `/harmony-pass` with their confirmation code.",
    ].join("\n"),
    allowedMentions: { parse: [] },
  }).catch((error) => {
    console.error("Could not send Welcome Pass match alert:", error);
  });
}

async function autoLinkWelcomePassByDiscordUsername(
  client,
  code,
  discordUsername
) {
  const current = getWelcomePassAssignment(code);
  if (current?.guild_id && current?.user_id) {
    return { status: "already_linked" };
  }

  const normalizedUsername = normalizeDiscordUsername(discordUsername);
  if (!normalizedUsername) return { status: "missing" };

  const settingsList = listWelcomePassSettings();
  if (settingsList.length !== 1) {
    return { status: "server_setup_ambiguous" };
  }

  const settings = settingsList[0];
  const guild =
    client.guilds.cache.get(settings.guild_id) ||
    (await client.guilds.fetch(settings.guild_id).catch(() => null));
  if (!guild) return { status: "guild_missing" };

  const members = await guild.members.fetch().catch(() => null);
  if (!members) return { status: "member_list_unavailable" };

  const matches = [...members.values()].filter(
    (member) =>
      !member.user.bot &&
      normalizeDiscordUsername(member.user.username) ===
        normalizedUsername
  );

  if (matches.length !== 1) {
    await notifyDiscordUsernameIssue(
      client,
      settings,
      code,
      String(discordUsername).slice(0, 100)
    );
    return {
      status: matches.length > 1 ? "ambiguous" : "not_found",
    };
  }

  const member = matches[0];
  const linked = linkWelcomePassCode({
    code,
    guildId: guild.id,
    userId: member.id,
  });
  if (!linked.ok) {
    return { status: "link_conflict", reason: linked.reason };
  }

  return {
    status: "linked",
    guildId: guild.id,
    userId: member.id,
  };
}

async function assignApprovedWelcomePass(client, code) {
  const assignment = getWelcomePassAssignment(code);
  if (!assignment) return { status: "approval_missing" };
  if (!assignment.guild_id || !assignment.user_id) {
    return { status: "waiting_for_link" };
  }

  // Welcome Pass birthday details arrive before the Discord account may be
  // linked. Attach them as soon as both guild and member are known.
  attachWelcomePassBirthdayProfile(code);

  if (assignment.assigned_at) return { status: "already_assigned" };

  const settings = getWelcomePassSettings(assignment.guild_id);
  if (!settings) return { status: "waiting_for_setup" };
  if (settings.grant_mode === "manual") {
    return { status: "manual_role_required" };
  }

  const guild =
    client.guilds.cache.get(assignment.guild_id) ||
    (await client.guilds.fetch(assignment.guild_id).catch(() => null));
  if (!guild) return { status: "guild_missing" };

  const member = await guild.members.fetch(assignment.user_id).catch(() => null);
  if (!member) return { status: "member_missing" };

  const role =
    guild.roles.cache.get(settings.role_id) ||
    (await guild.roles.fetch(settings.role_id).catch(() => null));
  if (!role) return { status: "role_missing" };

  if (!member.roles.cache.has(role.id)) {
    await member.roles.add(
      role,
      "Welcome Pass approved: " + assignment.code
    );
  }

  const releaseChannel = await fetchTextChannel(
    guild,
    settings.release_channel_id
  );
  if (settings.release_channel_id && !releaseChannel) {
    throw new Error("Configured Welcome Pass member channel is unavailable.");
  }

  if (releaseChannel) {
    const memberName =
      member.displayName ||
      member.user.globalName ||
      member.user.username;
    const releaseContent = renderWelcomePassReleaseMessage(
      settings.release_message,
      {
        memberMention: "<@" + member.id + ">",
        memberName,
        serverName: guild.name,
      }
    );
    await releaseChannel.send({
      content: releaseContent,
      allowedMentions: { users: [member.id] },
    });
  }

  markWelcomePassAssigned(assignment.code);

  const adminChannel = await fetchTextChannel(guild, settings.channel_id);
  if (adminChannel) {
    await adminChannel.send({
      content: [
        "✅ **Welcome Pass approved — STAY role granted**",
        "",
        "Member: <@" + member.id + ">",
        "Confirmation: `" + assignment.code + "`",
        "Approved by: " + assignment.approver_name,
      ].join("\n"),
      allowedMentions: { parse: [] },
    }).catch((error) => {
      console.error("Could not send Welcome Pass admin notice:", error);
    });
  }

  return { status: "assigned", guildId: guild.id, userId: member.id };
}


async function handleManualWelcomePassRoleAdded(
  oldMember,
  newMember
) {
  if (newMember.user.bot) return { status: "ignored" };

  const settings = getWelcomePassSettings(newMember.guild.id);
  if (!settings || settings.grant_mode !== "manual") {
    return { status: "ignored" };
  }

  const roleId = settings.role_id;
  const roleWasAdded =
    !oldMember.roles.cache.has(roleId) &&
    newMember.roles.cache.has(roleId);
  if (!roleWasAdded) return { status: "ignored" };

  const releaseChannel = await fetchTextChannel(
    newMember.guild,
    settings.release_channel_id
  );
  if (settings.release_channel_id && !releaseChannel) {
    throw new Error("Configured Welcome Pass member channel is unavailable.");
  }

  if (releaseChannel) {
    const memberName =
      newMember.displayName ||
      newMember.user.globalName ||
      newMember.user.username;
    const releaseContent = renderWelcomePassReleaseMessage(
      settings.release_message,
      {
        memberMention: "<@" + newMember.id + ">",
        memberName,
        serverName: newMember.guild.name,
      }
    );
    await releaseChannel.send({
      content: releaseContent,
      allowedMentions: { users: [newMember.id] },
    });
  }

  const adminChannel = await fetchTextChannel(
    newMember.guild,
    settings.channel_id
  );
  if (adminChannel) {
    await adminChannel.send({
      content: [
        "✅ **STAY role manually granted**",
        "",
        "Member: <@" + newMember.id + ">",
        "Harmony detected the role change and sent the member message.",
      ].join("\n"),
      allowedMentions: { parse: [] },
    }).catch((error) => {
      console.error("Could not send manual Welcome Pass admin notice:", error);
    });
  }

  return {
    status: "manual_release_sent",
    guildId: newMember.guild.id,
    userId: newMember.id,
  };
}

async function assignAllApprovedWelcomePasses(client) {
  const pending = listPendingWelcomePassApprovals();
  for (const item of pending) {
    try {
      await assignApprovedWelcomePass(client, item.code);
    } catch (error) {
      console.error(
        "Could not retry Welcome Pass " + item.code + ":",
        error
      );
    }
  }
}

module.exports = {
  autoLinkWelcomePassByDiscordUsername,
  validateWelcomePassRole,
  resolveWelcomePassEntryChannelId,
  configureWelcomePass,
  updateWelcomePassSetting,
  assignApprovedWelcomePass,
  handleManualWelcomePassRoleAdded,
  assignAllApprovedWelcomePasses,
};
