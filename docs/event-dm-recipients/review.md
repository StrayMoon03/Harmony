# Event DM recipient simplification — Q review

Replaces the separate add/remove selectors with **Manage DM Recipients**. The private editor uses a checked Discord string-select list, at most 25 people per page, a name-search modal, paging, a selected count and one **Save Recipients** action. All human server members are available regardless of event interest. Nicknames, global names and usernames are searchable; accents are normalized. Duplicate display names show usernames.

Selections are retained across search, pages and Back/reopening in the same private session. Saved selections reload from SQLite across new sessions and restarts. Unsaved edits expire with the existing 20-minute private session; use Save Recipients to persist them. Existing unavailable member IDs remain selected and removable rather than being silently discarded.

Save freshly validates new members and atomically applies only the additions/removals. Retained rows preserve schedule flags and audit data. No send, enqueue, reconcile or retry operation runs from Save. Removal keeps the existing behavior of cancelling that member's pending jobs; sent records and in-flight recovery checkpoints stay intact. Newly added recipients keep the existing Send Now-only default until explicitly scheduled. Concurrent staff edits reject Save and require reopening the latest saved list. Old internal add/remove handlers remain for compatibility but have no owner-facing controls.

Delivery service, DM payload, schedule calculation, room-link resolution and receipt handling are unchanged. No schema migration, production writes, public messages, merge or deployment.

## Validation

- 43 event-room-link tests pass, including 10 added recipient-management regressions.
- Final full-suite and focused scheduling results are recorded in test-results.txt.
- Syntax checks and git diff --check pass.
- Self-review covered atomic persistence, no-op saves, bot/departed/cross-server validation, stale menus/sessions, multi-page selections, concurrent edits, restart persistence, retained schedule flags and delivery nonce/message-ID preservation.

## UI previews

`payloads.json` is produced by the actual manager builders/handlers using an isolated test database and mocked member roster. `main-*`, `recipients-*`, and `search-*` PNGs illustrate the payloads on desktop/mobile. Expanded dropdown illustrations show the first six options only. These are labeled offline review illustrations, not live Discord screenshots.

Reproduce:

```sh
node scripts/preview-event-dm-recipients.cjs
python3 scripts/render-event-dm-recipient-previews.py
node --test test/eventRoomLinks.test.js
```

## Remaining limits

Discord supports 25 options per string-select, handled with pages and search. The editor loads the guild member roster using Harmony's existing GuildMembers intent; a Discord roster-fetch failure leaves saved recipients unchanged. A live Discord client check remains for after an authorized deployment; this change has not been deployed or used to send test DMs.
