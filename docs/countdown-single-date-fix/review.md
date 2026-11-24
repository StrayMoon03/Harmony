# Concert countdown single-date correction

Completed 2026-11-24 on `fix/countdown-single-date-refresh`. **For Q review only; do not merge or deploy.**

This is a separate dependent change based on the still-open publication permission/retry fix, [PR #327](https://github.com/StrayMoon03/Harmony/pull/327), commit `db049df1c7ba7eb6dd04099b5cfd0e169cdb2d6d`. The draft PR targets that branch so its diff contains only this correction. Review both changes; the parent must be included before this change can reach main. No dependency versions or application variables changed.

## Graphic correction

Single-date cards omit DAY 1 and vertically center the visible number/state/date text within the existing panel. Font sizes, colors, spacing between text elements, panel rectangle, photograph placement, orange border, hearts, footer and overall dimensions remain unchanged. Upcoming, tomorrow, concert-day and completed states retain their existing wording. Multi-date cards retain every DAY label, including DAY 3 in a centered final panel.

The single-date comparison proves that every changed pixel lies inside the original countdown panel. The two-date renderer output is byte-for-byte identical to the existing approved fixture. Render tests also cover two, three and five dates and vertically centered single-date content in every state.

Actual production-renderer examples use explicit fixture clocks and the existing no-photo placeholder. They are visual test data, not new tour announcements or production calendar imports. Uploaded production photos were not accessed or changed.

| Example | Actual rendered PNG |
| --- | --- |
| Single date, before | [Before](single-before.png) |
| Single date, after | [After](single-after.png) |
| Two dates, same graphic | [Chicago](two-dates.png) |
| Three dates, same graphic | [Three dates](three-dates.png) |
| Tomorrow | [Tomorrow](single-tomorrow.png) |
| Concert day | [D-day](single-d-day.png) |
| Completed | [Completed](single-completed.png) |

Reproduce with `node scripts/preview-countdown-single-date.cjs`. The script uses the original renderer from the parent commit for the before image and the current production renderer for the remaining images. [Exact render inputs](render-inputs.json).

## Automatic correction of published messages

Renderer identity is now part of the image fingerprint. The additive SQLite migration adds a nullable `render_version`; existing rows remain pending until successfully refreshed. This version is `countdown-card-v2-single-date-centered`. Future renderer changes must bump the exported version constant.

The existing worker runs at startup and every 60 seconds. Its metadata-only scan includes enabled countdowns and previously published countdowns with an older rendering version, including disabled ones. The refresh does not enable automatic updates or change the configuration revision, photo, selected calendar IDs, venue or timezone. Draft configurations and incomplete initial-publication intents without publication evidence are not published by this refresh.

The worker edits the existing managed message and retains its ID and pin. It uses the existing permission checks, locks, database lease/heartbeat, message ownership checks, delivery recovery, nonce, message-ID checkpoint and pin repair. Existing recovery for a genuinely deleted Discord message remains unchanged; an ID that no longer exists cannot be preserved. No new duplicate-message path is introduced.

The new version and fingerprint are committed together only after the message update and pin check succeed. A failure leaves the old version pending. Persisted retry deadlines, including Discord rate limits, are honored; scheduled version refreshes cannot bypass them. Work is sequential and the Discord.js REST queue remains responsible for API rate limiting. Restarting after a failure retries the same saved message; restarting after the image edit but before its checkpoint safely re-edits it. Once successful, a disabled countdown leaves the work list and stays disabled.

The owner does not need to reconfigure, re-upload, unpin or republish existing valid messages after a separately approved deployment. Adding dates still uses the existing saved configuration and refresh path: all selected dates appear in the same graphic and the same pinned message is edited, including when automatic updates are off.

## Verification and self-review

- **Focused countdown/tour suite: 121 passed, 0 failed, 0 skipped.**
- **Complete Harmony regression suite: 979 passed, 0 failed, 0 skipped.**
- [Executed test output](test-results.txt), using temporary test databases and Discord doubles.
- Rendering tests inspect actual Pillow draw operations and output pixels, including unchanged two-date bytes and all single-date states.
- Service tests cover disabled published upgrades, one-time completion, preserved IDs/pins/photos/configuration/revision/settings, unpublished drafts, restart recovery, failed edit and failed checkpoint retries, real rate-limit backoff, concurrent workers, added dates and normal enabled updates after the upgrade.
- An idempotent additive-migration test verifies that legacy saved records remain intact and are not incorrectly marked refreshed.
- Reviewed the complete correction diff against the parent commit: the Python change is confined to countdown-panel text; the scheduler changes reuse existing publication/recovery protections. A failed database checkpoint now names that stage rather than being misreported as a pin failure.
- JavaScript/Python syntax checks and `git diff --check` passed.

No production database, uploaded photograph, Discord message or permission was modified. No live refresh was attempted. The versioned startup refresh and real Discord rendering remain to be observed after deployment is separately authorized. There was no merge or deployment.
