"use strict";
// Offline actual component payloads only. No Discord/network calls or production DB.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
process.env.HARMONY_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "room-link-preview-")), "fixture.sqlite");
const events = require("../src/stores/eventSchedulerStore"), store = require("../src/stores/eventRoomLinkStore");
const manager = require("../src/services/eventRoomLinkManager"), service = require("../src/services/eventRoomLinkService");
const scheduler = require("../src/services/eventSchedulerService");
const g = "fixture-server", room = "fixture-room", member = "fixture-member";
const event = events.createCalendarEvent({ guildId: g, calendarChannelId: "calendar", calendarType: "community", title: "Sunday Listening Party", eventDate: "2030-06-23", eventAt: "2030-06-23T23:00:00Z", eventTimezone: "America/New_York", timezone: "America/New_York", eventChannelId: room, createdBy: "fixture-owner" });
const selected = events.getEvent(g, event);
store.add(g, event, [member], "fixture-owner");
store.configure(g, event, { localTime: "09:00" }, "fixture-owner");
store.schedule(g, event, true);
service.reconcile(new Date("2030-06-22T13:00:00Z"));
const session = manager.create({ guildId: g, channelId: "private", user: { id: "fixture-owner" } }, "community");
session.event = event;
const pages = {
  entry: { content: scheduler.managerPanelContent("community"), components: scheduler.managerPanelComponents("community", g) },
  staff: manager.page(session),
  member: service.payload(selected, { id: room }, { id: 42, nonce: "offline-fixture" }),
};
const output = path.join(__dirname, "../docs/event-room-links/payloads.json");
fs.writeFileSync(output, JSON.stringify(pages, null, 2) + "\n");
console.log("Generated actual staff and member-message payloads using isolated fixtures only.");
