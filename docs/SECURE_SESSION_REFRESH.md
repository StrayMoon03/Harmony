# Secure social-session refresh

## Flow and trust boundaries

The Status screen offers **Refresh Session** only for a service with a recent explicit login/session failure, only to the owner or an authorized Credential Manager, and only when that service's runtime file and all backend configuration are present. A security checkpoint remains Owner Required. The component handler repeats authorization and status checks server-side.

The link opens a protected route on Harmony's existing HTTP server (`welcomePassServer.js`). Refresh routes are dispatched separately before Welcome Pass routing and never use `WELCOME_PASS_SHARED_SECRET`. They require the configured HTTPS public host and HTTPS proxy indication. Welcome Pass behavior/authentication is unchanged.

The browser flow uses Discord OAuth `identify` only. The callback verifies OAuth state and its secure state cookie, exchanges the code server-side, checks that the returned Discord user is the request actor, fetches that user's current guild membership, and rechecks the owner/Credential Manager capability. The request's database row is then atomically consumed with its guild, actor, service, and expiry scope. Signed, short-lived HTTP-only cookies carry the web session and CSRF token; their HMAC key is derived from the Discord OAuth client secret. This makes OAuth/web state verifiable across Harmony processes without putting session state in Discord messages or another database table. The request UUID is an opaque path identifier, not authorization by itself; Discord identity and live permissions are required.

The web form accepts a Netscape-format cookie export over an HTTPS POST body. It is never echoed. Harmony does not log request bodies, save candidates in SQLite, or add candidate/provider error values to audit records. Body size is capped at 1 MiB. The validator receives the candidate over a local subprocess stdin pipe. Errors returned to the page use fixed safe messages.

## Per-service candidate validation

Validation is fail-closed: only an explicit platform-specific signed-in signal permits rotation. Login pages mean unauthenticated; challenge/checkpoint pages require owner attention; missing or ambiguous UI signals mean unable to validate and preserve the existing secret.

| Service | Required cookie format/signals | Browser validation target and success signal |
| --- | --- | --- |
| Instagram | Netscape jar containing `sessionid` and `csrftoken` for Instagram | Instagram account-edit page remains on its expected route and renders its username field. |
| Threads | Netscape jar containing `sessionid` and `csrftoken` for Threads | Threads home renders a signed-in account-menu action (log out/switch accounts). |
| Facebook | Netscape jar containing `c_user` and `xs` for Facebook | Facebook `/me` renders a recognized signed-in account/profile navigation element. |
| YouTube | Netscape jar with `LOGIN_INFO` and a SAPISID-family cookie for Google/YouTube | YouTube `/feed/you` renders an account avatar and does not expose sign-in controls. |

Harmony launches its existing headless Chromium/Playwright runtime against fixed account/home pages, never a user-selected post. It does not follow arbitrary URLs or use media success as proof of authentication. If a platform changes its page or a signal is absent, the result is inconclusive and the existing session is retained. These checks have unit coverage for format and result classification, but have not been exercised against real social accounts in this change. A first deployment should keep refresh disabled until the owner has reviewed this implementation and configured the required backend values.

## Narrow rotation and live activation

The injected Railway provider uses only Railway's GraphQL Public API and `Project-Access-Token` header. A Railway Project token is scoped to one environment in one project. The code obtains that token's project/environment IDs and writes only to the configured Harmony service ID and a fixed allowlist:

- `INSTAGRAM_COOKIES_BASE64`
- `THREADS_COOKIES_BASE64`
- `FACEBOOK_COOKIES_BASE64`
- `YOUTUBE_COOKIES_BASE64`

Updates set `skipDeploys: true`; this workflow never starts a deploy. Railway does not document a token scoped to a single variable, so the server-side token still has the scope of its project environment. Keep it in server-only configuration, restrict its project/environment, and do not expose it to Discord or the browser. Provider errors and response bodies are discarded.

Harmony's integrations read their cookie file paths when invoking the downloader/browser. After a candidate validates, Harmony first updates the single Railway variable, then atomically replaces the corresponding current runtime cookie file, updates the in-memory base64 setting, and rechecks the new session. If activation/verification fails, it restores the old file and attempts to restore the old Railway value. If restoration cannot be confirmed, the response directs the operator to contact the owner. A successful refresh requires no Harmony restart or Railway deployment.

## Required configuration

All values are server-side; never put them in Discord, a browser form, repository content, or audit data.

| Variable | Purpose |
| --- | --- |
| `SESSION_REFRESH_PUBLIC_URL` | Harmony's public HTTPS origin, such as `https://harmony.example`. No path/query/fragment is accepted. |
| `DISCORD_OAUTH_CLIENT_ID` | Discord OAuth application client ID. |
| `DISCORD_OAUTH_CLIENT_SECRET` | Server-side OAuth secret; also derives signed refresh-state cookies. |
| `SESSION_REFRESH_RAILWAY_PROJECT_TOKEN` | Railway Project Access Token for the target project environment. |
| `SESSION_REFRESH_RAILWAY_SERVICE_ID` | Exact Harmony Railway service ID in that project/environment. |
| `HARMONY_CREDENTIAL_MANAGER_ROLE_IDS` | Existing comma/space separated Discord role IDs allowed to manage credentials. The guild owner is always authorized. |

Register this exact Discord OAuth redirect URI for the application: `<SESSION_REFRESH_PUBLIC_URL>/session-refresh/oauth/callback`. Keep the existing four `*_COOKIES_BASE64` variables configured. A service is offered independently; one missing session file/secret does not disable the other configured services.

## Audit and safety

`admin_operations_audit` records fixed action/outcome stages (`refresh_requested`, `request_redeemed`, `validation_*`, `rotation_*`, `activation_*`, `verification_*`) with guild, actor, service, and timestamp only. Candidate text, OAuth codes/access tokens, cookies, Railway token, and raw exception text are not recorded. Requests expire after ten minutes, can be consumed once, and are rate-limited to three per actor/guild per hour.

No real credential, Railway setting, or production secret was accessed or changed while implementing or testing this feature. Tests inject a fake rotation provider and fake Discord OAuth responses.

## Railway API references

- Public API authentication and Project token scope: <https://docs.railway.com/integrations/api>
- Variable upsert and `skipDeploys`: <https://docs.railway.com/integrations/api/manage-variables>
