# Countdown publication permission and retry fix

Branch: `fix/countdown-publication-permissions`, based on merged PR #326. **Do not merge or deploy.**

## Reproduced causes

| Problem | Confirmed implementation defect | Correction |
| --- | --- | --- |
| Generic permissions error despite an allowed role | `channel.permissionsFor(client.user)` depends on cached bot membership. When that member is absent, Discord.js returns `null`; Harmony treated this as a denial of the whole required-permission list. Cached role grants/overrides could also be stale. | Force-fetch Harmony's own guild member, current server roles and selected channel/overrides, then call Discord.js with the actual `GuildMember`. |
| Retry says configuration changed | The manager deleted the approved revision before it attempted publication. Any failure left that approval undefined even though the saved configuration revision had not changed. | Retain approval after failures and retry delays; consume it only after successful completion. |

The cache failure is reproduced with actual installed Discord.js objects and mocked REST responses: the original lookup returns `null`, while the corrected fresh lookup reports all five permissions allowed. This is a verified failure path, **not a claim that live Chicago permission data was inspected**.

## Effective permissions and compatibility

Installed Discord.js **14.27.0** supports the dedicated **Pin Messages** permission as a BigInt (`1n << 51n`) and uses the current message-pins API route. No dependency upgrade or Manage Messages fallback is needed. Manage Messages alone is not accepted as a substitute.

The new check uses:

- `guild.members.fetchMe({ force: true })` for the bot, rather than the acting administrator or a cache-only user lookup.
- `guild.roles.fetch()` for current inherited role grants.
- `guild.channels.fetch(roomId, { force: true })` for current room overrides.
- `channel.permissionsFor(botMember)` for Discord.js's own precedence calculation.

Tests cover @everyone grants/denies, inherited role allows, role denies, multiple-role allow precedence, member overrides, category-synced and unsynced children, Administrator bypass, cold member caches and stale grants. No role hierarchy shortcut or manual permission bitfield reimplementation is used.

Failures identify **only the actual missing permissions**. **Check room access** privately lists all five results and identifies member, role or @everyone denials where applicable. An unavailable calculation is distinguished from a missing permission.

Discord API refusals name their operation (reading history, sending, editing or pinning) and code. A read-only recheck distinguishes a newly missing flag from the case where all five flags currently resolve as allowed but Discord still refuses the operation. It does not guess an absent permission in that latter case. If a message was saved before pinning failed, the error explicitly explains that retry will reuse it.

All new permission operations are **GET-only**. Nothing grants permissions, changes roles, copies category overrides or edits channel overrides.

Primary compatibility references:

- [Discord permissions](https://docs.discord.com/developers/topics/permissions)
- [Current Pin Message endpoint](https://docs.discord.com/developers/resources/message#pin-message)
- [Official permission-split notice](https://discord.com/developer-newsletter/december-2025)
- [Discord.js 14.27.0 GuildMemberManager](https://discord.js.org/docs/packages/discord.js/14.27.0/GuildMemberManager:Class)

## Safe retry behavior

After an error, the manager retains approval for the **same room and saved revision** and shows **Retry publication** and **Check room access**. Retrying does not require re-entering dates, uploading the photo again or modifying the configuration.

A genuine configuration or photograph change still invalidates the old approval. The service rechecks the expected revision after acquiring its database lease, closing the race where another administrator changes settings during the interaction acknowledgement. Canceling publication clears approval. Overlapping clicks cannot start another attempt or overwrite the first interaction's result.

A nullable, additive `retry_kind` metadata field distinguishes permission/transient backoff from real Discord rate limits. Explicit manual retries can bypass permission/transient application backoff; scheduled jobs still honor it. Genuine rate-limit deadlines remain enforced, including when saving a new photo or configuration. Legacy generic permission errors are recognized; unknown older retry delays remain conservative. The UI shows the retry deadline using Discord's localized relative timestamp.

The existing delivery record, nonce, message ID persistence before pinning, database lease/heartbeat, in-process lock and paginated recovery remain in place. A lost send response or a failed pin can be retried without producing another message. No automatic initial publication was added.

## Verification

- **107 focused countdown/tour tests passed; 0 failed; 0 skipped.**
- **Complete Harmony suite: 965 passed; 0 failed; 0 skipped.**
- New tests use real Discord.js permission objects with REST doubles, in addition to the existing database/service/interaction tests.
- Covered retries include permission repair, lost send responses, partial publication/pin failure, deferred rate limits, actual photo changes, room changes, cancellation, overlapping clicks and edits during interaction acknowledgement.
- Saved dates/configuration, photographs, revision numbers and existing message IDs remain intact across publication failures. Repeated publication retains one managed message.
- [Executed focused and full test results](test-results.txt).
- `git diff --check` and syntax checks passed.

The approved image renderer, Python renderer, graphic design, calendar/tour data and other Harmony feature implementations are unchanged. Existing rendering tests and the full Radar, Calendar Review, Schedule Manager, Welcome Pass, member-count and background-job suite pass.

## Deployment and live verification

The database migration only adds nullable retry metadata. No application variables, Discord permission grants or additional runtime packages are required.

No production credentials were used by the tests. No live Discord permissions, countdown messages or production records were modified. There was no merge or deployment. Actual Chicago bot membership/overrides and successful end-to-end publication still require a separately authorized live check; they cannot be proven from isolated test data.

After deployment is separately approved, the owner can open the saved Chicago countdown, choose **Check room access**, then use **Publish / Repair** or **Retry publication**. Existing dates and the venue photograph can stay saved. If Discord rejects pinning after sending the image, retry repairs the same saved message.
