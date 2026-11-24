# Concert Countdown Manager simplification — Q review

**Implementation complete; do not merge or deploy.** Branch: `feat/countdown-manager-simplification`. Based on merged main `9a1b350ac495c1d29620c20ced3a143c924ad3db`, including PRs #327, #328 and #329.

## Delivered workflow

The existing Control Center Countdown button opens a private manager with exactly **Configured Countdowns**, **Add Countdown** and **Search for New Concerts**, plus back navigation. Closing this private view returns to the underlying Control Center.

Creation now follows **Add Countdown → Select Concert → Confirm Setup & Upload Photograph → Preview → Approve & Publish**. Location selection is searchable by city, country, venue or date, grouped by city/venue, paginated in groups of 25, and marks already-configured locations. Selecting an already-configured location opens its management screen, or the configured list when multiple rooms use that location; it does not overwrite settings.

Setup fills city, country, venue, venue timezone and every approved date at that venue together. Missing source-confirmed calendar dates have a private approval review before previewing; no calendar records are silently created. The existing 12-date-per-graphic limit is preserved, with date correction available. Each selected date remains inside the same graphic.

A suggested room is shown only when exactly one matching, unconfigured text room exists. Multiple matches or an unavailable room listing leave the room unassigned for owner selection. The owner can correct the room, venue fields or dates. Correcting the room of a newly saved private draft atomically moves its saved photo/configuration rather than leaving another draft. A published countdown, in-flight delivery, active lease, stale revision or occupied destination cannot be moved or overwritten through setup.

Upload Photograph and, when available, Reuse Photograph are on setup. New countdowns default to daily updates on, with an immediate toggle. There is no owner-facing Save Configuration step in creation. Drafts save internally when needed for photographs or preview. The new draft's selected update preference is retained as setup metadata; drafts are not enabled for scheduling merely by previewing them. Reopening a saved new draft resumes setup with its photograph, dates and preference intact.

Preview generates the real PNG privately and displays **Approve & Publish** and **Edit / Back**. Publication uses that room, saved revision and reviewed automatic-update choice. The chosen preference is persisted only when publication is explicitly approved, before Discord delivery can succeed, so a restart after delivery cannot lose it. Failed publication retains approval/retry controls and reuses the saved message. Real configuration changes invalidate approval. Operations are guarded against overlapping setup/photo/search/preview work, and a configuration edited by another administrator during rendering cannot be approved against the old preview.

Success offers **Create Another Countdown**, **Configured Countdowns** and **Back to Countdown Manager**. Configured countdowns show city/venue, publication and update status, with selection into the existing management controls: details/dates, photo replacement/reuse, private preview, update toggle, Refresh Now, Publish / Repair, Check room access, last success and errors.

## New concert search and approved import

The dedicated section separates **Check Official Sources** from the static **Tour Reference & Audit** and **Upload Confirmed Dates** tools. Check Official Sources actually calls Radar's existing bounded JYPE notices and Sony Japan readers. It does not invoke Radar channel delivery, write Radar settings/discoveries, send public messages or modify the calendar.

Results retain their official announcement URLs and original text. The owner reviews an announcement, confirms city/country/venue/timezone and concert dates, then sees the existing calendar reconciliation plan before **Approve calendar import**. The original source URL is retained on calendar records and tour provenance metadata. Existing records are reused; duplicate, ambiguous, canceled and stale-review protections are unchanged. No search result is automatically imported, scheduled or published.

Searches share work per guild, enforce a local cooldown and provider Retry-After, report unavailable/partial sources, and retain bounded-reader continuation in memory for the next check. Only unambiguous single-location matches and explicit valid ISO dates are suggested. Multi-city announcements, unfamiliar venues and poster-only schedules require owner confirmation instead of guessed assignments or dates.

## Validation

- **Full Harmony regression suite: 1,005 passed; 0 failed; 0 skipped.**
- **Focused countdown/tour suite: 147 passed; 0 failed; 0 skipped.**

