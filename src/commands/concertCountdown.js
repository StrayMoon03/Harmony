"use strict";
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} = require("discord.js");
const { isAdminRoomAuthorized } = require("../services/adminAuthorization");
const room = require("../stores/adminRoomStore");
const store = require("../stores/concertCountdownStore");
const calendar = require("../stores/eventSchedulerStore");
const service = require("../services/concertCountdownService");
const {
  localDate,
  validateConfig,
} = require("../services/concertCountdownModel");
const data = new SlashCommandBuilder()
  .setName("harmony-countdown")
  .setDescription("Manage concert countdowns privately")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
const channel = (o) =>
  o
    .setName("room")
    .setDescription("Existing concert room")
    .addChannelTypes(ChannelType.GuildText)
    .setRequired(true);
data.addSubcommand((s) =>
  s
    .setName("configure")
    .setDescription("Configure concert dates and venue")
    .addChannelOption(channel)
    .addStringOption((o) =>
      o
        .setName("city")
        .setDescription("City")
        .setRequired(true)
        .setMaxLength(80),
    )
    .addStringOption((o) =>
      o
        .setName("venue")
        .setDescription("Venue")
        .setRequired(true)
        .setMaxLength(120),
    )
    .addStringOption((o) =>
      o
        .setName("country")
        .setDescription("Country")
        .setRequired(true)
        .setMaxLength(80),
    )
    .addStringOption((o) =>
      o
        .setName("timezone")
        .setDescription("IANA venue timezone")
        .setRequired(true)
        .setMaxLength(80),
    )
    .addStringOption((o) =>
      o
        .setName("events")
        .setDescription("Approved concert event IDs, comma separated")
        .setRequired(true)
        .setMaxLength(150),
    ),
);
data.addSubcommand((s) =>
  s
    .setName("photo")
    .setDescription("Upload an authorized venue photograph")
    .addChannelOption(channel)
    .addAttachmentOption((o) =>
      o
        .setName("image")
        .setDescription("JPEG or PNG, max 4 MB")
        .setRequired(true),
    ),
);
for (const [name, description] of [
  ["preview", "Preview privately"],
  ["publish", "Publish or repair the countdown"],
  ["refresh", "Refresh the existing countdown"],
  ["enable", "Enable daily updates"],
  ["disable", "Disable daily updates"],
])
  data.addSubcommand((s) =>
    s.setName(name).setDescription(description).addChannelOption(channel),
  );
data.addSubcommand((s) =>
  s.setName("list").setDescription("List configured countdowns and status"),
);
data.addSubcommand((s) =>
  s
    .setName("events")
    .setDescription("List approved concert event IDs")
    .addStringOption((o) =>
      o.setName("month").setDescription("YYYY-MM").setRequired(true),
    ),
);
async function execute(i) {
  const panel = i.guildId && room.getPanel(i.guildId);
  if (
    !isAdminRoomAuthorized(i) ||
    !panel?.enabled ||
    panel.channel_id !== i.channelId
  )
    return i.reply({
      content: "Use this command in the active private Admin Room.",
      flags: MessageFlags.Ephemeral,
    });
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const action = i.options.getSubcommand(),
      g = i.guildId;
    if (action === "list") {
      const rows = store.list(g);
      return i.editReply({
        content:
          rows
            .map(
              (r) =>
                JSON.parse(r.config).city +
                " — " +
                (r.enabled ? "On" : "Off") +
                " — " +
                (r.last_error || r.last_success || "Not published"),
            )
            .join("\n")
            .slice(0, 1900) || "No countdowns configured.",
        allowedMentions: { parse: [] },
      });
    }
    if (action === "events") {
      const month = i.options.getString("month");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Error("Enter YYYY-MM");
      const start = new Date(month + "-01T00:00:00Z");
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      const rows = calendar
        .listCalendarEvents(
          g,
          "stray_kids",
          start.toISOString(),
          end.toISOString(),
        )
        .filter((e) => e.category === "concert");
      return i.editReply({
        content:
          rows
            .map((e) => e.id + " — " + e.event_date + " — " + e.title)
            .join("\n")
            .slice(0, 1900) || "No approved concerts in this month.",
        allowedMentions: { parse: [] },
      });
    }
    const c = i.options.getChannel("room", true).id;
    if (action === "configure") {
      const timezone = i.options.getString("timezone", true);
      localDate(new Date(), timezone);
      const raw = i.options
        .getString("events", true)
        .split(",")
        .map((s) => s.trim());
      if (
        raw.length > 12 ||
        raw.some((s) => !/^\d+$/.test(s) || !Number.isSafeInteger(Number(s)))
      )
        throw Error("Enter up to 12 valid event IDs");
      const eventIds = [...new Set(raw.map(Number))];
      for (const id of eventIds) {
        const e = calendar.getEvent(g, id);
        if (
          !e ||
          e.cancelled_at ||
          e.calendar_type !== "stray_kids" ||
          e.category !== "concert"
        )
          throw Error("Event " + id + " is not an active approved concert");
      }
      const config = {
        guildId: g,
        city: i.options.getString("city", true),
        venue: i.options.getString("venue", true),
        country: i.options.getString("country", true),
        timezone,
        eventIds,
      };
      validateConfig(
        config,
        eventIds.map((id) => calendar.getEvent(g, id)),
      );
      store.save(g, c, config);
      return i.editReply("Saved. Use preview before publishing.");
    }
    const row = store.get(g, c);
    if (!row) throw Error("Configure this room first");
    if (action === "photo") {
      const photo =
        await require("../services/concertCountdownPhoto").downloadPhoto(
          i.options.getAttachment("image", true),
        );
      store.photo(g, c, photo.bytes, photo.type);
      return i.editReply("Photo saved. Preview before publishing.");
    }
    if (action === "preview") return i.editReply(await service.preview(row));
    if (action === "enable") {
      if (!row.message_id) throw Error("Publish explicitly before enabling");
      store.update(g, c, { enabled: 1 });
      return i.editReply("Daily updates enabled.");
    }
    if (action === "disable") {
      store.update(g, c, { enabled: 0 });
      return i.editReply("Daily updates disabled.");
    }
    const result = await service.refresh(i.client, g, c, {
      publish: action === "publish",
      force: true,
    });
    return i.editReply(
      result.deferred
        ? "A retry delay is active. Check the manager status."
        : "Countdown updated and pinned. Enable daily updates separately.",
    );
  } catch (e) {
    return i.editReply({
      content: "Countdown: " + String(e.message).slice(0, 350),
      allowedMentions: { parse: [] },
    });
  }
}
module.exports = { data, execute };
