# Concert countdown date-selection correction

Branch: `fix/countdown-tour-date-selection`, based on merged PR #324 and current `main` (`99076756ba27fb029ad7321cb02a5fab8e8bcf0e`). **Review only: do not merge or deploy.**

## Diagnosis and correction

The old picker read only existing `scheduled_events` rows with `calendar_type='stray_kids'` and `category='concert'`. Searching checked only title, free-text venue and the raw stored date. A date absent from the calendar could never appear; a mislabeled approved tour record was hidden; country names, venue aliases and venue-local dates were not indexed consistently. The manager offered no way to compare existing records with the announced tour or import missing dates.

The picker now groups concerts by city and venue. All locations in the verified tour reference are visible even when their dates have not been imported. Within a location it displays announced dates, whether import/review is needed, existing selectable dates and a Select all dates here button. Searches support city, country, venue, aliases (München/Munich, Wien/Vienna, Milano/Milan, Nanterre/Paris, Inglewood/Los Angeles), exact numeric dates and full English dates. Venue-local calendar dates are used for timed events. Different venues in Tokyo, Osaka and Seoul remain separate.

Already-approved Stray Kids calendar rows matching a confirmed venue-local performance date can be selected despite a mistaken legacy category. This does not silently rewrite calendar data. The optional advanced command and renderer model share the same eligibility rule. Other calendar records retain their original classifications until an administrator explicitly approves a repair.

## Complete tour coverage

The source-checked reference contains **53 performances, 31 cities and 34 venue groups**, including past announced performances and all current additions checked on **November 24, 2026**. Tests independently enumerate the expected city set and require every date to have an official source URL.

Additional dates include Chicago June 19; Paris July 10; London July 14; Munich July 18; Arnhem July 28, all in 2027. The Seoul Special dates announced today, January 1–2, 2027, are included. The two Tokyo runs and both Osaka venues are also represented. STRAYCITY, festivals, ticket-sale notices and unapproved Radar discoveries are not used as tour-date imports.

[Complete 53-date coverage checklist with official sources](confirmed-tour-coverage.csv) · [Import reference JSON](../../src/reference/strayKidsRunItTour.json)

Primary references checked:

- [Live Nation North America/Europe announcement](https://news.livenationentertainment.com/news/stray-kids-announce-2027-world-tour-run-it-across-north-america-europe-and-the-uk)
- [Live Nation current listings, including additional nights](https://web-a.origin.livenation.com/artist/K8vZ9179Vpf/stray-kids-events)
- [Live Nation Asia](https://www.livenation.asia/stray-kids-tickets-adp1182958)
- [Official Seoul announcement on FANS](https://app.fans/community/StrayKids/media/6vzo5j6v1x)
- [JYP Seoul Special notice](https://straykids.jype.com/notice/b6bj5grg)
- [STAY JAPAN original Japan dates](https://skz-stayjapan.com/s/n104/news/detail/13099)
- [Sony Japan Tokyo Dome addition](https://www.sonymusic.co.jp/artist/StrayKids/info/586376)
- [Sony Japan 2027 stadium dates](https://www.sonymusic.co.jp/artist/StrayKids/info/588400)

The JSON is a reviewed import reference, not a second active calendar. Countdown messages continue to use stable IDs and current dates from `scheduled_events`. Missing reference dates cannot be selected as published events until they are explicitly imported into that existing calendar.

## Safe reconciliation and imports

**Tour dates & calendar audit** opens a private, paginated review. It distinguishes ready records, existing records to link, classification repairs, missing dates, ambiguous matches, cancellations and reschedules. **Download full audit** includes current classifications, matches and source URLs. Paging preserves the reviewed snapshot; a calendar change invalidates approval instead of silently refreshing it.

On explicit **Approve calendar import**:

- Existing records are reused with their original IDs, timing, descriptions, links and reminders.
- Confirmed classification repairs change only `calendar_type` and `category`.
- Missing dates create date-only records in the existing Stray Kids calendar with the correct venue time zone and official source.
- Canceled records are not resurrected. Linked reschedules retain the current calendar date. Suspected unlinked reschedules, invalid-date matches and ambiguous duplicate records are skipped for manual review.
- One SQLite transaction and unique tour-to-event links protect repeated imports. Concurrent/stale approvals fail before writing. A mid-import failure rolls back all changes.
- No countdown configurations, photographs, message IDs, enabled states, scheduled announcements or Discord rooms are created or changed by the import. It does not publish calendar messages or countdowns.

The additive `concert_tour_events` table stores identity/location/source metadata and references existing calendar IDs; it does not store another set of active event dates. Ordinary countdown updates remain governed by their existing configuration.

**Upload confirmed dates** accepts a JSON file in the supplied reference format for future added dates/locations without a code change. Files are bounded to 512 KB and 200 dates, with valid dates/time zones, unique locations/physical dates, and HTTPS URLs on approved official-source domains. Files are downloaded only from Discord attachment hosts. Administrators must review the linked announcements before approval; schema and hostname validation do not establish the truth of an uploaded announcement.

## Verification and limits

- **75 focused countdown/tour tests passed; 0 failed; 0 skipped.**
- **Complete Harmony suite: 933 passed; 0 failed; 0 skipped.**
- Actual database tests cover all 53 dates becoming selectable, idempotence, existing classifications, partial calendars, exact date/country/alias search, local midnight conversion, multiple venues, cancelled/rescheduled dates, ambiguity, rollback, stale approvals, guild isolation, future JSON imports and preservation of existing countdowns.
- UI tests cover location pagination, Chicago missing-date review, approval, paired selection/autofill, uploads, authorization and stale panels.
- The full suite includes Radar, Calendar Review, scheduling, existing publications, Welcome Pass, member counts and background-job tests. Their production implementations were not modified.
- The approved graphic renderer, Python renderer, fonts and original PNG examples are **unchanged**. Existing actual-rendering tests pass.
- [Executed focused and full-suite results](test-results.txt).

[Location browser UI preview](manager-locations.png) · [Chicago before import](manager-missing.png) · [Private import review](manager-review.png) · [Chicago after approval](manager-ready.png) · [Actual component payloads](ui-payloads.json)

These are labeled UI illustrations from actual component payloads and an isolated test database. The Chicago classification/missing-record example is illustrative, not a claim about live production records.

**Production SQLite was not available in this workspace.** No live production classification counts or imports are claimed. A read-only command is included for Q to audit an available database without migrations or writes:

```sh
node scripts/audit-concert-tour.cjs --database /path/to/harmony.sqlite --guild SERVER_ID
```

The same reconciliation runs against live records when an authorized administrator opens the new private audit after a separately approved deployment. Actual Discord client presentation still requires a live smoke test. No merge, deployment, production import or live Discord mutation was performed.

## Owner workflow after deployment is separately approved

For a server-wide calendar check: open **Concert Countdowns → Tour dates & calendar audit**, review sources/changes, and approve the calendar import. This makes every unambiguous confirmed date available while preserving existing records.

For Chicago: **Add countdown → choose the existing concert room → Select concert dates → Chicago / Soldier Field**. If a date is missing, use **Review missing tour dates → Approve calendar import**. Choose **Select all dates here** to select both concerts; city, country, venue and time zone fill automatically. Save, preview, and approve publication separately when ready.

Use the same process for every other concert location. Future additions can be supplied through **Upload confirmed dates** and the same review/approval process.
