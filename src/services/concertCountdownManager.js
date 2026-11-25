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
const discovery = require("./concertCountdownDiscovery");
const { normalize, phrase } = require("./concertTourIdentity");
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
function configured(s, notice = "") {
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
                label: `${c.city} — ${c.venue}`.slice(0, 100),
                description: (
                  (r.message_id || r.published_at ? "Published" : "Draft") +
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
      button(s, "home", "Back"),
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
        "Configured Countdowns",
        `${rows.length} configured concert room${rows.length === 1 ? "" : "s"}. Choose a countdown to manage its dates, photograph, publication and automatic updates.`,
      ),
    ],
    components,
    attachments: [],
  };
}
function home(s, notice = "") {
  return { ...safe, content: notice || null, attachments: [],
    embeds: [embed("Concert Countdown Manager", "Choose what you would like to do. New countdowns stay private until you approve publication.")],
    components: [
      new Row().addComponents(button(s, "configured", "Configured Countdowns")),
      new Row().addComponents(button(s, "add", "Add Countdown", Style.Primary)),
      new Row().addComponents(button(s, "discover", "Search for New Concerts")),
      new Row().addComponents(button(s, "close", "Back to Control Center")),
    ],
  };
}
function configuredLocations(s, l) {
  return store.list(s.guild).filter(r => {
    const c = JSON.parse(r.config);
    return normalize(c.city) === normalize(l.city) && normalize(c.venue) === normalize(l.venue);
  });
}
function concertPicker(s) {
  // Two supported 25-option menus show all 34 bundled venue groups together.
  // Keep pagination for future approved locations beyond this 50-location page.
  const locations = tour.groups(s.guild, s.query), page = s.locationPage = Math.min(s.locationPage || 0, Math.max(0, Math.ceil(locations.length / 50) - 1));
  const slice = locations.slice(page * 50, page * 50 + 50);
  s.offeredLocations = slice.map(l => l.key);
  const components = [];
  for (let offset = 0; offset < slice.length; offset += 25) {
    const menu = slice.slice(offset, offset + 25), more = offset > 0;
    components.push(new Row().addComponents(new Select().setCustomId(id(s, more ? "choose-concert-more" : "choose-concert")).setPlaceholder(more ? `More cities and venues (${page * 50 + offset + 1}–${page * 50 + offset + menu.length})` : "Choose a city and venue").addOptions(menu.map(l => ({
      label: `${l.city} — ${l.venue}`.slice(0, 100), value: l.key,
      description: `${configuredLocations(s, l).length ? "Already configured · " : ""}${l.country} · ${l.events.length} approved dates${l.audit.some(a => a.status === "missing") ? " · More dates need import" : ""}`.slice(0, 100),
    })))));
  }
  components.push(new Row().addComponents(button(s, "concert-prev", "Previous").setDisabled(page === 0), button(s, "concert-next", "Next").setDisabled((page + 1) * 50 >= locations.length), button(s, "search", "Search Locations"), button(s, "home", "Back")));
  return { ...safe, content: null, attachments: [], embeds: [embed("Add Countdown — Select Concert", `${locations.length} locations · Page ${page + 1}\n${slice.length > 25 ? "Both lists below are part of the same concert picker. " : ""}Search by city, country, venue or date. All approved dates at the selected venue will be filled in together. Locations needing calendar approval remain marked.`)], components };
}
function setup(s, notice = "") {
  const c = s.draft, events = store.concerts(s.guild);
  const buttons = [button(s, "photo", "Upload Photograph"), button(s, "details", "Edit Details"), button(s, "events", "Edit Dates")];
  if (store.photos(s.guild).length) buttons.splice(1, 0, button(s, "photos", "Reuse Photograph"));
  const row = s.room && store.get(s.guild, s.room);
  return { ...safe, content: notice || null, attachments: [], embeds: [embed("Confirm Setup", `${c.city} · ${c.country}\n${c.venue}\nTime zone: ${c.timezone}\n\n${c.eventIds.map(n => { const e = events.find(e => e.id === n); return e ? eventDay(e) : "Date unavailable — review dates"; }).join("\n") || "No approved dates yet — review missing dates before previewing."}\n\nRoom: ${s.room ? `<#${s.room}>${s.roomSuggested ? " (suggested; change below if needed)" : ""}` : "Choose a room below; no unambiguous match was found."}\nPhotograph: ${row?.photo || s.creationPhoto ? "Saved" : "Upload or reuse a photograph"}\nAutomatic daily updates: **${s.auto ? "On" : "Off"}**\n\n${s.missingDates ? "Additional confirmed dates need calendar approval. Use Review Missing Dates below. " : ""}${c.eventIds.length > 12 ? "Select up to 12 dates for one countdown. " : ""}Review the details, add your photograph, then preview. Nothing is published yet.`)], components: [
    new Row().addComponents(new Channels().setCustomId(id(s, "setup-room")).setPlaceholder("Confirm or change concert room").addChannelTypes(ChannelType.GuildText)),
    ...Array.from({ length: Math.ceil(buttons.length / 2) }, (_, n) => new Row().addComponents(...buttons.slice(n * 2, n * 2 + 2))),
    new Row().addComponents(button(s, "setup-auto", s.auto ? "Daily Updates: On" : "Daily Updates: Off"), button(s, "preview", "Preview Countdown", Style.Primary).setDisabled(Boolean(!s.room || !c.eventIds.length || c.eventIds.length > 12 || s.missingDates)), button(s, "creation-back", "Back")),
    ...(s.missingDates ? [new Row().addComponents(button(s, "tour-review", "Review Missing Dates"))] : []),
  ] };
}
async function suggestRoom(i, s, location) {
  const channels = await i.guild.channels.fetch().catch(() => null);
  const values = typeof channels?.values === "function" ? [...channels.values()] : [channels];
  const candidates = values.filter(c => c?.guildId === s.guild && c.type === ChannelType.GuildText && !store.get(s.guild, c.id) && [location.city, ...(location.cityAliases || []), location.venue].some(name => phrase(c.name, name)));
  s.room = candidates.length === 1 ? candidates[0].id : null;
  s.roomSuggested = Boolean(s.room);
  s.revision = -1;
}
function persistDraft(s) {
  if (!s.room) throw Error("Choose the concert room before continuing");
  validateConfig(s.draft, store.concerts(s.guild));
  const old = store.get(s.guild, s.room);
  if (old && s.revision === -1) throw Error("This room already has a countdown. Open it from Configured Countdowns.");
  if (!old || JSON.stringify(JSON.parse(old.config)) !== JSON.stringify(s.draft)) {
    store.save(s.guild, s.room, s.draft, s.revision);
  } else if (old.revision !== s.revision) throw Error("This countdown changed. Reopen it before continuing.");
  s.revision = store.get(s.guild, s.room).revision;
  return store.get(s.guild, s.room);
}
function openSaved(s, room) {
  s.room = room;
  s.publishRevision = undefined;
  const row = store.get(s.guild, room);
  if (!row) throw Error("Countdown no longer exists");
  const config = JSON.parse(row.config);
  s.creating = !row.message_id && !row.published_at && typeof config.setupAuto === "boolean";
  if (!s.creating) return detail(s);
  s.draft = config;
  s.auto = config.setupAuto;
  s.revision = row.revision;
  const location = tour.groups(s.guild).find(l => normalize(l.city) === normalize(config.city) && normalize(l.venue) === normalize(config.venue));
  s.creationLocation = s.locationKey = location?.key;
  s.missingDates = location?.audit.some(a => a.status === "missing" || a.status === "repair");
  s.creationPhoto = row.photo ? { bytes: row.photo, type: row.photo_type } : null;
  return setup(s);
}
function published(s) {
  return { ...safe, content: null, attachments: [], embeds: [embed("Countdown Published", "Your countdown is published and pinned. You can manage it at any time from Configured Countdowns.")], components: [new Row().addComponents(button(s, "add", "Create Another Countdown", Style.Primary), button(s, "configured", "Configured Countdowns"), button(s, "home", "Back to Countdown Manager"))] };
}
function discoveryPage(s, notice = "") {
  const result = s.discovery, items = result?.items || [], page = s.discoveryPage = Math.min(s.discoveryPage || 0, Math.max(0, Math.ceil(items.length / 25) - 1));
  s.offeredDiscoveries = items.slice(page * 25, page * 25 + 25).map((_, n) => page * 25 + n);
  const components = [];
  if (items.length) components.push(new Row().addComponents(new Select().setCustomId(id(s, "discovery-item")).setPlaceholder("Review an official announcement").addOptions(s.offeredDiscoveries.map(n => ({ label: items[n].title.slice(0, 100) || "Official announcement", value: String(n), description: "Review concert dates before any calendar import" })))));
  components.push(new Row().addComponents(button(s, "discovery-run", "Check Official Sources", Style.Primary), button(s, "tour-audit", "Tour Reference & Audit"), button(s, "tour-upload", "Upload Confirmed Dates")));
  components.push(new Row().addComponents(button(s, "discovery-prev", "Previous").setDisabled(page === 0), button(s, "discovery-next", "Next").setDisabled((page + 1) * 25 >= items.length), button(s, "home", "Back")));
  return { ...safe, content: notice || null, attachments: [], embeds: [embed("Search for New Concerts", `Check recent JYPE and Sony Japan announcements using Harmony's official-source readers. Searches cover the last seven days of available listings; image-only schedules may require manual date review. This does not import dates or send public messages.\n\n${result ? `Checked ${result.checkedAt} · ${items.length} announcements to review\n${result.sources.map(r => `${({ "jype-notice": "JYPE notices", "sony-info": "Sony Japan" })[r.provider] || r.provider}: ${r.ok ? "Checked" : "Unavailable"}${r.limitation ? " — " + r.limitation : ""}`).join("\n")}\n\nNo matching announcements is not proof there are no new concerts.` : "Choose Check Official Sources to search. Tour Reference & Audit is the saved reference, not a live search."}`)], components };
}
function discoveryModal(s) {
  const item = s.discovery.items[s.discoveryIndex], l = item.location || {};
  const modal = new Modal().setCustomId(id(s, "discovery-fields")).setTitle("Review announced concert dates");
  for (const [key, label, value, max] of [["city", "City", l.city, 80], ["country", "Country", l.country, 80], ["venue", "Venue", l.venue, 120], ["timezone", "Venue time zone", l.timezone, 80], ["dates", "Confirmed dates (YYYY-MM-DD, comma separated)", item.dates.join(", "), 200]]) {
    const input = new Input().setCustomId(key).setLabel(label).setStyle(InputStyle.Short).setRequired(true).setMaxLength(max);
    if (value) input.setValue(value);
    modal.addComponents(new Row().addComponents(input));
  }
  return modal;
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
        button(s, "configured", "Configured Countdowns"),
      ),
    ],
  };
}
function draftPage(s, notice = "") {
  if (s.creating) return setup(s, notice);
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
  let ownsWork = false;
  try {
    if (s.uiInFlight) throw Error("This countdown is preparing an update. Wait for its result.");
    if (["choose-concert", "choose-concert-more", "setup-room", "photo-save", "preview", "reuse-photo", "tour-upload-save", "tour-approve", "discovery-run"].includes(action)) {
      s.uiInFlight = true;
      ownsWork = true;
    }
    if (s.discoveryInFlight) throw Error("An official-source search is already running. Wait for its result.");
    if (s.publicationInFlight && action !== "permissions")
      throw Error(
        "Countdown publication is already running. Wait for its result.",
      );
    if (["details-save", "select-events", "select-location-all", "setup-room", "setup-auto", "edit", "toggle"].includes(action)) {
      delete s.publishRevision;
      delete s.publishRoom;
    }
    if (action === "close") {
      await i.deferUpdate();
      await i.deleteReply();
      sessions.delete(s.token);
    } else if (action === "home") {
      await i.update(home(s));
    } else if (action === "configured" || action === "list-prev" || action === "list-next") {
      s.creating = false;
      s.listPage = Math.max(
        0,
        s.listPage +
          (action === "list-next" ? 1 : action === "list-prev" ? -1 : 0),
      );
      await i.update(configured(s));
    } else if (action === "add") {
      s.pickingConcert = true;
      s.query = "";
      s.locationPage = 0;
      await i.update(concertPicker(s));
    } else if (action === "concert-prev" || action === "concert-next" || action === "creation-back") {
      s.pickingConcert = true;
      s.locationPage = Math.max(0, (s.locationPage || 0) + (action === "concert-next" ? 1 : action === "concert-prev" ? -1 : 0));
      await i.update(concertPicker(s));
    } else if (action === "choose-concert" || action === "choose-concert-more") {
      if (!s.offeredLocations?.includes(i.values[0])) throw Error("Choose a concert from the current page");
      await i.deferUpdate();
      const location = tour.groups(s.guild).find(l => l.key === i.values[0]);
      if (!location) throw Error("Concert location no longer available");
      s.pickingConcert = false;
      if (s.creating && s.creationLocation === location.key) {
        await i.editReply(setup(s));
      } else {
        const existing = configuredLocations(s, location);
        if (existing.length) {
          s.creating = false;
          s.room = existing.length === 1 ? existing[0].channel_id : null;
          await i.editReply(s.room ? openSaved(s, s.room) : configured(s, "Multiple countdowns use this location. Choose the room to manage."));
        } else {
          s.creating = true;
          s.creationLocation = s.locationKey = location.key;
          s.draft = { guildId: s.guild, ...Object.fromEntries(["city", "country", "venue", "timezone"].map(k => [k, location[k] || ""])), eventIds: location.events.map(e => e.id) };

          s.auto = true;
          s.draft.setupAuto = true;
          s.creationPhoto = null;
          s.publishRevision = undefined;
          s.missingDates = location.audit.some(a => a.status === "missing" || a.status === "repair");
          await suggestRoom(i, s, location);
          await i.editReply(setup(s));
        }
      }
    } else if (action === "setup-room") {
      if (!s.creating) throw Error("Open a new countdown setup before changing rooms.");
      await i.deferUpdate();
      const channel = await i.guild.channels.fetch(i.values[0]);
      if (channel?.guildId !== s.guild || channel.type !== ChannelType.GuildText) throw Error("Choose a text room in this server");
      if (channel.id !== s.room && store.get(s.guild, channel.id)) throw Error("This room already has a countdown. Manage it from Configured Countdowns.");
      if (channel.id !== s.room) {
        const old = s.room && store.get(s.guild, s.room);
        s.revision = old ? store.moveDraft(s.guild, s.room, channel.id, s.revision).revision : -1;
      }
      s.room = channel.id;
      s.roomSuggested = false;
      s.publishRevision = undefined;
      await i.editReply(setup(s));
    } else if (action === "setup-auto") {
      if (!s.creating) throw Error("Open a new countdown setup before changing its preference.");
      s.auto = !s.auto;
      s.draft.setupAuto = s.auto;
      if (s.room && store.get(s.guild, s.room)) persistDraft(s);
      s.publishRevision = undefined;
      await i.update(setup(s));
    } else if (action === "discover" || action === "discovery-prev" || action === "discovery-next") {
      s.discoveryPage = Math.max(0, (s.discoveryPage || 0) + (action === "discovery-next" ? 1 : action === "discovery-prev" ? -1 : 0));
      await i.update(discoveryPage(s));
    } else if (action === "discovery-run") {
      if (s.discoveryInFlight) throw Error("An official-source search is already running");
      s.discoveryInFlight = true;
      await i.deferUpdate();
      try {
        s.discovery = await discovery.search(s.guild);
        s.discoveryPage = 0;
        await i.editReply(discoveryPage(s));
      } finally { s.discoveryInFlight = false; }
    } else if (action === "discovery-item") {
      const n = Number(i.values[0]);
      if (!s.offeredDiscoveries?.includes(n)) throw Error("Choose an announcement from the current page");
      s.discoveryIndex = n;
      const item = s.discovery.items[n];
      await i.update({ ...safe, content: null, attachments: [], embeds: [embed("Review Official Announcement", `${item.title}\n\n${item.summary.slice(0, 1800)}\n\n[Read the original announcement](${item.url})\n\nConfirm concert dates, not ticket-sale dates. Nothing will be imported until you review and approve the calendar changes.`)], components: [new Row().addComponents(button(s, "discovery-prepare", "Review Dates", Style.Primary), button(s, "discover", "Back"))] });
    } else if (action === "discovery-prepare") {
      if (!s.discovery?.items[s.discoveryIndex]) throw Error("Choose an announcement first");
      await i.showModal(discoveryModal(s));
    } else if (action === "discovery-fields") {
      const fields = Object.fromEntries(["city", "country", "venue", "timezone", "dates"].map(k => [k, i.fields.getTextInputValue(k).trim()]));
      const manifest = discovery.manifest(s.discovery?.items[s.discoveryIndex], fields);
      s.reviewReturn = "discover";
      await i.update(tourReviewPage(s, manifest));
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
      await i.update(openSaved(s, i.values[0]));
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
      await i.update(s.pickingConcert ? concertPicker(s) : eventPage(s));
    } else if (["events", "event-prev", "event-next"].includes(action)) {
      s.pickingConcert = false;
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
      s.reviewReturn = action === "tour-audit" ? "discover" : null;
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
      if (s.creating) {
        const l = tour.groups(s.guild).find(l => l.key === s.creationLocation);
        if (l && l.events.length <= 12) s.draft.eventIds = l.events.map(e => e.id);
        s.missingDates = l?.audit.some(a => a.status === "missing" || a.status === "repair");
      }
      const page = s.reviewReturn === "discover" ? discoveryPage(s) : s.creating ? setup(s) : s.room ? eventPage(s) : discoveryPage(s);
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
      await i.update(s.reviewReturn === "discover" ? discoveryPage(s) : s.creating ? setup(s) : s.room ? eventPage(s) : discoveryPage(s));
    } else if (action === "tour-upload") {
      s.reviewReturn = "discover";
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
      if (s.creating) persistDraft(s);
      const a = i.fields.getUploadedFiles("image", true).first();
      const p = await downloadPhoto(a);
      store.photo(s.guild, s.room, p.bytes, p.type);
      if (s.creating) { s.creationPhoto = p; s.revision = store.get(s.guild, s.room).revision; }
      s.publishRevision = undefined;
      await i.editReply(s.creating ? setup(s, "Photograph saved. Preview to inspect its crop.") : detail(s, "Photograph saved. Use Private preview to inspect its crop."));
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
      if (s.creating) persistDraft(s);
      store.reusePhoto(s.guild, s.room, i.values[0]);
      if (s.creating) { const row = store.get(s.guild, s.room); s.revision = row.revision; s.creationPhoto = { bytes: row.photo, type: row.photo_type }; }
      s.publishRevision = undefined;
      await i.update(s.creating ? setup(s, "Venue photograph reused.") : detail(s, "Venue photograph reused."));
    } else if (action === "preview") {
      if (s.creating) {
        s.publishRevision = undefined;
        await i.deferUpdate();
        if (s.missingDates) throw Error("Review and approve the missing calendar dates before previewing.");
        persistDraft(s);
        if (s.creationPhoto && !store.get(s.guild, s.room).photo) {
          store.photo(s.guild, s.room, s.creationPhoto.bytes, s.creationPhoto.type);
          s.revision = store.get(s.guild, s.room).revision;
        }
        const row = store.get(s.guild, s.room), payload = await service.preview(row);
        if (store.get(s.guild, s.room)?.revision !== row.revision) throw Error("Configuration changed during preview. Reopen the saved countdown and preview again.");
        s.publishRevision = row.revision;
        s.publishRoom = s.room;
        s.reviewAuto = s.auto;
        await i.editReply({ ...payload, components: [new Row().addComponents(button(s, "confirm-publish", "Approve & Publish", Style.Success), button(s, "back", "Edit / Back"))] });
      } else {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await i.editReply(await service.preview(store.get(s.guild, s.room)));
      }
    } else if (action === "publish") {
      if (s.creating) throw Error("Use Preview Countdown before approving a new countdown.");
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
        if (s.creating && action === "confirm-publish") {
          const current = store.get(s.guild, s.room);
          if (current.revision !== s.publishRevision) throw Error("Configuration changed. Preview it and approve publication again.");
          // Persist the reviewed preference only after explicit approval, before a send
          // can succeed. A restart after delivery must not lose the owner's choice.
          store.update(s.guild, s.room, { enabled: s.reviewAuto ? 1 : 0 });
        }
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
            : s.creating && action === "confirm-publish" && !result.deferred ? published(s) : detail(
                s,
                result.deferred
                  ? retryMessage
                  : "Countdown updated and pinned.",
              ),
        );
        if (action === "confirm-publish" && !result.deferred) s.creating = false;
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
      await i.update(s.creating ? setup(s) : detail(s));
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
    } else if (i.deferred && s.creating) await i.editReply(setup(s, response.content));
    else if (i.deferred && action === "discovery-run") await i.editReply(discoveryPage(s, response.content));
    else if (i.deferred) await i.editReply(response);
    else await i.reply({ ...response, flags: MessageFlags.Ephemeral });
  } finally {
    if (ownsWork) delete s.uiInFlight;
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
  configured,
  concertPicker,
  setup,
  discoveryPage,
  discoveryModal,
  detail,
  draftPage,
  eventPage,
  fieldsModal,
  tourReviewPage,
  createSession,
  authorize,
};
