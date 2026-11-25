# Staff-managed event room messages

Implemented on `feat/event-room-direct-messages`, based on merged main `8570a9437aee01556fd98cd7ac6f41fe4c016fd0`. **For review; no merge or deployment.**

## What the owner can do

Use **Send Room Links** in the Schedule Manager, on a community event's editing screen, or after creating a community event. Choose the event and add the people who need help finding its room. Members do not need to mark themselves Interested, subscribe to reminders or navigate the calendar.

- **Send Now** sends each selected member a private message with the event title, date/start time and one **Open the Event Room** button.
- **Schedule Event-Day Message** lets staff choose a clock time in the event's calendar presentation time zone. A private message is sent on that event's local day. The form explains the 24-hour format.
- **Stop Scheduled Messages**, **Remove Members** and **Retry Failed Delivery** provide control without changing the event or anyone's existing personal reminder preferences.
- Confirmed deliveries, queued work and delivery errors are shown privately. A failed DM is not reported as delivered.

The event's assigned room is used automatically. When necessary, the owner can explicitly select a link-only destination without changing the calendar event. Confirming the already-assigned room retains automatic following of that room; an explicitly different override stays in place until corrected/cleared. A linked native Discord event's own channel is supported when Harmony's event has no assigned room. An announcement/calendar channel is never guessed as a fallback.

The member's button links directly to `discord.com/channels/<server>/<room>`, rather than the Discord Scheduled Event page. It uses the member's existing room access and grants no permissions. Text, announcement, voice and stage rooms are supported. Voice/stage rooms retain Discord's normal join controls.

## Staff controls and scope

The owner and members with Manage Server, Administrator or Manage Events can use this feature. It does not broaden access to the rest of the Schedule Manager or grant staff new Discord permissions. Private sessions are bound to their initiating user, guild and channel and expire after 20 minutes. Up to 25 members can be added or removed in each native searchable member selector; events are paginated in groups of 25.

Only the recipients reviewed when a scheduling form opens are enrolled by that form. Changes to the event day, time zone or destination settings while it is open require review again. Other members added in the meantime are not silently enrolled. Message timing is event-wide for the enrolled recipients, not a separate per-member clock.

Scheduling applies to the selected event occurrence. It does not automatically enroll members in every future occurrence of a series. A deliberate later Send Now is an additional request; it does not cancel an independently scheduled event-day message. Repeated clicks on the same Send Now button are deduplicated.

## Delivery and recovery

Three additive SQLite tables store event-specific routing/timing, selected members and durable delivery jobs. Existing calendar/reminder tables are not rewritten. There are no new dependencies or environment variables. The worker runs at startup and every 30 seconds, with sequential delivery and Discord.js's REST rate-limit queue.

Each scheduled event/member has one durable job. Manual Send Now operations use a saved operation key and recipient snapshot. Atomic claims, renewable leases and in-process locks prevent overlapping delivery. A DM-history boundary, channel and nonce are saved before sending. The message's link button carries a stable, non-visible numeric component ID, supported by the installed Discord.js and [Discord's component specification](https://github.com/discord/discord-api-docs/blob/main/developers/components/reference.mdx#anatomy-of-a-component). No extra visible recovery text or confusing second button is added.

If a send response or success checkpoint is lost, recovery checks the saved DM history for that bot-authored button identity before another send. History is paginated beyond the latest 100 messages; unavailable/incomplete recovery does not authorize another message. Restart recovery reuses the durable job and nonce. Persisted Retry-After deadlines cannot be bypassed by the staff Retry control.

Delivery rechecks the event, selected member and room access. Canceled/finished events and removed recipients are skipped. A person who has left the guild, a bot, someone without View Channel (or Connect for voice/stage), or someone with closed DMs is not falsely counted as delivered. No permission changes or public-channel fallback occur. Known DM/access refusals require an explicit retry after correction; temporary failures retain backoff and recovery state.

Unsent schedules follow an event's revised day/time zone and normal room assignment. Already-sent scheduled jobs are not rearmed by a reschedule. Late startup can catch up on the event's local day while it is still eligible; it does not send yesterday's forgotten messages. Changes/removals during preparation are checked again immediately before the send. A REST send already accepted by Discord cannot be recalled by a later Stop action.

## Verification and self-review

- **Full Harmony regression suite: 1,031 passed; 0 failed; 0 skipped.**
- **Focused scheduling/room-link suite: 176 passed; 0 failed; 0 skipped.**
- **New room-link tests: 26 passed**, including actual installed Discord.js payload serialization.
- [Executed focused and full output](test-results.txt). Existing scheduler tests share database fixtures, so the final focused/full runs use isolated databases and serial execution.
- JavaScript/Python syntax checks and `git diff --check` passed.

Tests cover the private creation/enrollment/scheduling/Send Now workflow; no RSVP dependency; staff/guild/session authorization; member and event pagination; component/content limits; actual direct room URLs; time zones, adopted UTC presentation and DST gaps; duplicate clicks/concurrent workers; restarts and leases; lost send responses and success checkpoints; recovery beyond 100 DMs; rate-limit preservation; closed DMs; missing room/access; left/bot members; cancellation/removal/finish; stopping schedules without disabling Send Now; room correction; reschedules before and after preparation; reviewed-recipient isolation; stale scheduling forms; and additive migrations.

Self-review corrected a room-confirmation edge case so it does not freeze an unnecessary destination override, bounded private status text to Discord limits, and protected the recipient/time-form snapshot against concurrent changes. Existing personal reminders, Interested responses, calendar behavior, countdown graphics and image-only countdown delivery remain intact. The implementation adds feature entry points and exports an existing presentation-timezone helper; it does not rebuild the scheduler.

## UI previews

These are labeled illustrations rendered from **actual serialized production payloads with offline fixtures**, not live Discord screenshots. The fixture member is named Mary only in the illustrations. The JSON retains the exact original component/text data; timestamps/mentions are resolved for readability by the preview script.

| Screen | Desktop | Mobile |
| --- | --- | --- |
| Schedule Manager entry | [View](entry-desktop.png) | [View](entry-mobile.png) |
| Staff event controls | [View](staff-desktop.png) | [View](staff-mobile.png) |
| Member's one-button DM | [View](member-desktop.png) | [View](member-mobile.png) |

[Exact payloads](payloads.json). Reproduce with `node scripts/preview-event-room-links.cjs`, then `python3 scripts/render-event-room-link-previews.py`.

## Release status and remaining limits

No production database, permissions, actual member enrollment or real Discord messages were modified. No real DMs were sent; all sends in tests use Discord doubles. No merge or deployment was performed.

A separately authorized live check is still needed to observe actual desktop/mobile navigation and DM delivery for one consenting test recipient. Closed DMs and missing channel access remain Discord restrictions, which the staff screen reports. If the event has no usable room assignment, staff must select its room rather than Harmony guessing. Schedule choices persist, but a new recurring occurrence must be configured separately.
