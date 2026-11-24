"use strict";
const { PermissionFlagsBits: P, ChannelType } = require("discord.js");
const REQUIRED = [
  { name: "View Channel", flag: P.ViewChannel },
  { name: "Read Message History", flag: P.ReadMessageHistory },
  { name: "Send Messages", flag: P.SendMessages },
  { name: "Attach Files", flag: P.AttachFiles },
  { name: "Pin Messages", flag: P.PinMessages },
];
const LEGACY_PERMISSION_ERROR =
  "Harmony needs View Channel, Read Message History, Send Messages, Attach Files and Pin Messages in this room";
class CountdownPermissionError extends Error {
  constructor(message, code, diagnostics = null, cause) {
    super(message, { cause });
    this.name = "CountdownPermissionError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}
function denialSource(channel, member, flag) {
  const o = channel.overwritesFor(member);
  if (o.member?.deny.has(flag))
    return "Denied by Harmony's member-specific room override";
  const denies = o.roles.filter((r) => r.deny.has(flag));
  if (denies.length)
    return (
      "Denied by room role override: " +
      denies
        .map((r) => member.guild.roles.cache.get(r.id)?.name || "unknown role")
        .slice(0, 3)
        .join(", ")
    );
  if (o.everyone?.deny.has(flag))
    return "Denied by the room's @everyone override";
  return "Not granted by Harmony's server roles or room overrides";
}
async function inspect(client, g, c) {
  if (typeof P.PinMessages !== "bigint" || P.PinMessages !== 1n << 51n)
    throw new CountdownPermissionError(
      "This Discord.js runtime cannot check Pin Messages correctly. The installed library must support the current Pin Messages flag.",
      "COUNTDOWN_PERMISSION_COMPATIBILITY",
    );
  let step = "resolve Harmony's server membership";
  try {
    const guild = client.guilds.cache.get(g) || (await client.guilds.fetch(g));
    if (guild?.id !== g) throw Error("Server identity mismatch");
    // GET-only requests. Do not resolve ClientUser as a Role/GuildMember from cache.
    step = "reload Harmony's member, server roles and concert-room overrides";
    const [member, roles, channel] = await Promise.all([
      guild.members.fetchMe({ force: true }),
      guild.roles.fetch(),
      guild.channels.fetch(c, { force: true }),
    ]);
    if (member?.id !== client.user.id || member.guild?.id !== g)
      throw Error("Bot membership identity mismatch");
    if (channel?.guildId !== g || channel.type !== ChannelType.GuildText)
      throw new CountdownPermissionError(
        "Choose an existing concert text room in this server.",
        "COUNTDOWN_INVALID_ROOM",
      );
    // RoleManager.fetch() refreshes the guild cache used by Discord.js's own permission algorithm.
    if (
      !roles.has(guild.id) ||
      member.roles.cache.some((role) => !roles.has(role.id))
    )
      throw Error("The refreshed role list is incomplete");
    const effective = channel.permissionsFor(member);
    if (!effective)
      throw Error(
        "Discord.js could not calculate Harmony's channel permissions",
      );
    const permissions = REQUIRED.map(({ name, flag }) => {
      const allowed = effective.has(flag);
      return {
        name,
        allowed,
        source: allowed
          ? "Allowed after role inheritance and room overrides"
          : denialSource(channel, member, flag),
      };
    });
    const diagnostics = {
      checkedAt: new Date().toISOString(),
      guildId: g,
      channelId: c,
      channelName: channel.name || "concert room",
      botMemberId: member.id,
      permissions,
      missing: permissions.filter((p) => !p.allowed).map((p) => p.name),
    };
    return { channel, member, diagnostics };
  } catch (e) {
    if (e instanceof CountdownPermissionError) throw e;
    const code = Number(e.code);
    const suffix = Number.isFinite(code) ? ` (Discord ${code})` : "";
    const result = new CountdownPermissionError(
      `Could not ${step}${suffix}. Room access could not be verified; saved countdown details were kept.`,
      "COUNTDOWN_PERMISSION_UNAVAILABLE",
      null,
      e,
    );
    result.status = e.status;
    result.retry_after = e.retry_after;
    result.retryAfter = e.retryAfter;
    throw result;
  }
}
function assertAllowed(snapshot) {
  if (snapshot.diagnostics.missing.length)
    throw new CountdownPermissionError(
      "Missing effective room permission" +
        (snapshot.diagnostics.missing.length === 1 ? ": " : "s: ") +
        snapshot.diagnostics.missing.join(", ") +
        ". Check room access for the specific override details.",
      "COUNTDOWN_MISSING_PERMISSIONS",
      snapshot.diagnostics,
    );
  return snapshot;
}
function isPermissionFailure(error) {
  return (
    error instanceof CountdownPermissionError ||
    [50001, 50013].includes(Number(error.code)) ||
    Number(error.status) === 403
  );
}
function retryKind(error) {
  if (
    Number(error.status) === 429 ||
    Number(error.code) === 429 ||
    (Number.isFinite(Number(error.retry_after)) &&
      Number(error.retry_after) > 0) ||
    (Number.isFinite(Number(error.retryAfter)) && Number(error.retryAfter) > 0)
  )
    return "rate_limit";
  return isPermissionFailure(error) ? "permission" : "failure";
}
function canRetryManually(row) {
  const kind =
    row.retry_kind ||
    (row.last_error === LEGACY_PERMISSION_ERROR ? "permission" : null);
  return kind === "permission" || kind === "failure";
}
async function operationError(
  error,
  { client, guildId, channelId, stage, messageSaved },
) {
  if (error instanceof CountdownPermissionError) return error;
  const denied = isPermissionFailure(error);
  if (!denied && stage !== "pin the countdown") return error;
  let diagnostics = null;
  if (denied) {
    try {
      diagnostics = (await inspect(client, guildId, channelId)).diagnostics;
    } catch {
      /* Keep the original failing operation if the read-only recheck also fails. */
    }
  }
  let message = messageSaved ? "Countdown message saved; " : "";
  message += `Discord could not ${stage}`;
  const code = Number(error.code);
  if (Number.isFinite(code)) message += ` (${code})`;
  if (diagnostics?.missing.length)
    message +=
      ". Effective permissions now missing: " + diagnostics.missing.join(", ");
  else if (denied && diagnostics)
    message +=
      ". A fresh check reports all five required permissions allowed; Discord still refused this operation";
  else if (denied)
    message += ". The follow-up permission check could not complete";
  else message += ": " + String(error.message).slice(0, 120);
  message += messageSaved
    ? ". Retry will reuse the saved message."
    : ". Saved countdown details were kept; retry is safe.";
  const result = new Error(message, { cause: error });
  result.code = error.code;
  result.status = error.status;
  result.retry_after = error.retry_after;
  result.retryAfter = error.retryAfter;
  result.diagnostics = diagnostics;
  return result;
}
function description(d) {
  return [
    `Fresh room access check for #${d.channelName}`,
    ...d.permissions.map(
      (p) =>
        `${p.allowed ? "✓" : "✕"} ${p.name}${p.allowed ? "" : " — " + p.source}`,
    ),
    "",
    d.missing.length
      ? "Only the permissions marked ✕ are missing."
      : "All five required permissions are effective.",
    "Checked Harmony's own member, current server roles and this room's current overrides. No permissions were changed.",
  ].join("\n");
}
module.exports = {
  REQUIRED,
  LEGACY_PERMISSION_ERROR,
  CountdownPermissionError,
  inspect,
  assertAllowed,
  isPermissionFailure,
  retryKind,
  canRetryManually,
  operationError,
  description,
};
