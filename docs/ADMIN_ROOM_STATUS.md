# Admin Room Status / Health

## Current checks

`/harmony-status` and the **Status / Health** button on each Schedule Manager panel run a new local check when opened or refreshed. Discord connectivity, SQLite, Guard configuration, discovery state, and registered Scheduled Event listeners are checked independently. The check does not actively contact Instagram, Threads, Facebook, YouTube, or the discovery source, so it does not claim those external services are currently reachable.

The report uses only concise explanations and next steps. It never includes exception text, cookie contents, file paths, environment values, or credentials. A social platform is marked **Session needs refresh** only after a media request explicitly indicates login/session expiry. A security checkpoint or challenge instead requires owner attention. A subsequent successful media retrieval clears the in-memory signal. Other per-post failures do not count as proof that the platform itself is down.

## Current social session storage

`src/services/runtimeSecrets.js` accepts the four `*_COOKIES_BASE64` inputs, writes them to a mode-restricted temporary directory, and sets the corresponding `*_COOKIES` path for the process. It logs only whether preparation succeeded, never the values.

| Integration | Current source used by media code | What Status can verify |
| --- | --- | --- |
| Instagram | `INSTAGRAM_COOKIES` file, with a local `instagram-cookies.txt` fallback. Anonymous-first retrieval remains in place; authenticated retry is gated by the existing login-required decision. | Only whether a non-empty session file is present and whether an explicit login-required failure was observed in this process. |
| Facebook | `FACEBOOK_COOKIES` file, with a local `facebook-cookies.txt` fallback; browser/downloader paths use the file for authenticated retrieval. | File presence and explicit login-required failure only. |
| Threads | `THREADS_COOKIES` file, prepared from `THREADS_COOKIES_BASE64`; the downloader/browser reads it when configured. | File presence and explicit login-required failure only. |
| YouTube | `YOUTUBE_COOKIES` file, prepared from `YOUTUBE_COOKIES_BASE64`; yt-dlp tries the cookie path and then a public retry. | File presence and explicit login-required failure only. |

File presence is not proof that a session is valid. No login-validation request is made by Status. The last explicit authentication failure signal is held in process memory, not moderation/history storage, and disappears after restart.

## Permissions and audit

Status is Administrator-only through the existing slash command and is available from manager panels only to a user with Manage Server or Administrator. The capability resolver identifies the guild owner and an explicitly configured Credential Manager role allow-list (`HARMONY_CREDENTIAL_MANAGER_ROLE_IDS`); IDs are never included in a report. Credential refresh is not implemented. The guild owner is always credential-capable; configured role holders receive the same capability metadata. Ordinary status readers cannot manage credentials.

Status checks write only guild, actor ID, service, action, outcome, and timestamp to the additive `admin_operations_audit` table. It has no secret-bearing fields. The same writer can record future refresh attempts without storing entered values.

## Recommended secure session-refresh follow-up

Do not accept cookie text or files in Discord. Keep authentication material in an external secret manager or an owner-controlled secure upload/rotation workflow. The bot should send an authorized refresh request to a narrowly scoped backend that reads/writes the secret directly, validate only a boolean/expiry result, and return a sanitized outcome. Restrict that backend to the four named integration secrets, never expose a general infrastructure token to the bot, and record service, actor, timestamp, and outcome in the audit table. The Discord UI should show only completion/failure and never echo submitted material.
