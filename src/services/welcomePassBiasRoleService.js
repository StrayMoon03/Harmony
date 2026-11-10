const birthdayStore = require("../stores/birthdayStore");
const welcomePassStore = require("../stores/welcomePassStore");
const { normalizeBiases } = require("./memberBiases");

function roleCacheHas(roles, id) {
  return Boolean(roles?.cache?.has?.(id));
}

function roleRowsForMember(guildId, profile) {
  const mappings = welcomePassStore.listWelcomePassBiasRoles(guildId);
  let selected = [];
  try {
    selected = normalizeBiases(profile?.biases_json || profile?.bias, { allowEmpty: true });
  } catch {
    return { mappings, selected: [], invalid: true };
  }
  return { mappings, selected, invalid: false };
}

async function resolveRole(guild, roleId) {
  return guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
}

async function syncMemberBiasRoles(member, profile = null) {
  const guild = member?.guild;
  if (!guild || !member?.id) return { status: "unavailable", added: 0, removed: 0, issues: ["member_unavailable"] };
  const saved = profile || birthdayStore.getBirthdayProfile(guild.id, member.id);
  const { mappings, selected, invalid } = roleRowsForMember(guild.id, saved);
  const wanted = new Set(selected);
  const issues = [];
  if (invalid) issues.push("invalid_saved_bias");
  for (const bias of selected.filter((value) => value !== "Still deciding")) {
    if (!mappings.some((mapping) => mapping.bias === bias)) issues.push(`role_not_configured:${bias}`);
  }
  let added = 0;
  let removed = 0;
  for (const mapping of mappings) {
    const shouldHave = wanted.has(mapping.bias);
    const currentlyHas = roleCacheHas(member.roles, mapping.role_id);
    if (shouldHave === currentlyHas) continue;
    const role = await resolveRole(guild, mapping.role_id);
    if (!role || role.id === guild.id || role.editable === false) {
      issues.push(shouldHave ? `role_unavailable:${mapping.bias}` : `role_unmanageable:${mapping.bias}`);
      continue;
    }
    try {
      if (shouldHave) {
        await member.roles.add(role, "Harmony Welcome Pass bias role synchronization");
        added += 1;
      } else {
        await member.roles.remove(role, "Harmony Welcome Pass bias role synchronization");
        removed += 1;
      }
    } catch {
      issues.push(`${shouldHave ? "role_add_failed" : "role_remove_failed"}:${mapping.bias}`);
    }
  }
  return { status: issues.length ? "partial" : "synced", added, removed, issues };
}

async function reconcileGuildBiasRoles(client, guildId) {
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return { status: "guild_unavailable", processed: 0, added: 0, removed: 0, issues: 1 };
  const profiles = birthdayStore.listMemberBiasProfiles(guildId);
  const summary = { status: "complete", processed: 0, added: 0, removed: 0, issues: 0 };
  for (const profile of profiles) {
    const member = guild.members.cache.get(profile.user_id) || await guild.members.fetch(profile.user_id).catch(() => null);
    if (!member) {
      summary.issues += 1;
      continue;
    }
    const result = await syncMemberBiasRoles(member, profile);
    summary.processed += 1;
    summary.added += result.added;
    summary.removed += result.removed;
    summary.issues += result.issues.length;
  }
  if (summary.issues) summary.status = "partial";
  return summary;
}

module.exports = { syncMemberBiasRoles, reconcileGuildBiasRoles };
