# Resolved Welcome Pass submission identity

`POST /welcome-pass/submitted` retains its existing shared-secret authorization,
request fields, HTTP behavior and notification statuses. Successful responses may
now include an optional, server-resolved identity:

```json
{
  "ok": true,
  "status": "notified",
  "discordMember": {
    "id": "123456789012345678",
    "username": "mamascoobz",
    "guildId": "123456789012345679"
  }
}
```

The ID is saved in the existing `welcome_pass_links` table before notification.
This is an identity reservation, **not approval or admission**. No role or welcome
message is triggered by linking. Existing approval records and grant modes remain
authoritative. A later legacy approval reuses that link; Approve & Admit continues
to accept `discordMemberId` and verify the exact current member before admission.

Only a unique non-bot match across username/global name/display name is linked.
Normalization permits capitalization, whitespace and decorative emoji, while
preserving punctuation and Unicode letter identity. No fuzzy/prefix matching is
used. Collisions are rejected even when one alias is an exact username. Automatic
resolution cannot replace a code's existing identity or take another active pass's
pending/completed member. Explicit authorized corrections retain their existing
validation. Departed-pass protections remain in force.

Duplicate callbacks do not resend alerts. A saved identity is read by exact ID,
including after restart or username changes. If that account is no longer a current
human member, it is not returned or replaced by another name match. Identity also
survives a failed notification send; a later authenticated callback can retrieve it
without replaying the notification. No schema migration or historical backfill is
performed.

## Welcome Pass client follow-up

The optional response is backward compatible with clients that only read status,
but such clients will not automatically preselect the identity in Manage yet.
Inspection of CURRENT Welcome Pass main is still needed for that companion change:

1. In the existing application-submission notification helper, parse a successful
   authenticated `/welcome-pass/submitted` JSON response and validate its `ok` and
   `discordMember` shape. Return the identity rather than discarding the body.
2. Through existing association/conflict safeguards, retain the server-resolved
   `id`, `username`, `guildId` as `discordMemberId`, `discordMemberUsername`, and
   `discordMemberGuildId` on the same pass. Preserve the original `discordName`.
   Do not mark approval/admission acknowledged merely because identity resolved.
3. Expose the saved fields in Admin responses and initialize Manage's
   `selectedMember` from `discordMemberId`. Preserve unconfirmed-admission recovery
   and the existing exact-ID validation/Approve & Admit acknowledgment contract.

No database, Firestore target, URL, credentials or owner GitHub setup changes are
required by the Harmony-side contract. Do not resubmit or write production records
as part of development verification.