JavaScript/Python syntax checks and `git diff --check` passed. [Executed focused and full output](test-results.txt).

Coverage includes the complete new creation sequence; automatic location/date population; city/country/venue/date search and pagination; unique/ambiguous room matching; already-configured locations; actual photo upload/reuse; reopening drafts; backward navigation; both update preferences; private generated PNG preview; publication retries; a failed pin repaired by the actual publication service in the same message; stale/cross-room approval; changes during rendering; safe draft room correction; existing configuration preservation; discovery HTTP readers; failure/partial/cooldown handling; provenance; and explicit idempotent import.

The graph renderer, model/calculations, image-only public payload, permission checks, publication/recovery service and calendar import implementation are byte-identical to merged main. Existing regression tests also verify approved graphics and public-message behavior. No database migration, dependency or environment-variable changes were introduced.

Self-review found and corrected two persistence/race cases: room correction after saving a photograph must move only a private draft; slow rendering must not approve a subsequently changed configuration. Both have dedicated regression coverage.

## Actual manager UI previews

These are labeled desktop/mobile **review illustrations drawn from actual serialized Discord component payloads**, not invented UI mockups or live Discord screenshots. The private-preview image is produced by the real renderer with an explicitly synthetic local photo fixture. The additional-date discovery shown is deliberately fictional test data. No owner photograph or production configuration was used.

| Screen | Desktop | Mobile |
| --- | --- | --- |
| Home: three primary options | [View](home-desktop.png) | [View](home-mobile.png) |
| Grouped concert picker | [View](concert-picker-desktop.png) | [View](concert-picker-mobile.png) |
| Populated setup | [View](setup-desktop.png) | [View](setup-mobile.png) |
| Setup with saved photograph | [View](setup-photo-saved-desktop.png) | [View](setup-photo-saved-mobile.png) |
| Actual private graphic + approval | [View](private-preview-desktop.png) | [View](private-preview-mobile.png) |
| Publication success | [View](published-desktop.png) | [View](published-mobile.png) |
| Configured countdowns | [View](configured-desktop.png) | [View](configured-mobile.png) |
| Existing management controls | [View](management-desktop.png) | [View](management-mobile.png) |
| Discovery section | [View](discovery-desktop.png) | [View](discovery-mobile.png) |
| Discovery result review | [View](discovery-results-desktop.png) | [View](discovery-results-mobile.png) |
| Original announcement | [View](announcement-desktop.png) | [View](announcement-mobile.png) |
| Calendar import approval | [View](import-review-desktop.png) | [View](import-review-mobile.png) |

[Exact manager payloads](manager-payloads.json). Reproduce offline with `node scripts/preview-countdown-manager-simplified.cjs`, then `python3 scripts/render-countdown-manager-simplified.py`.

## Remaining limits and release status

- Live discovery covers the last seven days of available **JYPE and Sony Japan** listings, not every worldwide promoter or ticket seller. Long/partial traversals continue within the running process; search results and continuation reset on restart. This is a private source check, not a new durable inbox. Existing Radar tracking is unchanged.
- A separate read-only live probe attempted both official readers during implementation. Both returned partial listings and no matching announcements in that bounded attempt. This does **not** establish that no new dates exist, nor verify a complete live discovery-to-import cycle. Deterministic tests exercise both real readers over HTTP response fixtures and the complete approval/import workflow.
- Poster-only dates, unfamiliar venue metadata, multiple city announcements and non-ISO date text need owner confirmation in the review form. The UI states these limits; publication timestamps are not used as concert-date evidence.
- Existing inactive/canceled-date handling and the 12-date limit remain in force. A location whose approved calendar metadata is incomplete may need correction in setup.
- Native Discord desktop/mobile appearance and real permission/network behavior still need observation after deployment is separately authorized. Component/modal limits and actual installed Discord.js serialization are exercised offline.

No production database, published countdown, room assignment, message ID, pin, owner photo, existing update setting or Discord permission was modified. No public message was sent. **No merge or deployment.** Existing countdowns require no reconfiguration.
