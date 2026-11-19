# Welcome Pass approval acknowledgment and member correction

This repair requires coordinated Harmony and `StrayMoon03/Youtiful-Stay-Welcome-Pass` changes. It does not deploy either application or repair individual production records.

## Confirmed defect

The Welcome Pass app's previous `app/api/admin/approve/route.ts` committed `status: approved` before attempting the Harmony callback. Missing configuration, fetch failures and non-success responses were logged but the route still returned `{ok:true}`. Already-approved records were then refused with 409, preventing the same UI action from retrying delivery. This fully explains false-positive approval UI without Harmony processing; the exact transport/configuration reason for Chantal's specific missing request cannot be determined from repository code or absence of Harmony logs alone.

## Contract

- Existing authenticated `POST /welcome-pass/approved` remains the admission path.
- A successful response explicitly includes `ok:true`, `recorded:true`, the unchanged confirmation `code`, `status` and `matchStatus`.
- Actual assignment failures return non-success. Recorded/pending outcomes return 202 and must be distinguished from STAY-role completion. Manual grant mode remains manual.
- The app uses a persisted short lease to serialize concurrent Approve/edit actions, sends the callback, validates the acknowledgment, then confirms Firestore approval. Failed/unknown outcomes preserve the pass and expose retry. Existing old approved records without acknowledgment are shown as unconfirmed and can retry; original approval audit fields remain intact.
- Lost acknowledgments retry with the same code. Harmony retains persisted assignment claims before admission messages, and coalesces concurrent assignment operations per code. Existing ambiguous-send behavior remains at-most-once: an uncertain Discord welcome send is not blindly replayed.

## Admin member correction

The existing web admin **Manage** dialog loads Harmony's current server roster into a member selector. IDs are the option values; usernames are labels, not editable identity fields. Pages of 100 raw Discord members remain reachable, with bots excluded from selectable results. No new Discord channel or control room is created.

The app proxies authenticated requests to two read-only Harmony bridge endpoints, derived from the existing approval URL's origin:

- `POST /welcome-pass/members`: paginated current roster (`after` cursor), limited to member ID/username/display name.
- `POST /welcome-pass/member`: validate confirmation code and a forced fresh member fetch; reject missing/bot accounts and conflicting existing pass links or reassignment of completed admissions.

Both use the existing shared bearer secret. The browser never receives that secret. Only signed-in app admins may use the proxy/save actions, and they select a recording admin name.

Saving selection preserves the original `discordName` and public confirmation code, records the chosen ID/username/guild and an append-only correction audit, and reserves the association transactionally against other passes. **It does not link/approve/grant in Harmony.** Explicit normal approval sends `discordMemberId`, validates membership/conflicts again, then links using the existing SQLite link table before existing approval/grant processing. `/harmony-pass` remains the self-service fallback.

Discord membership and Firestore cannot share one atomic transaction. Membership is checked freshly at save and again at approval; departures or failures fail closed. No claim is made that a member cannot leave immediately after a successful external check.

## Persistence and rollout

No Harmony SQLite migration or destructive update is required. The app adds `discordMemberId`, `discordMemberUsername`, `discordMemberGuildId` and `approvalDelivery` metadata as used, plus `welcomePasses/{id}/discordMemberCorrections` audit documents and `welcomePassMemberAssociations` reservation documents. Existing submissions, confirmation codes, approvals and birthday/bias data are preserved. No manual production writes/backfills are part of this repair.

On later owner-approved rollout, deploy Harmony first, then the Welcome Pass app. Existing `HARMONY_APPROVAL_URL` (HTTPS, exact `/welcome-pass/approved` path) and `WELCOME_PASS_SHARED_SECRET` must already agree. No new secret/env variable is introduced. The new sender deliberately refuses a legacy response without `recorded:true`.

Live approval/member-selection verification and determining the old app's exact callback delivery/configuration failure remain post-deployment work. Tests use isolated SQLite, transactional in-memory Firestore and mocked Discord, including actual HTTP between the two applications. The app's cross-repository test can be run with `HARMONY_TEST_REPO=/absolute/path/to/Harmony npm test`; it skips that one integration test when the sibling checkout is absent.
