"use strict";
const { randomBytes } = require("node:crypto");
const {
  ActionRowBuilder: Row,
  ButtonBuilder: Button,
  ButtonStyle: Style,
  ChannelSelectMenuBuilder: Channels,
  ChannelType,
  StringSelectMenuBuilder: Select,
  ModalBuilder: Modal,
  TextInputBuilder: Input,
  TextInputStyle: InputStyle,
  EmbedBuilder: Embed,
  MessageFlags,
  LabelBuilder: Label,
  FileUploadBuilder: Upload,
} = require("discord.js");
const store = require("../stores/concertCountdownStore");
const rooms = require("../stores/adminRoomStore");
const tour = require("./concertTourCalendar");
const { dateAt, matchesQuery } = require("./concertTourIdentity");
const eventDay = (e) =>
  dateAt(
    e,
    e.countdown_location?.timezone || e.event_timezone || e.timezone || "UTC",
  ) ||
  e.event_date ||
  "Date needs review";
const { isAdminRoomAuthorized } = require("./adminAuthorization");
const { validateConfig } = require("./concertCountdownModel");
const service = require("./concertCountdownService");
const { downloadPhoto } = require("./concertCountdownPhoto");
const roomAccess = require("./concertCountdownPermissions");
const sessions = new Map(),
  TTL = 20 * 60 * 1000;
