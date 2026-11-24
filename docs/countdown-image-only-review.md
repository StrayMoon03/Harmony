# Countdown presentation: image only

For Q review. **Do not merge or deploy.** This change is based on [PR #328](https://github.com/StrayMoon03/Harmony/pull/328), commit `8f11d2fa8d73d1e9873db6008b477e368eba3df8`, which depends on [PR #327](https://github.com/StrayMoon03/Harmony/pull/327). The draft PR targets the #328 branch to isolate this correction. Both parent changes remain unmerged at implementation time.

## Result

Countdown messages now contain only the approved PNG. Both the city/date summary and the visible `Youtiful STAY • World Tour Countdown` recovery footer are removed from message content. The approved wording **inside the graphic** is unchanged.

| Discord field | New payload |
| --- | --- |
| Content | Empty string, explicitly clears existing text on edit |
| Embeds and components | Empty arrays |
| Attachments | Exactly one rendered PNG; previous attachment replaced on edit |
| Attachment description | City, venue, selected dates and countdown states, up to Discord's 1,024-character limit |
| Attachment filename | Stable `harmony-countdown-<SHA-256 of guild/room identity>.png` |
| Allowed mentions | None |

The filename is attachment metadata, not visible companion text, an embed or an invisible-text message footer. Identification also requires Harmony's own author ID. The same filename is used for initial sends, edits, pin recovery and paginated delivery recovery. A different room's attachment or a member copying the filename cannot be adopted. A stored ID that points at an unrelated message fails closed without editing it or sending another message.

Existing visible legacy markers remain recognized **on incoming messages only**, including the older room-suffixed form. Updating those messages removes their text and installs the new attachment identity. This lets already-published messages and interrupted older deliveries transition without losing recovery protections.

## Automatic correction

The existing rendering/presentation checkpoint is bumped to `countdown-card-v3-image-only`. It is included in fingerprints and the published-message work scan from #328. Even unchanged dates/numbers or a recently checked image cannot suppress this correction.

After a separately authorized deployment, startup and the existing 60-second worker include every pending published countdown, including automatic-updates-disabled rows. Each valid existing message is edited in place. Message ID, pin, saved photo and photo library, selected dates, configuration, venue, timezone, revision and automatic-update setting remain intact. Disabled countdowns remain disabled and leave the refresh queue after successful completion. No owner republishing, reconfiguration, re-uploading or pin changes are needed.

The version checkpoint is saved only after successful editing and pin verification. Failed edits or checkpoint writes remain pending and retry with persisted backoff, including Discord rate limits, across restarts. Existing database leases, in-process locks, nonce enforcement, delivery checkpoints, paginated recovery and fail-closed history checks remain in place. Draft configurations are not automatically published. Existing recovery for a genuinely deleted Discord message is unchanged; an already-deleted ID cannot be preserved.

No schema, dependencies, environment variables, permission grants or Python graphic-renderer changes were needed.

## Verification

- Focused countdown/tour suite: **129 passed; 0 failed; 0 skipped.**
- Full Harmony regression suite: **987 passed; 0 failed; 0 skipped.** [Executed output](countdown-image-only-tests.txt).
- New assertions cover actual preview/send/edit payloads: empty content, no embeds/components, one image, accessible descriptions, stable identity and mention suppression.
- A test uses the installed Discord.js `MessagePayload` implementation to verify actual serialized empty content, file identity, attachment descriptions and unchanged image bytes.
- A legacy disabled published fixture is upgraded in place with all owner data preserved, even with a matching image fingerprint and recent check; the next scan after restart does nothing.
- Image-only pin recovery and lost-send-response recovery beyond 100 chat messages reuse the original message ID. Wrong-room and wrong-author attachment identities are rejected. Unrelated stored messages are not overwritten or duplicated.
- Existing tests cover transient failures, rate-limit cooldowns, interrupted checkpoints, restarts, concurrent updates, unpublished drafts, added dates, pin repair, permissions and normal enabled updates.
- All seven saved #328 graphic examples, including single/multiple dates and tomorrow/concert-day/completed states, are **byte-for-byte unchanged**. Existing photo rendering and layout tests also pass.
- JavaScript syntax checks and `git diff --check` passed. Self-review verified all send/edit paths and both recovery formats; no other Harmony feature implementation changed.

The graphic examples remain available in [the existing review gallery](countdown-single-date-fix/review.md). No new image design was generated.

No production records, photographs, Discord permissions or Discord messages were accessed or modified. Tests use isolated databases and Discord doubles, plus the real offline serializer and renderer. Live Discord presentation and startup refresh remain to be observed after separately approved deployment. **Nothing was merged or deployed.**
