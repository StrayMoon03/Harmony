"use strict";
// Offline actual interaction payloads, isolated SQLite and fixture Discord objects only.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
process.env.HARMONY_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "manager-review-")), "fixture.sqlite");
const { Collection, ChannelType } = require("discord.js");
const manager = require("../src/services/concertCountdownManager");
const store = require("../src/stores/concertCountdownStore"), rooms = require("../src/stores/adminRoomStore");
const tour = require("../src/services/concertTourCalendar"), service = require("../src/services/concertCountdownService");
const discovery = require("../src/services/concertCountdownDiscovery");
const output = path.join(__dirname, "../docs/countdown-manager-simplified");
fs.mkdirSync(output, { recursive: true });
const guild = "fixture-manager", room = "fixture-chicago";
rooms.savePanel({ guildId: guild, channelId: "private", messageId: "panel" });
const manifest = tour.scopedManifest("chicago");
tour.importConfirmed(guild, manifest, tour.audit(guild, manifest).fingerprint, "fixture-owner");
const channel = { id: room, guildId: guild, type: ChannelType.GuildText, name: "chicago-concert" };
const base = { guildId: guild, channelId: "private", user: { id: "owner" }, message: { id: "panel" }, memberPermissions: { has: () => false }, guild: { id: guild, ownerId: "owner", channels: { fetch: async id => id ? channel : new Collection([[room, channel]]) } }, client: {} };
const s = manager.createSession(base), pages = {};
function save(name, payload) {
  const copy = { ...payload };
  if (copy.files) copy.files = copy.files.map((f, n) => {
    const file = name + "-" + n + ".png";
    fs.writeFileSync(path.join(output, file), f.attachment);
    return { ...f, attachment: file };
  });
  pages[name] = JSON.parse(JSON.stringify(copy));
}
async function action(action, name, extra = {}) {
  let response;
  const i = { ...base, customId: `harmony-countdown:${s.token}:${action}`, values: [], ...extra,
    update: async p => { response = p; }, editReply: async p => { response = p; }, reply: async p => { response = p; }, deferUpdate: async () => { i.deferred = true; }, deferReply: async () => { i.deferred = true; } };
  await manager.handle(i);
  if (name) save(name, response);
}
(async () => {
  save("home", manager.home(s));
  await action("add", "concert-picker");
  await action("choose-concert", "setup", { values: ["chicago"] });
  // A synthetic, locally created photograph fixture, never an owner upload.
  const photo = spawnSync("python3", ["-c", "from PIL import Image,ImageDraw; import sys; im=Image.new('RGB',(1200,600),'#47536a'); d=ImageDraw.Draw(im); d.text((420,280),'OFFLINE PHOTO FIXTURE',fill='white'); im.save(sys.stdout.buffer,format='JPEG')"]);
  store.save(guild, room, s.draft, -1);
  store.photo(guild, room, photo.stdout, "jpeg");
  s.revision = store.get(guild, room).revision;
  save("setup-photo-saved", manager.setup(s));
  await action("preview", "private-preview");
  const refresh = service.refresh;
  service.refresh = async () => { store.update(guild, room, { message_id: "fixture-published", published_at: "2026-11-24T12:00Z" }); return { updated: true }; };
  await action("confirm-publish", "published");
  service.refresh = refresh;
  await action("configured", "configured");
  await action("open", "management", { values: [room] });
  await action("discover", "discovery");
  const search = discovery.search;
  discovery.search = async () => ({ checkedAt: "2026-11-24T12:00Z", sources: [{ provider: "jype-notice", ok: true }, { provider: "sony-info", ok: true }], items: [{ title: "FIXTURE: Stray Kids additional Chicago concert", summary: "Offline test announcement: Soldier Field, June 20, 2027. Not a real tour announcement.", url: "https://straykids.jype.com/notice/fixture", location: manifest.locations[0], dates: ["2027-06-20"] }] });
  await action("discovery-run", "discovery-results");
  discovery.search = search;
  await action("discovery-item", "announcement", { values: ["0"] });
  await action("discovery-fields", "import-review", { fields: { getTextInputValue: key => ({ city: "Chicago", country: "United States", venue: "Soldier Field", timezone: "America/Chicago", dates: "2027-06-20" })[key] } });
  fs.writeFileSync(path.join(output, "manager-payloads.json"), JSON.stringify(pages, null, 2) + "\n");
  console.log("Generated actual private manager payloads and renderer attachment using isolated fixtures; no network or Discord calls.");
})().catch(error => { console.error(error); process.exitCode = 1; });