const safe = { allowedMentions: { parse: [] } };
function id(s, a) {
  return `harmony-countdown:${s.token}:${a}`;
}
function button(s, a, label, style = Style.Secondary) {
  return new Button().setCustomId(id(s, a)).setLabel(label).setStyle(style);
}
function embed(title, description) {
  return new Embed()
    .setColor(0xff862f)
    .setTitle(title)
    .setDescription(description.slice(0, 4000));
}
function prune() {
  for (const [k, s] of sessions) if (s.expires < Date.now()) sessions.delete(k);
}
function createSession(i) {
  prune();
  if (sessions.size >= 500) sessions.delete(sessions.keys().next().value);
  const s = {
    token: randomBytes(8).toString("hex"),
    guild: i.guildId,
    user: i.user.id,
    channel: i.channelId,
    panel: rooms.getPanel(i.guildId)?.message_id,
    expires: Date.now() + TTL,
    listPage: 0,
    eventPage: 0,
    query: "",
    draft: {
      guildId: i.guildId,
      city: "",
      country: "",
      venue: "",
      timezone: "",
      eventIds: [],
    },
  };
  sessions.set(s.token, s);
  return s;
}
function home(s, notice = "") {
  const rows = store.list(s.guild),
    page = (s.listPage = Math.min(
      s.listPage,
      Math.max(0, Math.ceil(rows.length / 25) - 1),
    )),
    slice = rows.slice(page * 25, page * 25 + 25);
  const components = [];
  if (slice.length)
    components.push(
      new Row().addComponents(
        new Select()
          .setCustomId(id(s, "open"))
          .setPlaceholder("Choose a configured countdown")
          .addOptions(
            slice.map((r) => {
              const c = JSON.parse(r.config);
              return {
                label: c.city.slice(0, 100),
                description: (
                  c.venue +
                  " · " +
                  (r.enabled ? "Automatic updates on" : "Automatic updates off")
                ).slice(0, 100),
                value: r.channel_id,
              };
            }),
          ),
      ),
    );
  components.push(
    new Row().addComponents(
      button(s, "add", "Add countdown", Style.Primary),
      button(s, "tour-audit", "Tour dates & calendar audit"),
      button(s, "tour-upload", "Upload confirmed dates"),
      button(s, "list-prev", "Previous").setDisabled(page === 0),
      button(s, "list-next", "Next").setDisabled(
        (page + 1) * 25 >= rows.length,
      ),
    ),
  );
  return {
    ...safe,
    content: notice || null,
    embeds: [
      embed(
        "Concert Countdown Manager",
        `${rows.length} configured concert room${rows.length === 1 ? "" : "s"}. Choose one to edit, preview, publish or repair.\n\nNew countdowns remain private until you explicitly publish them. Dates come from the approved Stray Kids calendar. If a location is missing, use Tour dates & calendar audit to review confirmed missing dates.`,
      ),
    ],
    components,
    attachments: [],
  };
}
function detail(s, notice = "") {
  const row = store.get(s.guild, s.room),
    c = JSON.parse(row.config);
  const active = service.model(row);
  return {
    ...safe,
    content: notice || null,
    attachments: [],
    embeds: [
      embed(
        `${c.city} concert countdown`,
        `${c.venue} · ${c.country}\nRoom: <#${s.room}>\nTime zone: ${c.timezone}\n\n${active.panels.map((p) => `${p.date} — ${p.state === "upcoming" ? p.days + " days to go" : p.label}`).join("\n") || "No active dates. Select replacements from the approved calendar."}\n\n**Publication:** ${row.message_id ? "Published and managed" : "Private draft"}\n**Automatic updates:** ${row.enabled ? "On" : "Off"}\n**Photograph:** ${row.photo ? "Saved" : "No photograph — fallback shown"}\n**Last successful update:** ${row.last_success || "Never"}\n**Status:** ${row.last_error || "Ready"}${row.retry_at ? "\n**Retry after:** " + row.retry_at : ""}`,
      ),
    ],
    components: [
      new Row().addComponents(
        button(s, "edit", "Edit details & dates"),
        button(s, "photo", "Upload photograph"),
        button(s, "photos", "Reuse photograph"),
        button(s, "permissions", "Check room access"),
      ),
      new Row().addComponents(
        button(s, "preview", "Private preview", Style.Primary),
        button(s, "publish", "Publish / Repair", Style.Success),
        button(s, "refresh", "Refresh Now").setDisabled(
          !row.published_at && !row.message_id,
        ),
      ),
      new Row().addComponents(
        button(
          s,
          "toggle",
          row.enabled
            ? "Disable automatic updates"
            : "Enable automatic updates",
        ).setDisabled(!row.published_at && !row.message_id),
        button(s, "home", "All countdowns"),
      ),
    ],
  };
}
function draftPage(s, notice = "") {
  const c = s.draft,
    events = store.concerts(s.guild);
  return {
    ...safe,
    content: notice || null,
    attachments: [],
    embeds: [
      embed(
        "Configure concert countdown",
        `Room: <#${s.room}>\nCity: ${c.city || "Choose in Venue details"}\nCountry: ${c.country || "Choose in Venue details"}\nVenue: ${c.venue || "Choose a concert to fill its location"}\nTime zone: ${c.timezone || "Choose a concert to fill its time zone"}\n\n**Selected approved dates:**\n${
          c.eventIds
            .map((id) => {
              const e = events.find((e) => e.id === id);
              return e
                ? `${eventDay(e)} — ${e.title}`
                : "Unavailable date — select a replacement";
            })
            .join("\n") || "None yet"
        }\n\nNew rooms remain private until you publish. Saving changes to an existing published countdown applies them at its next automatic update. Preview before publishing manually.`,
      ),
    ],
    components: [
      new Row().addComponents(
        button(s, "events", "Select concert dates", Style.Primary),
        button(s, "details", "Venue details"),
        button(s, "save", "Save configuration", Style.Success),
        button(s, "home", "Cancel"),
      ),
    ],
  };
}
function datePage(s, location) {
  const events = location.events.filter((e) =>
      matchesQuery(e, location, s.query),
    ),
    page = (s.eventPage = Math.min(
      s.eventPage,
      Math.max(0, Math.ceil(events.length / 25) - 1),
    ));
  const slice = events.slice(page * 25, page * 25 + 25);
  s.offered = slice.map((e) => e.id);
  const components = [];
  if (slice.length)
    components.push(
      new Row().addComponents(
        new Select()
          .setCustomId(id(s, "select-events"))
          .setPlaceholder("Select dates on this page")
          .setMinValues(0)
          .setMaxValues(Math.min(12, slice.length))
          .addOptions(
            slice.map((e) => ({
              label: `${eventDay(e)} — ${e.title}`.slice(0, 100),
              description: (
                e.countdown_location?.venue ||
                e.event_location ||
                e.event_timezone ||
                "Approved concert"
              ).slice(0, 100),
              value: String(e.id),
              default: s.draft.eventIds.includes(e.id),
            })),
          ),
      ),
    );
  components.push(
    new Row().addComponents(
      button(s, "event-prev", "Previous").setDisabled(page === 0),
      button(s, "event-next", "Next").setDisabled(
        (page + 1) * 25 >= events.length,
      ),
      button(s, "search", "Search concerts"),
      button(s, "draft", "Done selecting", Style.Primary),
    ),
  );
  components.push(
    new Row().addComponents(
      button(
        s,
        "select-location-all",
        "Select all dates here",
        Style.Success,
      ).setDisabled(!events.length || events.length > 12),
      button(s, "other-locations", "Other locations"),
      button(s, "tour-review", "Review missing tour dates"),
    ),
  );
  return {
    ...safe,
    content: null,
    attachments: [],
    embeds: [
      embed(
        `${location.city} — ${location.venue}`,
        `${location.country} · Page ${page + 1} · ${events.length} matching concerts · ${s.draft.eventIds.length}/12 selected\nSelect dates for this location. Selections on other pages are retained.\n${s.query ? "Filter: " + s.query : "All approved concerts"}\n\n${location.audit.length ? "Announced dates: " + location.audit.map((a) => (a.existing ? eventDay({ ...a.existing, countdown_location: location }) : a.date) + (a.status === "missing" ? " (needs import)" : a.status === "blocked" ? " (needs review)" : a.status === "cancelled" ? " (canceled)" : a.status === "rescheduled" ? " (rescheduled)" : "")).join(", ") + "\n\n" : ""}${slice.length ? "Select one or more dates, then choose Done selecting." : "No selectable calendar dates yet. Use Review missing tour dates to add confirmed dates safely."}`,
      ),
    ],
    components,
  };
}
function eventPage(s) {
  const locations = tour.groups(s.guild, s.query);
  if (!s.locationKey && locations.length === 1)
    s.locationKey = locations[0].key;
  const location = locations.find((l) => l.key === s.locationKey);
  if (location) return datePage(s, location);
  const page = (s.locationPage = Math.min(
    s.locationPage || 0,
    Math.max(0, Math.ceil(locations.length / 25) - 1),
  ));
  const slice = locations.slice(page * 25, page * 25 + 25);
  s.offeredLocations = slice.map((l) => l.key);
  s.offered = [];
  const components = [];
  if (slice.length)
    components.push(
      new Row().addComponents(
        new Select()
          .setCustomId(id(s, "location"))
          .setPlaceholder("Choose a city and venue")
          .addOptions(
            slice.map((l) => ({
              label: `${l.city} — ${l.venue}`.slice(0, 100),
              description:
                `${l.country} · ${l.events.length} selectable · ${l.audit.filter((a) => a.status === "missing").length} missing from calendar`.slice(
                  0,
                  100,
                ),
              value: l.key,
            })),
          ),
      ),
    );
  components.push(
    new Row().addComponents(
      button(s, "location-prev", "Previous").setDisabled(page === 0),
      button(s, "location-next", "Next").setDisabled(
        (page + 1) * 25 >= locations.length,
      ),
      button(s, "search", "Search tour dates"),
      button(s, "draft", "Back to configuration"),
    ),
  );
  return {
    ...safe,
    content: null,
    attachments: [],
    embeds: [
      embed(
        "Choose concert location",
        `${locations.length} matching city/venue groups · Page ${page + 1}\n\nAll source-confirmed tour locations are shown, including dates not yet in your calendar. Choose a location to select its existing dates or review a safe import.\n\nSearch by city, country, venue or date.${s.query ? "\nFilter: " + s.query : ""}`,
      ),
    ],
    components,
  };
}
function tourReviewPage(s, manifest, page = 0, reuse = false) {
  const plan =
    reuse && s.importReview?.plan
      ? s.importReview.plan
      : tour.audit(s.guild, manifest);
  s.importReview = { manifest, fingerprint: plan.fingerprint, plan };
  s.importPage = Math.min(
    Math.max(0, page),
    Math.max(0, Math.ceil(plan.entries.length / 15) - 1),
  );
  const labels = {
    ready: "Ready",
    reuse: "Link existing",
    repair: "Fix calendar/category",
    missing: "Add missing date",
    blocked: "Needs review — skipped",
    cancelled: "Canceled — skipped",
    rescheduled: "Keep rescheduled date",
  };
  const lines = plan.entries
    .slice(s.importPage * 15, s.importPage * 15 + 15)
    .map((e) => `${e.location.city} · ${e.date} — **${labels[e.status]}**`);
  const sources = [...new Set(plan.entries.map((e) => e.sourceUrl))]
    .slice(0, 3)
    .map((url, n) => `[Official source ${n + 1}](${url})`)
    .join(" · ");
  return {
    ...safe,
    content: null,
    attachments: [],
    embeds: [
      embed(
        "Review confirmed tour dates",
        `${plan.entries.length} source-confirmed dates · checked ${manifest.verifiedAt}\n**Add:** ${plan.counts.missing} · **Reuse:** ${plan.counts.reuse + plan.counts.ready + plan.counts.rescheduled} · **Fix classification:** ${plan.counts.repair}\n**Needs review:** ${plan.counts.blocked} · **Canceled:** ${plan.counts.cancelled}\n\n${lines.join("\n")}\n\nPage ${s.importPage + 1}/${Math.ceil(plan.entries.length / 15)}\n\nApproval writes only the existing calendar and tour metadata. Existing IDs, timing, reminders and countdowns are preserved. Ambiguous or canceled entries are skipped. No public messages are sent.\n\n${sources}`,
      ),
    ],
    components: [
      new Row().addComponents(
        button(
          s,
          "tour-approve",
          "Approve calendar import",
          Style.Success,
        ).setDisabled(
          !plan.entries.some((e) =>
            ["missing", "reuse", "repair"].includes(e.status),
          ),
        ),
        button(s, "tour-prev", "Previous").setDisabled(s.importPage === 0),
        button(s, "tour-next", "Next").setDisabled(
          (s.importPage + 1) * 15 >= plan.entries.length,
        ),
        button(s, "tour-export", "Download full audit"),
      ),
      new Row().addComponents(
        button(
          s,
          "tour-return",
          s.room ? "Back to concert dates" : "Back to countdowns",
        ),
      ),
    ],
  };
}

