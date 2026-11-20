# Historical Welcome Pass links for returning members

Companion to the Welcome Pass app's member-departure workflow. No Discord roles, member counts, greetings, calendars or social integrations are changed.

Authenticated POST /welcome-pass/departed accepts an existing confirmation code from the authorized app. In one SQLite transaction it copies the code's entire active link (guild_id, user_id, linked_at, assigned_at) into new welcome_pass_departures history with departed_at, then releases the active pointer. The approval row remains untouched and getWelcomePassAssignment exposes the archived link/approval history. Repeated callbacks preserve the first archive unchanged. Unlinked departures are recorded too so old confirmation codes cannot be claimed later.

This additive CREATE TABLE IF NOT EXISTS migration is idempotent and does not alter/drop existing tables. Active UNIQUE(guild_id,user_id) behavior remains; a returning member gets a new pass/code and a new active link. Historical codes reject approval and /harmony-pass reuse; startup reconciliation excludes them. Current-member assignment/conflict checks and existing grant mode/message idempotency remain intact.

The endpoint never kicks a member, removes/adds a role or posts admission/departure messages. It does not change weekly activity tracking. The app's private reason/note does not cross this endpoint; only code is transmitted. Approval/assignment in progress rejects retirement for safe retry.

The app preserves the complete departed Firestore record in a separate admin view, appends reason/note audit history, and does not expose Restore. Older departed Firestore records can be reconciled only by an authenticated app action confirming the exact conflicting old code as departed; no manual production backfill is performed.

Future rollout requires this Harmony change before the app change. Neither is deployed/merged by this work. The separate AI Studio Preview/source mismatch remains unverified; this history change is not presented as a fix for that runtime issue.
