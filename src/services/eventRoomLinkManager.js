"use strict";
const { randomBytes } = require("node:crypto");
const { ActionRowBuilder: Row, ButtonBuilder: Button, ButtonStyle: Style, StringSelectMenuBuilder: Select, ChannelSelectMenuBuilder: Channels, ModalBuilder: Modal, TextInputBuilder: Input, TextInputStyle, PermissionFlagsBits: P } = require("discord.js");
const { isAdminRoomAuthorized } = require("./adminAuthorization");
const store = require("../stores/eventRoomLinkStore");
const events = require("../stores/eventSchedulerStore");
const service = require("./eventRoomLinkService");
const { getDb } = require("../db/sqlite");
const sessions = new Map(), TTL = 20 * 60000;
const safe = { allowedMentions: { parse: [] } };
const permitted = i => Boolean(i.guildId && (isAdminRoomAuthorized(i) || i.memberPermissions?.has?.(P.ManageEvents)));
const id = (s, action, extra = "") => `harmony-room-links:${s.token}:${action}${extra ? ":" + extra : ""}`;
const button = (s, action, text, style = Style.Secondary, extra = "") => new Button().setCustomId(id(s, action, extra)).setLabel(text).setStyle(style);
function entry(calendarType) { return new Button().setCustomId(`harmony-room-links:open:${calendarType}`).setLabel("Send Room Links by DM").setStyle(Style.Secondary); }
function eventEntry(event) { return new Button().setCustomId(`harmony-room-links:event:${event.id}`).setLabel("Send Room Links by DM").setStyle(Style.Primary); }
function create(i, calendarType) {
  for (const [key, s] of sessions) if (s.expires <= Date.now()) sessions.delete(key);
  if (sessions.size >= 500) sessions.delete(sessions.keys().next().value);
  const s = { token: randomBytes(8).toString("hex"), guild: i.guildId, channel: i.channelId, user: i.user.id, calendarType, page: 0, expires: Date.now() + TTL, manual: new Map() };
  sessions.set(s.token, s); return s;
}
function list(s) {
  const rows = getDb().prepare("SELECT * FROM scheduled_events WHERE guild_id=? AND calendar_type=? AND cancelled_at IS NULL ORDER BY COALESCE(event_date,substr(event_at,1,10)),id").all(s.guild, s.calendarType).filter(e => { try { return service.validDay(e, new Date()); } catch { return false; } });
  s.page = Math.min(Math.max(0, s.page), Math.max(0, Math.ceil(rows.length / 25) - 1));
  const slice = rows.slice(s.page * 25, s.page * 25 + 25);
  s.offered = slice.map(e => String(e.id));
  const components = [];
  if (slice.length) components.push(new Row().addComponents(new Select().setCustomId(id(s, "select")).setPlaceholder("Choose the event to help members find").addOptions(slice.map(e => ({ label: e.title.slice(0, 100), description: `${service.timing(e).day} · ${service.timing(e).timezone}`.slice(0, 100), value: String(e.id) })))));
  components.push(new Row().addComponents(button(s, "prev", "Previous").setDisabled(s.page === 0), button(s, "next", "Next").setDisabled((s.page + 1) * 25 >= rows.length), button(s, "close", "Back")));
  return { ...safe, content: `**SEND ROOM LINKS BY DM**\nChoose an event. You can send selected members a private message with one button to open its room, now or on the event day. They do not need to mark themselves interested.\n\n${rows.length} upcoming events · Page ${s.page + 1}`, components };
}
function scheduleContext(s, event) {
  const timing = service.timing(event);
  return JSON.stringify([timing.day, timing.timezone, event.event_channel_id, event.discord_event_id, store.settings(s.guild, s.event) || null]);
}
function receipt(ids) {
  const rows = ids.map(store.get).filter(Boolean);
  const sent = rows.filter(r => r.status === "sent").length;
  const failed = rows.filter(r => ["blocked", "failed", "cancelled"].includes(r.status) || (r.status !== "sent" && r.last_error));
  const waiting = rows.filter(r => ["pending", "sending"].includes(r.status) && !r.last_error).length;
  return ["**Private DM result**", `Delivered: ${sent} · Not delivered: ${failed.length} · Waiting: ${waiting}`,
    ...failed.slice(0, 5).map(r => `<@${r.user_id}>: ${r.last_error || "Message cancelled."}${r.retry_at ? " A retry is saved." : ""}`),
    ...(!rows.length ? ["No recipients were queued. Add the member again before sending."] : []),
  ].join("\n").slice(0, 1700);
}
async function result(i, s, ids) {
  const text = receipt(ids);
  try { await i.editReply(page(s, text)); }
  catch (error) { console.warn("[event-room-links] result_edit_failed", String(error.message).slice(0, 120)); }
  // A separate private receipt is visible even when the long setup is collapsed.
  if (i.followUp) await i.followUp({ ...safe, content: text, flags: 64 }).catch(error => console.warn("[event-room-links] receipt_failed", String(error.message).slice(0, 120)));
}
function page(s, notice = "") {
  const event = events.getEvent(s.guild, s.event);
  if (!event) throw Error("This event was cancelled or is no longer available.");
  const members = store.members(s.guild, s.event), settings = store.settings(s.guild, s.event), t = service.timing(event, settings?.local_time || "09:00");
  const jobKey = randomBytes(8).toString("hex");
  s.manual.set(jobKey, members.map(m => m.user_id));
  if (s.manual.size > 30) s.manual.delete(s.manual.keys().next().value);
  const jobs = store.deliveries(s.guild, s.event), sent = jobs.filter(j => j.status === "sent").length;
  const failures = jobs.filter(j => ["blocked", "failed", "pending"].includes(j.status) && j.last_error);
  const roomId = settings?.room_id || event.event_channel_id;
  return { ...safe, content: [notice, `**${event.title} — PRIVATE DMs**`, "Delivery: Private DMs to the selected members", `Event day: ${t.day} · ${t.timezone}`, roomId ? `Button opens: <#${roomId}>` : "Choose the room the button should open. Delivery is always a private DM.", "", `${members.length} selected member${members.length === 1 ? "" : "s"}:`, ...members.slice(0, 12).map(m => `• <@${m.user_id}> — ${m.scheduled ? `Scheduled ${settings?.local_time || "09:00"} on the event day` : "Send Now only"}`), ...(members.length > 12 ? [`…and ${members.length - 12} more`] : []), "", `Confirmed delivered: ${sent}. Queued / scheduled: ${jobs.filter(j => ["pending", "sending"].includes(j.status)).length}.`, ...failures.slice(0, 4).map(j => `<@${j.user_id}>: ${j.last_error}${j.retry_at ? ` Retry after ${j.retry_at}.` : ""}`), "", "Use Manage DM Recipients even if they have not marked themselves interested. Scheduling applies only to this selected event occurrence. Send Now does not cancel an event-day message."].filter(v => v !== undefined && v !== "").join("\n").slice(0, 1900), components: [
    new Row().addComponents(button(s, "recipients", "Manage DM Recipients")),
    new Row().addComponents(new Channels().setCustomId(id(s, "room")).setPlaceholder("Room the DM button opens").addChannelTypes(...service.roomTypes)),
    new Row().addComponents(button(s, "send", "Send DM Now", Style.Primary, jobKey).setDisabled(!members.length), button(s, "schedule", "Schedule Event-Day DM", Style.Success).setDisabled(!members.length)),
    new Row().addComponents(button(s, "stop", "Stop Scheduled Messages"), button(s, "retry", "Retry Failed Delivery"), button(s, "back", "Back to Events")),
  ] };
}
const normalizeName = value => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
const savedIds = s => store.members(s.guild, s.event).map(m => m.user_id).sort();
const sameIds = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
function recipientPage(s, notice = "") {
  const d = s.recipientEdits?.get(s.event);
  if (!d) throw Error("Reopen Manage DM Recipients.");
  const found = d.roster.filter(m => normalizeName(m.search).includes(normalizeName(d.query)));
  const pages = Math.max(1, Math.ceil(found.length / 25));
  d.page = Math.max(0, Math.min(d.page, pages - 1));
  const shown = found.slice(d.page * 25, d.page * 25 + 25);
  d.offered = shown.map(m => m.id);
  d.view = randomBytes(8).toString("hex");
  const components = [];
  if (shown.length) components.push(new Row().addComponents(new Select().setCustomId(id(s, "recipients-pick", d.view)).setPlaceholder("Check or uncheck members").setMinValues(0).setMaxValues(shown.length).addOptions(shown.map(m => ({ label: m.name.slice(0, 100), description: m.description.slice(0, 100), value: m.id, default: d.selected.has(m.id) })))));
  components.push(new Row().addComponents(button(s, "recipients-search", "Search Members"), button(s, "recipients-clear", "Clear Search").setDisabled(!d.query), button(s, "recipients-prev", "Previous").setDisabled(!d.page), button(s, "recipients-next", "Next").setDisabled(d.page + 1 >= pages)));
  components.push(new Row().addComponents(button(s, "recipients-save", "Save Recipients", Style.Success), button(s, "recipients-back", "Back")));
  return { ...safe, content: [notice, `**Manage DM Recipients — ${events.getEvent(s.guild, s.event)?.title || "Event"}**`, `${d.selected.size} selected members · Page ${d.page + 1} of ${pages}`, d.query ? `Search: ${d.query}` : "All server members", `${found.length} matching members`, !shown.length ? "No matching members. Your selections are kept." : "Check names to add them; uncheck names to remove them.", "Selections on other pages and searches are kept. Event interest is not required.", "Choose Save Recipients to apply your changes. This does not send any messages."].filter(Boolean).join("\n").slice(0, 1900), components };
}
async function openRecipients(i, s) {
  const baseline = savedIds(s);
  s.recipientEdits ||= new Map();
  let d = s.recipientEdits.get(s.event), notice = "";
  if (!d || !sameIds(baseline, d.baseline)) {
    const roster = await i.guild.members.fetch();
    const choices = new Map();
    for (const member of roster.values()) {
      if (member.guild.id !== s.guild || member.user.bot) continue;
      const name = member.displayName || member.user.globalName || member.user.username || member.id;
      choices.set(member.id, { id: member.id, name, description: `@${member.user.username || member.id}`, search: `${name} ${member.user.globalName || ""} ${member.user.username || ""}` });
    }
    for (const user of baseline) if (!choices.has(user)) choices.set(user, { id: user, name: `Saved recipient (${user})`, description: "Existing selection; member unavailable", search: user });
    if (d) notice = "The saved recipient list changed. Loaded the latest selections; review them before saving.";
    d = { baseline, selected: new Set(baseline), roster: [...choices.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), query: "", page: 0 };
    s.recipientEdits.set(s.event, d);
  }
  return recipientPage(s, notice);
}
async function handle(i) {
  if (!i.customId?.startsWith("harmony-room-links:")) return false;
  if (!permitted(i)) { await i.reply({ ...safe, content: "Only the server owner or members with Manage Server or Manage Events can send event room links.", flags: 64 }); return true; }
  const [, token, action, extra] = i.customId.split(":");
  let s;
  console.info("[event-room-links] action_received", JSON.stringify({ action: ["open", "event"].includes(token) ? token : action }));
  if (token === "open" || token === "event") {
    let calendarType = action;
    if (token === "event") {
      const event = events.getEvent(i.guildId, Number(action));
      if (!event) { await i.reply({ ...safe, content: "This event is no longer available.", flags: 64 }); return true; }
      calendarType = event.calendar_type;
    }
    if (!["community", "stray_kids"].includes(calendarType)) return true;
    s = create(i, calendarType);
    if (token === "event") s.event = Number(action);
    await i.deferReply({ flags: 64 });
    try { await i.editReply(s.event ? page(s) : list(s)); }
    catch (error) { console.error("[event-room-links] open_failed", error.message); await i.editReply({ ...safe, content: "Could not open room links: " + error.message }); }
    return true;
  }
  s = sessions.get(token);
  if (!s || s.expires <= Date.now() || s.guild !== i.guildId || s.channel !== i.channelId || s.user !== i.user.id) {
    await i.reply({ ...safe, content: "This private room-link setup expired or belongs to someone else. Open it from the Schedule Manager.", flags: 64 }); return true;
  }
  if (s.busy) { await i.reply({ ...safe, content: "This message action is already running. Please wait.", flags: 64 }); return true; }
  s.expires = Date.now() + TTL;
  s.busy = true;
  try {
    if (["back", "prev", "next"].includes(action)) {
      s.page = Math.max(0, s.page + (action === "next" ? 1 : action === "prev" ? -1 : 0));
      await i.update(list(s));
    } else if (action === "close") {
      sessions.delete(token); await i.update({ ...safe, content: "Room links closed. Return to the Schedule Manager when needed.", components: [] });
    } else if (action === "select") {
      if (!s.offered?.includes(i.values[0])) throw Error("Choose an event from this page.");
      s.event = Number(i.values[0]); await i.update(page(s));
    } else {
      const event = events.getEvent(s.guild, s.event);
      if (!event || event.calendar_type !== s.calendarType) throw Error("This event was cancelled or changed. Choose it again.");
      if (action === "recipients") {
        await i.deferUpdate();
        await i.editReply(await openRecipients(i, s));
      } else if (action.startsWith("recipients-")) {
        const d = s.recipientEdits?.get(s.event);
        if (!d) throw Error("Reopen Manage DM Recipients.");
        if (action === "recipients-search") {
          await i.showModal(new Modal().setCustomId(id(s, "recipients-query")).setTitle("Search Members").addComponents(new Row().addComponents(new Input().setCustomId("name").setLabel("Member name or username").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100).setValue(d.query))));
        } else if (action === "recipients-save") {
          await i.deferUpdate();
          if (!sameIds(savedIds(s), d.baseline)) throw Error("Recipients changed in another setup. Reopen Manage DM Recipients to load the saved list.");
          for (const user of d.selected) if (!d.baseline.includes(user)) {
            const member = await i.guild.members.fetch({ user, force: true });
            if (member.id !== user || member.guild.id !== s.guild || member.user.bot) throw Error("Choose human members of this server. No recipient changes were saved.");
          }
          const currentEvent = events.getEvent(s.guild, s.event);
          if (!currentEvent || currentEvent.calendar_type !== s.calendarType) throw Error("This event was cancelled or changed. Choose it again.");
          store.replaceRecipients(s.guild, s.event, [...d.selected], d.baseline, i.user.id);
          s.recipientEdits.delete(s.event);
          await i.editReply(page(s, "Recipients saved. No messages were sent."));
        } else if (action === "recipients-back") {
          await i.update(page(s, "Recipient edits are kept in this private setup. Reopen Manage DM Recipients to continue, then Save Recipients to apply them."));
        } else {
          if (action === "recipients-pick") {
            const values = [...new Set(i.values)];
            if (extra !== d.view || values.some(u => !d.offered.includes(u))) throw Error("That member list changed. Use the latest recipient list.");
            for (const user of d.offered) d.selected.delete(user);
            for (const user of values) d.selected.add(user);
          } else if (action === "recipients-query") { d.query = i.fields.getTextInputValue("name").trim().slice(0, 100); d.page = 0; }
          else if (action === "recipients-clear") { d.query = ""; d.page = 0; }
          else if (["recipients-prev", "recipients-next"].includes(action)) d.page += action === "recipients-next" ? 1 : -1;
          else throw Error("Reopen Manage DM Recipients.");
          await i.update(recipientPage(s));
        }
      } else if (action === "add") {
        await i.deferUpdate();
        const ids = [...new Set(i.values)];
        if (!ids.length || ids.length > 25) throw Error("Choose up to 25 members at a time.");
        for (const user of ids) {
          const member = await i.guild.members.fetch({ user, force: true });
          if (member.guild.id !== s.guild || member.user.bot) throw Error("Choose human members of this server.");
        }
        store.add(s.guild, s.event, ids, i.user.id);
        await i.editReply(page(s, "Members saved. No messages were sent."));
      } else if (action === "remove") {
        store.remove(s.guild, s.event, i.values); await i.update(page(s, "Selected members removed. Unsent messages will stop."));
      } else if (action === "room") {
        await i.deferUpdate();
        await service.resolveRoom(i.client, event, i.values[0]);
        store.configure(s.guild, s.event, { roomId: i.values[0] === event.event_channel_id ? null : i.values[0] }, i.user.id);
        await i.editReply(page(s, "Button link saved. Messages will go to members’ DMs; nothing will be posted in that room."));
      } else if (action === "schedule") {
        const t = service.timing(event, store.settings(s.guild, s.event)?.local_time || "09:00");
        s.scheduleUsers = store.members(s.guild, s.event).map(m => m.user_id);
        s.scheduleContext = scheduleContext(s, event);
        await i.showModal(new Modal().setCustomId(id(s, "schedule-save")).setTitle("Event-day DM").addComponents(new Row().addComponents(new Input().setCustomId("time").setLabel(`Time HH:MM · ${t.timezone}`.slice(0, 45)).setStyle(TextInputStyle.Short).setPlaceholder("09:00 = 9 AM; 19:00 = 7 PM").setValue(store.settings(s.guild, s.event)?.local_time || "09:00").setRequired(true).setMaxLength(5))));
      } else if (action === "schedule-save") {
        await i.deferUpdate();
        if (!s.scheduleUsers?.length || s.scheduleContext !== scheduleContext(s, event)) throw Error("The event day, time zone or room settings changed. Open Schedule Event-Day Message again.");
        const selected = s.scheduleUsers.filter(user => store.members(s.guild, s.event).some(m => m.user_id === user));
        if (!selected.length) throw Error("Add members before scheduling their event-day message.");
        const clock = i.fields.getTextInputValue("time").trim(), t = service.timing(event, clock), now = new Date();
        if (t.due <= now || !service.validDay(event, now)) throw Error("Choose a future time on the event day, or use Send Now.");
        if (event.event_end_at && t.due.getTime() >= Date.parse(event.event_end_at)) throw Error("Choose a time before this event finishes.");
        await service.resolveRoom(i.client, event, store.settings(s.guild, s.event)?.room_id);
        store.configure(s.guild, s.event, { localTime: clock }, i.user.id);
        store.schedule(s.guild, s.event, true, selected);
        delete s.scheduleUsers;
        delete s.scheduleContext;
        service.reconcile(now);
        await i.editReply(page(s, `Scheduled for ${t.day} at ${clock} (${t.timezone}). No message was sent now.`));
      } else if (action === "stop") {
        store.schedule(s.guild, s.event, false); await i.update(page(s, "Event-day messages stopped for this event."));
      } else if (action === "send") {
        const users = s.manual.get(extra);
        if (!users) throw Error("That Send Now button expired. Reopen this event's room links.");
        await i.deferUpdate();
        await i.editReply(page(s, "**Sending private DMs…** A delivered or failed result will appear here."));
        if (!service.validDay(event, new Date())) throw Error("This event has finished. Choose an upcoming event.");
        await service.resolveRoom(i.client, event, store.settings(s.guild, s.event)?.room_id);
        const now = new Date(), ids = store.enqueue(s.guild, s.event, users, `manual:${s.guild}:${s.event}:${s.token}:${extra}`, "manual", now.toISOString(), now);
        for (const row of store.due(now).filter(r => ids.includes(r.id))) await service.deliver(i.client, row.id, { now });
        await result(i, s, ids);
      } else if (action === "retry") {
        await i.deferUpdate();
        await i.editReply(page(s, "**Checking delivery and retrying…**"));
        store.retry(s.guild, s.event);
        const now = new Date();
        const ids = store.deliveries(s.guild, s.event).map(r => r.id);
        for (const row of store.due(now).filter(r => ids.includes(r.id))) await service.deliver(i.client, row.id, { now });
        await result(i, s, ids);
      } else throw Error("Reopen this event's room links.");
    }
  } catch (error) {
    console.error("[event-room-links] action_failed", JSON.stringify({ action, reason: String(error.message).replace(/https?:\/\/\S+/g, "[url]").slice(0, 200) }));
    const response = { ...safe, content: error.message };
    if (i.deferred) {
      const current = events.getEvent(s.guild, s.event);
      const editingRecipients = action.startsWith("recipients");
      const view = current ? (editingRecipients && s.recipientEdits?.has(s.event) ? recipientPage(s) : page(s)) : list(s);
      const heading = editingRecipients ? "**Recipients were not saved**" : "**Private DM was not completed**";
      await i.editReply({ ...view, content: (heading + "\n" + error.message + "\n\n" + view.content).slice(0, 1900) });
      if (i.followUp) await i.followUp({ ...safe, content: heading + "\n" + error.message, flags: 64 });
    } else await i.reply({ ...response, flags: 64 });
  } finally { s.busy = false; }
  return true;
}
module.exports = { recipientPage, receipt, entry, eventEntry, handle, page, list, create, permitted };