function fieldsModal(s) {
  const modal = new Modal()
    .setCustomId(id(s, "details-save"))
    .setTitle("Concert venue details");
  for (const [key, label, max] of [
    ["city", "City", 80],
    ["country", "Country", 80],
    ["venue", "Venue name", 120],
    ["timezone", "Venue time zone (e.g. America/Chicago)", 80],
  ]) {
    const input = new Input()
      .setCustomId(key)
      .setLabel(label)
      .setStyle(InputStyle.Short)
      .setRequired(true)
      .setMaxLength(max);
    if (s.draft[key]) input.setValue(s.draft[key]);
    modal.addComponents(new Row().addComponents(input));
  }
  return modal;
}
async function open(i) {
  const panel = rooms.getPanel(i.guildId);
  if (
    !isAdminRoomAuthorized(i) ||
    !panel?.enabled ||
    panel.channel_id !== i.channelId ||
    panel.message_id !== i.message?.id
  ) {
    await i.reply({
      content:
        "Open Concert Countdowns from the current private Control Center.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  const s = createSession(i);
  await i.reply({ ...home(s), flags: MessageFlags.Ephemeral });
  return true;
}
function authorize(i, s) {
  const panel = rooms.getPanel(i.guildId);
  return (
    isAdminRoomAuthorized(i) &&
    panel?.enabled &&
    panel.channel_id === i.channelId &&
    s &&
    s.guild === i.guildId &&
    s.user === i.user.id &&
    s.channel === i.channelId &&
    s.panel === panel.message_id &&
    s.expires > Date.now()
  );
}
async function handle(i) {
  if (!i.customId?.startsWith("harmony-countdown:")) return false;
  const [, token, action] = i.customId.split(":"),
    s = sessions.get(token);
  if (!authorize(i, s)) {
    await i.reply({
      content:
        "This private manager expired or you are not authorized. Reopen Concert Countdowns from the current Control Center.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  s.expires = Date.now() + TTL;
  try {
    if (s.publicationInFlight && action !== "permissions")
      throw Error(
        "Countdown publication is already running. Wait for its result.",
      );
    if (action === "home" || action === "list-prev" || action === "list-next") {
      s.listPage = Math.max(
        0,
        s.listPage +
          (action === "list-next" ? 1 : action === "list-prev" ? -1 : 0),
      );
      await i.update(home(s));
    } else if (action === "add") {
      await i.update({
        ...safe,
        content: null,
        embeds: [
          embed(
            "Choose the concert room",
            "Select an existing concert text room. Harmony will manage one countdown in that room.",
          ),
        ],
        components: [
          new Row().addComponents(
            new Channels()
              .setCustomId(id(s, "room"))
              .setPlaceholder("Choose a concert room")
              .addChannelTypes(ChannelType.GuildText),
          ),
          new Row().addComponents(button(s, "home", "Cancel")),
        ],
      });
    } else if (action === "room") {
      await i.deferUpdate();
      const channel = await i.guild.channels.fetch(i.values[0]);
      if (
        channel?.guildId !== s.guild ||
        channel.type !== ChannelType.GuildText
      )
        throw Error("Choose a text room in this server");
      s.publishRevision = undefined;
      s.room = channel.id;
      const row = store.get(s.guild, s.room);
      s.revision = row?.revision ?? -1;
      s.draft = row
        ? JSON.parse(row.config)
        : {
            guildId: s.guild,
            city: "",
            country: "",
            venue: "",
            timezone: "",
            eventIds: [],
          };
      await i.editReply(row ? detail(s) : draftPage(s));
    } else if (action === "open") {
      s.publishRevision = undefined;
      s.room = i.values[0];
      if (!store.get(s.guild, s.room))
        throw Error("Countdown no longer exists");
      await i.update(detail(s));
    } else if (action === "edit") {
      const row = store.get(s.guild, s.room);
      s.draft = JSON.parse(row.config);
      const active = new Set(store.concerts(s.guild).map((e) => e.id));
      s.draft.eventIds = s.draft.eventIds.filter((id) => active.has(id));
      s.revision = row.revision;
      await i.update(draftPage(s));
    } else if (action === "draft") {
      await i.update(draftPage(s));
    } else if (action === "details") {
      await i.showModal(fieldsModal(s));
    } else if (action === "details-save") {
      for (const key of ["city", "country", "venue", "timezone"])
        s.draft[key] = i.fields.getTextInputValue(key).trim();
      require("./concertCountdownModel").localDate(
        new Date(),
        s.draft.timezone,
      );
      await i.update(draftPage(s));
    } else if (action === "search") {
      await i.showModal(
        new Modal()
          .setCustomId(id(s, "search-save"))
          .setTitle("Search approved concerts")
          .addComponents(
            new Row().addComponents(
              new Input()
                .setCustomId("query")
                .setLabel("City, country, venue or date (blank for all)")
                .setStyle(InputStyle.Short)
                .setRequired(false)
                .setMaxLength(100),
            ),
          ),
      );
    } else if (action === "search-save") {
      s.query = i.fields.getTextInputValue("query").trim();
      s.eventPage = 0;
      s.locationPage = 0;
      s.locationKey = null;
      await i.update(eventPage(s));
    } else if (["events", "event-prev", "event-next"].includes(action)) {
      s.eventPage = Math.max(
        0,
        s.eventPage +
          (action === "event-next" ? 1 : action === "event-prev" ? -1 : 0),
      );
      await i.update(eventPage(s));
    } else if (action === "location") {
      if (!s.offeredLocations?.includes(i.values[0]))
        throw Error("Choose a location from the current page");
      s.locationKey = i.values[0];
      s.eventPage = 0;
      await i.update(eventPage(s));
    } else if (
      action === "other-locations" ||
      action === "location-prev" ||
      action === "location-next"
    ) {
      s.locationKey = null;
      s.locationPage = Math.max(
        0,
        (s.locationPage || 0) +
          (action === "location-next"
            ? 1
            : action === "location-prev"
              ? -1
              : 0),
      );
      await i.update(eventPage(s));
    } else if (action === "select-location-all") {
      const location = tour
        .groups(s.guild)
        .find((l) => l.key === s.locationKey);
      if (!location) throw Error("Choose a concert location first");
      const selected = [
        ...new Set([
          ...s.draft.eventIds,
          ...location.events
            .filter((e) => matchesQuery(e, location, s.query))
            .map((e) => e.id),
        ]),
      ];
      if (selected.length > 12)
        throw Error("Select up to 12 concerts per countdown");
      s.draft.eventIds = selected;
      for (const key of ["city", "country", "venue", "timezone"])
        s.draft[key] ||= location[key] || "";
      await i.update(eventPage(s));
    } else if (action === "tour-audit" || action === "tour-review") {
      const manifest = tour.scopedManifest(
        action === "tour-review" ? s.locationKey : null,
      );
      if (!manifest.locations.length)
        throw Error(
          "For future dates, use Upload confirmed dates from the manager home",
        );
      await i.update(tourReviewPage(s, manifest));
    } else if (action === "tour-prev" || action === "tour-next") {
      if (!s.importReview) throw Error("Review the confirmed dates first");
      await i.update(
        tourReviewPage(
          s,
          s.importReview.manifest,
          (s.importPage || 0) + (action === "tour-next" ? 1 : -1),
          true,
        ),
      );
    } else if (action === "tour-approve") {
      if (!s.importReview)
        throw Error("Review the confirmed dates before approving");
      const review = s.importReview;
      delete s.importReview;
      await i.deferUpdate();
      const result = tour.importConfirmed(
        s.guild,
        review.manifest,
        review.fingerprint,
        i.user.id,
      );
      const message = `Calendar import complete: ${result.created} added, ${result.reused} reused, ${result.repaired} classifications fixed. ${result.blocked} need review; ${result.cancelled} canceled dates skipped. No public messages sent.`;
      const page = s.room ? eventPage(s) : home(s);
      await i.editReply({ ...page, content: message });
    } else if (action === "tour-export") {
      if (!s.importReview) throw Error("Open a tour audit first");
      const audit = s.importReview.plan;
      await i.reply({
        ...safe,
        content:
          "Private calendar audit. Includes existing classifications and source links.",
        files: [
          {
            attachment: Buffer.from(JSON.stringify(audit, null, 2)),
            name: "concert-tour-audit.json",
          },
        ],
        flags: MessageFlags.Ephemeral,
      });
    } else if (action === "tour-return") {
      delete s.importReview;
      await i.update(s.room ? eventPage(s) : home(s));
    } else if (action === "tour-upload") {
      await i.showModal(
        new Modal()
          .setCustomId(id(s, "tour-upload-save"))
          .setTitle("Upload confirmed tour dates")
          .addLabelComponents(
            new Label()
              .setLabel("Confirmed-tour JSON (up to 512 KB)")
              .setDescription(
                "Official source links are required. You review and approve changes next.",
              )
              .setFileUploadComponent(
                new Upload()
                  .setCustomId("tour-file")
                  .setMinValues(1)
                  .setMaxValues(1)
                  .setRequired(true),
              ),
          ),
      );
    } else if (action === "tour-upload-save") {
      await i.deferUpdate();
      const manifest = await tour.readManifestAttachment(
        i.fields.getUploadedFiles("tour-file", true).first(),
      );
      await i.editReply(tourReviewPage(s, manifest));
    } else if (action === "select-events") {
      const ids = i.values.map(Number);
      if (ids.some((id) => !s.offered.includes(id)))
        throw Error("Choose dates from the current page");
      const selected = [
        ...s.draft.eventIds.filter((id) => !s.offered.includes(id)),
        ...ids,
      ];
      if (selected.length > 12)
        throw Error("Select up to 12 concerts per countdown");
      s.draft.eventIds = selected;
      const first = store.concerts(s.guild).find((e) => e.id === ids[0]);
      if (first) {
        for (const key of ["city", "country", "venue", "timezone"])
          s.draft[key] ||= first.countdown_location?.[key] || "";
        s.draft.venue ||= first.event_location || "";
        s.draft.timezone ||=
          first.event_timezone || (!first.all_day ? first.timezone : "") || "";
      }
      await i.update(eventPage(s));
    } else if (action === "save") {
      validateConfig(s.draft, store.concerts(s.guild));
      store.save(s.guild, s.room, s.draft, s.revision);
      await i.update(
        detail(s, "Configuration saved. Preview privately before publishing."),
      );
    } else if (action === "photo") {
      await i.showModal(
        new Modal()
          .setCustomId(id(s, "photo-save"))
          .setTitle("Upload venue photograph")
          .addLabelComponents(
            new Label()
              .setLabel("Authorized venue photograph (JPEG/PNG, 4 MB)")
              .setDescription(
                "Use your own or an appropriately licensed photograph.",
              )
              .setFileUploadComponent(
                new Upload()
                  .setCustomId("image")
                  .setMinValues(1)
                  .setMaxValues(1)
                  .setRequired(true),
              ),
          ),
      );
    } else if (action === "photo-save") {
      await i.deferUpdate();
      const a = i.fields.getUploadedFiles("image", true).first();
      const p = await downloadPhoto(a);
      store.photo(s.guild, s.room, p.bytes, p.type);
      await i.editReply(
        detail(s, "Photograph saved. Use Private preview to inspect its crop."),
      );
    } else if (action === "photos") {
      const photos = store.photos(s.guild);
      s.photoPage = 0;
      await i.update(photoPage(s, photos));
    } else if (action === "photo-next" || action === "photo-prev") {
      s.photoPage = Math.max(
        0,
        s.photoPage + (action === "photo-next" ? 1 : -1),
      );
      await i.update(photoPage(s, store.photos(s.guild)));
    } else if (action === "reuse-photo") {
      store.reusePhoto(s.guild, s.room, i.values[0]);
      await i.update(detail(s, "Venue photograph reused."));
    } else if (action === "preview") {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await i.editReply(await service.preview(store.get(s.guild, s.room)));
    } else if (action === "publish") {
      const row = store.get(s.guild, s.room);
      s.publishRevision = row.revision;
      s.publishRoom = s.room;
      await i.update({
        ...safe,
        content: null,
        embeds: [
          embed(
            "Approve countdown publication",
            `Publish or repair the countdown in <#${s.room}>? Harmony will attach the card and pin its single managed message. Future calendar changes will be reflected when automatic updates are enabled.\n\n${row.enabled ? "Automatic updates are currently on." : "Automatic updates remain off until you enable them."}`,
          ),
        ],
        components: [
          new Row().addComponents(
            button(s, "confirm-publish", "Approve & publish", Style.Success),
            button(s, "back", "Cancel"),
          ),
        ],
      });
    } else if (action === "confirm-publish" || action === "refresh") {
      const row = store.get(s.guild, s.room);
      if (
        action === "confirm-publish" &&
        (s.publishRevision === undefined ||
          s.publishRevision !== row.revision ||
          s.publishRoom !== s.room)
      )
        throw Error(
          "Configuration changed. Preview it and approve publication again.",
        );
      s.publicationInFlight = true;
      try {
        await i.deferUpdate();
        const result = await service.refresh(i.client, s.guild, s.room, {
          publish: action === "confirm-publish",
          expectedRevision:
            action === "confirm-publish" ? s.publishRevision : undefined,
          force: true,
        });
        if (action === "confirm-publish" && !result.deferred) {
          delete s.publishRevision;
          delete s.publishRoom;
        }
        const retryStamp = Date.parse(result.retryAt);
        const retryMessage =
          "Discord requested a retry delay. Try again " +
          (Number.isFinite(retryStamp)
            ? `<t:${Math.floor(retryStamp / 1000)}:R>`
            : "after the saved retry time") +
          ".";
        await i.editReply(
          result.deferred && action === "confirm-publish"
            ? publicationRetry(s, retryMessage)
            : detail(
                s,
                result.deferred
                  ? retryMessage
                  : "Countdown updated and pinned.",
              ),
        );
      } finally {
        delete s.publicationInFlight;
      }
    } else if (action === "permissions") {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const snapshot = await roomAccess.inspect(i.client, s.guild, s.room);
      await i.editReply({
        ...safe,
        content: roomAccess.description(snapshot.diagnostics),
      });
    } else if (action === "toggle") {
      const row = store.get(s.guild, s.room);
      if (!row.message_id && !row.published_at)
        throw Error("Publish explicitly before enabling updates");
      store.update(s.guild, s.room, { enabled: row.enabled ? 0 : 1 });
      await i.update(detail(s));
    } else if (action === "back") {
      delete s.publishRevision;
      delete s.publishRoom;
      await i.update(detail(s));
    } else throw Error("Reopen the current countdown manager");
  } catch (e) {
    const response = {
      content: "Countdown: " + String(e.message).slice(0, 400),
      ...safe,
    };
    if (
      i.deferred &&
      action === "confirm-publish" &&
      s.publishRevision !== undefined &&
      s.publishRoom === s.room &&
      store.get(s.guild, s.room)?.revision === s.publishRevision
    )
      await i.editReply(publicationRetry(s, response.content));
    else if (i.deferred && action === "confirm-publish") {
      delete s.publishRevision;
      delete s.publishRoom;
      await i.editReply(detail(s, response.content));
    } else if (i.deferred) await i.editReply(response);
    else await i.reply({ ...response, flags: MessageFlags.Ephemeral });
  }
  return true;
}
function publicationRetry(s, message) {
  return {
    ...safe,
    content: message,
    attachments: [],
    embeds: [
      embed(
        "Countdown publication needs a retry",
        "Saved dates, venue details and photograph are unchanged. Check room access if needed, then retry. Any saved countdown message will be reused.",
      ),
    ],
    components: [
      new Row().addComponents(
        button(s, "confirm-publish", "Retry publication", Style.Success),
        button(s, "permissions", "Check room access"),
        button(s, "back", "Back"),
      ),
    ],
  };
}
function photoPage(s, photos) {
  const page = (s.photoPage = Math.min(
      s.photoPage,
      Math.max(0, Math.ceil(photos.length / 25) - 1),
    )),
    slice = photos.slice(page * 25, page * 25 + 25),
    components = [];
  if (slice.length)
    components.push(
      new Row().addComponents(
        new Select()
          .setCustomId(id(s, "reuse-photo"))
          .setPlaceholder("Choose a saved venue photograph")
          .addOptions(
            slice.map((p) => ({ label: p.name.slice(0, 100), value: p.id })),
          ),
      ),
    );
  components.push(
    new Row().addComponents(
      button(s, "photo-prev", "Previous").setDisabled(page === 0),
      button(s, "photo-next", "Next").setDisabled(
        (page + 1) * 25 >= photos.length,
      ),
      button(s, "back", "Back"),
    ),
  );
  return {
    ...safe,
    content: null,
    embeds: [
      embed(
        "Saved venue photographs",
        slice.length
          ? "Reuse an authorized photograph saved in this server."
          : "No saved photographs. Choose Upload photograph first.",
      ),
    ],
    components,
  };
}
module.exports = {
  open,
  handle,
  home,
  detail,
  draftPage,
  eventPage,
  fieldsModal,
  tourReviewPage,
  createSession,
  authorize,
};
