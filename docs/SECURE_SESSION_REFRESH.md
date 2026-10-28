# Secure social-session refresh: implementation boundary

## Current state

The Discord Status screen can report a recent, explicit authentication failure. It does not validate a saved session just because a cookie file exists. Status exposes the existing diagnostic/credential-manager capability distinction, but secure session refresh is **not available**. No session-refresh button is shown. A manufactured `harmony-session-refresh:<service>` component is checked server-side and receives a safe unavailable/unauthorized response.

Harmony does not currently have a protected credential-entry web page, a narrowly scoped secret-manager client, or a Railway API integration. The existing HTTP service in `welcomePassServer.js` accepts Welcome Pass callbacks using a shared application secret; it is not an admin-authenticated secret-entry or rotation service and is not suitable for this purpose. This change does not connect to Railway or inspect/change its configuration.

An additive `credential_refresh_requests` table supports the future flow. It stores only a SHA-256 digest of a random one-use token plus request scope (guild, actor, service), status, and timestamps. Requests are designed to expire after ten minutes and are limited to three per actor per guild per hour. Current production configuration hard-disables issuance because the secure backend is absent. The request store and workflow are dependency-injected so expiry, scope binding, single-use consumption, and rate limits can be tested without enabling production refresh.

Audit entries contain only guild, actor, service, fixed action/outcome labels, and timestamp. They do not accept cookie contents or arbitrary failure text. No candidate credential is accepted by Discord, stored in this database, or logged.

## Existing session sources and validation limits

| Integration | Current input | What current code can establish | Candidate-session validation available? |
| --- | --- | --- | --- |
| Instagram | `INSTAGRAM_COOKIES` path, materialized from `INSTAGRAM_COOKIES_BASE64` at startup; legacy local cookie-file fallback remains. Downloader tooling consumes Netscape-format cookies. Anonymous retrieval is attempted first; cookies are used only for explicit authentication-required fallback. | A specific media request can report an authentication requirement. Checkpoints/challenges are classified for owner attention. | No isolated candidate validator. Retrying a media download is content-dependent and cannot reliably distinguish invalid cookies from an unavailable/deleted post, extraction issue, or platform restriction. |
| Threads | `THREADS_COOKIES` path, materialized from `THREADS_COOKIES_BASE64` at startup. Existing browser/downloader code parses Netscape cookies. | Existing diagnostics may observe authentication/account UI while processing a target. | No standalone candidate validator. A target failure is not sufficient evidence that the candidate session itself is invalid. |
| Facebook | `FACEBOOK_COOKIES` path, materialized from `FACEBOOK_COOKIES_BASE64` at startup; legacy local cookie-file fallback remains. Browser/downloader code consumes Netscape cookies and can detect login/checkpoint pages for a target. | Cookie-file syntax/presence and a target request can be inspected. Neither proves the account session is accepted generally. | No isolated candidate validator. A target request may fail for content or access reasons unrelated to session validity. |
| YouTube | `YOUTUBE_COOKIES` path, materialized from `YOUTUBE_COOKIES_BASE64` at startup. yt-dlp accepts the cookie file and may retry public retrieval without cookies. | A target request can fail or succeed; public fallback success does not prove cookie validity. | No isolated candidate validator. Existing media retrieval is not a reliable session-validation contract. |

`runtimeSecrets.js` decodes configured base64 values at process startup into permission-restricted files in an OS temporary directory and passes file paths to integrations. It does not implement remote secret rotation or live rematerialization. The cookie values and environment contents are never included in this document or status output.

## Activation requirement

All four sessions are materialized at startup. Replacing the upstream environment secret alone does not update the running process's temporary cookie file. A restart/redeployment is currently required before Harmony will use a replacement. This PR never initiates a restart or deployment. Until a separately approved activation mechanism exists, a successful future rotation would still need an explicitly authorized restart/redeployment followed by a fresh Status/media check.

## Recommended next infrastructure

Before enabling the workflow, provide a dedicated HTTPS credential-refresh backend with:

1. Discord OAuth authentication and server-side rechecks of guild, actor, owner/Credential Manager capability, selected service, expiration, and one-use request scope.
2. A short-lived one-time bearer exchange that is not placed in query strings, logs, Discord messages, or analytics. Prefer a URL fragment or a user-entered one-time code exchanged over TLS, then immediately invalidate it.
3. A narrowly scoped secret-manager identity that can update only the four named session secrets. Do not expose a general infrastructure/Railway token to Discord admins or Harmony.
4. Candidate staging isolated from production retrieval. A platform-specific validator must have a documented, dependable success signal before it can replace the active secret. On any uncertain result, preserve the current secret.
5. Atomic secret replacement and a separately authorized activation step. The backend should return only sanitized state; no credential material should pass back through Discord.
6. Secret-free audit callbacks for requested, validation success/failure, rotation success/failure, and activation outcome.

Until that infrastructure and dependable per-platform validators exist, Refresh Session remains disabled. Checkpoints, challenges, and account security warnings continue to require owner attention and must not be treated as ordinary session expiry.
