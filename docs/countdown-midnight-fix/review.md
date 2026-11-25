# Daily countdown fix — Q review

## Result

The countdown worker now wakes for the earliest concert venue's next local midnight, a saved failure retry, a pending rendering upgrade, or restart recovery. It does not scan once a minute. In-process countdown saves, photographs, publication checkpoints and automatic-update changes rearm the timer. Only due rows load photographs or call Discord. The short lease heartbeat remains solely while an update is running.

Normal midnight transitions subtract one calendar day by recalculating against the actual approved concert date. Startup recalculates every enabled published countdown whose last successful update belongs to a different local date; missed days are caught up in one edit. IANA timezone boundaries handle daylight changes without a fixed 24-hour interval. Failed edits retain the existing durable retry deadline and recovery protections. Invalid saved metadata receives a five-minute backoff. Completed/unchanged images still checkpoint the new day and cannot create an immediate retry loop inside the prior six-hour health window.

New setups already default to automatic updates On; this behavior is retained and tested. Existing enabled/disabled preferences are preserved. Disabled cards still receive any already-authorized, pending versioned rendering upgrade once. Unpublished configurations are excluded from automatic publication. Refresh Now, explicit Publish / Repair, ownership checks, nonce recovery, message IDs and pins retain their existing paths. No changes to the renderer or graphic version, photos, calculations, calendar approvals or database schema.

## Toronto and Vancouver

The bundled reference contains 34 city/venue groups, sorted alphabetically. Toronto and Vancouver fell in the nine locations beyond the first native dropdown's 25-option limit. The existing next-page path was functional in fixtures; neither city was absent from the reference. Add Countdown now exposes both 25-or-fewer-option menus together, so all 34 bundled venue groups are visible on the same screen. The same setup, search and approval workflow remains. Further locations beyond 50 still paginate. Search by city/country/venue/date remains intact.

Every bundled group is compared against the actual Add Countdown options in regression tests. Toronto/Vancouver tests cover selection, venue/timezone population, default automatic updates, reuse of approved event IDs, all-date population, explicit confirmed imports and repeated-import duplicate prevention. Simply viewing or selecting a missing location never imports or publishes it.

## Midnight evidence

The offline integration script uses the real SQLite store, update service and Python PNG renderer, with only Discord transport mocked. These are successful in-place update executions, not just date arithmetic assertions:

| Venue zone | Before UTC / local date | Midnight UTC / local date | Countdown | Result |
| --- | --- | --- | --- | --- |
| Toronto | 2027-06-24 03:59:59.999Z / June 23 | 2027-06-24 04:00:00Z / June 24 | 2 → 1 (Tomorrow) | One existing-message edit, same ID and pin |
| Vancouver | 2027-05-18 06:59:59.999Z / May 17 | 2027-05-18 07:00:00Z / May 18 | 2 → 1 (Tomorrow) | One existing-message edit, same ID and pin |

[machine-readable evidence](midnight-evidence.json), [Toronto before](toronto-before.png), [Toronto after](toronto-after.png), [Vancouver before](vancouver-before.png), [Vancouver after](vancouver-after.png).

Actual Add Countdown component payload: [picker-payload.json](picker-payload.json). Expanded-list review illustrations: [mobile](picker-mobile.png), [desktop](picker-desktop.png). Illustrations use test data and are not native Discord screenshots.

Reproduce evidence without network or production access:

```sh
node scripts/preview-countdown-midnight.cjs
python3 scripts/render-countdown-midnight-picker.py
```

## Tests and self-review

Executed results and commands: [test-results.txt](test-results.txt). Focused coverage includes local midnight, 23/25-hour Toronto days, Vancouver's current year-round UTC−7 rules, multiple zones/dates, D-day/completed states, multi-day restart catch-up, failed midnight edits, exact rate-limit timers, disabled preferences, unpublished drafts, manual refresh, renderer upgrades, persistent leases, in-place edits and duplicate prevention. Manager tests retain the creation/publication/default-on regressions.

Self-review caught and corrected the unchanged-image midnight case: the old six-hour shortcut could otherwise skip its daily checkpoint and continuously schedule immediate work. A same-day failed manual refresh must also bypass that shortcut to clear its error on a successful retry. Model/metadata failures and active lease contention were also reviewed to avoid tight retries or overwriting another worker's checkpoint. Releasing a manual update lease also rearms the timer so a saved short retry is not delayed until the former lease expiry. The timer has no idle minute poll and unsubscribes when stopped.

## Production verification limits

Read-only Railway runtime-log inspection found the service's latest deployment successful and no countdown worker failure entries in the returned filtered history. Those logs do not expose per-countdown enabled state, daily checkpoint or attachment contents, so they cannot establish why the owner's particular existing card appeared stale. No production database was accessed and no Discord messages were changed by this implementation. Existing enabled published rows are verified through the real update path with persisted fixture configurations and restart tests; live midnight delivery must be observed after a separately authorized deployment. This PR has not been merged or deployed.

Timezone note: tests ran on Node 24.22.3 with IANA tzdata 2026e. Vancouver now retains UTC−7 year-round; source: https://news.gov.bc.ca/releases/2026AG0013-000209 . The application uses the runtime's IANA rules rather than hardcoded Canadian offsets; deployed runtime timezone data must remain current.
