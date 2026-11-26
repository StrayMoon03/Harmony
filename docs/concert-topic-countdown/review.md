# Concert channel topic countdown — Q review

Adds the current countdown to each concert room's native channel topic. The approved image renderer, image-only public message, calendar calculations, simplified manager controls and publication/duplicate-recovery paths are retained.

## Topic examples

Single date:

> 🧡 205 days until Chicago! 🖤

Two dates:

> 🧡 Day 1: 205 days | Day 2: 206 days 🖤

Mixed concert states:

> 🧡 Day 1: Completed | Day 2: Concert day! 🖤

[All six actual text examples](previews.md) · [machine-readable model output](previews.json) · [single-date desktop illustration](single-desktop.png) · [multiple-date mobile illustration](multiple-mobile.png).

Previews use the real countdown model, formatter and composition code with isolated fixtures. PNGs illustrate a native topic header; they are not live Discord screenshots. Mono heart glyphs in the illustrations represent the actual orange/black emoji in the JSON/text output. No graphic redesign was made.

## Updates and existing countdowns

- Successful publication and Refresh Now attempt the topic after the graphic is saved and pinned. Private previews and unpublished drafts never edit a topic.
- Daily topics use the same approved date model and venue-local midnight schedule, including missed-day restart catch-up and daylight changes. Selecting additional approved dates also updates the topic on the current day.
- A separate `concert-topic-v1` checkpoint adds the topic once to every existing published configuration after deployment. This includes disabled configurations; they retain their disabled flag and stop daily topic changes after that one-time addition. Disabled cards still support explicit Refresh Now.
- Topic metadata, retry deadlines, burst history and independent topic leases survive restarts. Additive migrations leave existing configurations, uploaded photos, revisions, message IDs, publication timestamps and image rendering checkpoints intact.

## Failure isolation and permissions

Manage Channels is checked using Harmony's freshly resolved member, inherited roles and room overrides. It remains optional for the pinned graphic. Existing Check room access shows it separately from the five image permissions. The private management screen and private publication result report topic errors and waiting states. No permission is changed automatically.

Graphics and topics have independent leases, status and retry checkpoints. All due graphics finish before topic work begins. The live midnight timer does not await optional topic PATCHes, so a slow or failed topic edit cannot stop subsequent automatic graphic updates or Refresh Now. Topic failures leave `last_success`, image fingerprints, message IDs and pins intact. Only the existing managed image can be sent/recovered by the original publication workflow; the new module sends no messages.

Discord.js applies REST rate limiting. A conservative persisted per-room budget additionally allows at most two topic PATCH attempts in a rolling ten-minute window. Server retry deadlines remain authoritative and cannot be bypassed by Refresh Now or restart. Repeated unchanged topic text makes no PATCH request. Fixed permission/content problems can be checked again manually without waiting out a local validation backoff.

## Preservation and limits

The topic is fetched freshly during the permission check. Harmony moves its exact managed line to the top and keeps unrelated text and whitespace. Saved previous/pending text identifies a prior edit even if Discord applied it but the response was lost; retries remove known duplicate copies and retain one current line.

Text is conservatively limited to 1,024 UTF-16 units. If every selected date plus existing room information cannot fit, the original topic stays intact and the private manager explains the space problem. No dates or unrelated text are truncated. Unrecognized countdown-like text, or a managed line mixed into unrelated prose, is kept for review rather than overwritten or duplicated.

Discord's channel modification API has no conditional revision/CAS field. A human editing the topic in the brief interval between Harmony's fresh read and PATCH can still race with the update; avoid simultaneous topic editing. Known edits that are present at the fresh read are preserved. Topic visibility/expansion follows the Discord client's desktop/mobile layout.

## Verification and self-review

Executed commands/results: [test-results.txt](test-results.txt). Coverage includes:

- Exact single/multiple formats, 12 dates, singular day wording, concert day, completed/mixed states, Unicode names and no-active-date state.
- Publication, midnight transition, same-day date additions, restart catch-up, disabled one-time adoption and manual refresh.
- Private previews and unpublished configurations remaining private; unchanged primary controls.
- Fresh Manage Channels checks, REST refusal, lost topic responses, durable failure/429 retries and persisted local burst limits.
- Exact preservation of unrelated text, length boundaries, ambiguous ownership, deduplication and concurrent requests.
- Same pinned message ID, photo/config/revision/pin preservation; independent graphic success and permission failure reporting.
- Manual and automatic graphics continuing while a topic PATCH is blocked; independent timer scheduling and leases.

Self-review corrected expired local cooldown scheduling, same-day topic invalidation after selected-date changes, permission/content manual retries, and separation of topic locks/requests from the graphic timer. The final focused suite and full regression suite are recorded in the linked result file.

Reproduce previews:

```sh
node scripts/preview-concert-countdown-topics.cjs
python3 scripts/render-concert-topic-previews.py
```

API reference: https://github.com/discord/discord-api-docs/blob/main/developers/resources/channel.mdx (Modify Channel, Manage Channels, topic length). Installed Discord.js `BaseGuildTextChannel.setTopic` sends a topic-only edit with an audit-log reason.

No production data or Discord topics/messages were modified during implementation. Live Discord header verification remains for a separately authorized deployment. **DO NOT MERGE OR DEPLOY.**
