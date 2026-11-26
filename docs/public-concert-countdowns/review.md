# Public concert countdowns / Facebook — Q review

## Result and owner workflow

Adds public mobile/desktop pages for explicitly shared, approved published Harmony countdowns. They reuse the existing date model, selected concert dates, venue/timezone and saved photograph. The actual countdown PNG uses the unchanged approved renderer; an HTTP regression compares it byte-for-byte with Harmony's renderer output.

**Control Center → Countdown → Configured Countdowns → select a countdown → Get Facebook Countdown Link → Enable Public Sharing.** The owner receives its permanent URL privately and pastes it into a Youtiful STAY Facebook post manually. The same private screen has Disable Public Sharing and Back. Sharing is off by default for every configuration. Existing published configurations need no setup repeat or photo upload. Unpublished drafts cannot be shared. Sharing approval is scoped to the reviewed room/content and a fresh private-view nonce; replaying an old Enable button after disabling cannot re-enable it.

URLs have the form `https://<configured-public-host>/countdowns/chicago-soldier-field-<random-suffix>`. The readable slug is created once and survives photo/date/name updates and disable/re-enable. The random suffix contains no Discord identifier. Example hosts/slugs in review files are fixtures, not live public links.

The new sharing table holds only opt-in/sync metadata, not another calendar or countdown setup. Source dates remain in the approved calendar and source photographs remain in the existing countdown configuration. Private saved edits with a cleared publication fingerprint are not exported; an existing public page can renew its last approved projection until publication. Approved calendar reschedules update the projection; canceled/unapproved selections revoke it rather than renewing stale dates. Discord automatic-update flags remain untouched; an explicitly enabled public page has its own live midnight rendering.

## Chicago webpage previews

- [Actual desktop Chromium screenshot](chicago-desktop.png)
- [Actual mobile Chromium screenshot](chicago-mobile.png)
- [Browser checks](browser-verification.json): desktop 1280 px and mobile/touch 390 px; no horizontal overflow; full 800-pixel source graphic loaded.
- [Approved-renderer PNG served by the test page](chicago-countdown.png)
- [Static Facebook venue preview](facebook-venue-preview.jpg)
- [Real-renderer midnight evidence](midnight-verification.json): 205/206 → 204/205 at Chicago midnight, with unchanged Open Graph tags and a changed image ETag. [After-midnight PNG](chicago-after-midnight.png).
- [HTML/metadata response](chicago.html)
- [Actual private sharing-screen payloads](manager-payloads.json)

Chicago uses June 18/19, 2027 and an isolated, labeled photograph fixture. The illustrated fixture is not a new owner photograph or production configuration. On deployment/opt-in, the existing saved owner photograph is reused automatically.

## Facebook metadata

The initial HTML supplies `og:type`, site name, canonical URL, city title, venue/dates/invitation description and an HTTPS 1200×630 venue image with type/dimension/alt metadata. The venue thumbnail is static, stripped of EXIF and contains no countdown numbers. A branded static fallback supports published cards without photographs. Main-page numbers remain in the live approved PNG and its accessible description, not in cached Facebook metadata. A midnight test proves the Open Graph tags remain identical while the countdown PNG/ETag changes.

The page needs no Discord account, login, cookie, tracker or app download. It renders without JavaScript; a small same-origin script reloads at the next venue-local midnight and retries a temporarily unavailable image. Meta may retain an earlier link preview after sharing is disabled; already downloaded/copied public content cannot be recalled. There is no Facebook API integration, account credential collection or automated group-post editing.

Official sharing reference: https://developers.facebook.com/documentation/sharing/webmasters . A live Meta Sharing Debugger check must wait for separately authorized HTTPS hosting; offline metadata tests are not a claim of a live Facebook scrape.

## Recommended Railway hosting

Use **a second, single-replica Railway service**, in Harmony's project/environment for private networking, with **its own volume** at `/data/countdowns`. Do not mount Harmony's SQLite volume or copy its environment variables. The lightweight public Docker image contains only Node, Pillow/fonts, the existing pure model/renderer/reference, and the public service. It has no Discord dependencies, bot entrypoint, admin handlers or database code. Startup rejects known bot/database credential variables.

Configuration files are prepared at [Dockerfile](../../deploy/public-countdowns.Dockerfile) and [Railway config](../../deploy/public-countdowns.railway.json). They have not been applied. Recommend starting with one small instance with 512 MB–1 GB memory, measuring usage before broader sharing. Do not add replicas to this file-backed version.

Public service variables:

| Variable | Value / purpose |
| --- | --- |
| `COUNTDOWN_PUBLIC_ORIGIN` | Permanent HTTPS custom domain, with no trailing slash; choose an owned domain before deployment |
| `COUNTDOWN_PUBLIC_SYNC_SECRET` | New random secret, at least 32 characters; shared only with Harmony's exporter |
| `PORT` | 3000; the **only** public domain target port |
| `COUNTDOWN_SYNC_PORT` | 3101; private ingestion only, no public domain/TCP proxy |
| `COUNTDOWN_PUBLIC_DIRECTORY` | `/data/countdowns` on this service's separate volume |
| `COUNTDOWN_PUBLIC_PEER_RATE` | Optional bounded request budget; default 600/minute per socket peer |
| `COUNTDOWN_PUBLIC_GLOBAL_RATE` | Optional bounded global budget; default 2400/minute |

Railway provides `RAILWAY_PRIVATE_DOMAIN`. The sync listener binds a validated private address assigned to the local container, never a wildcard/public listener. It does not resolve its own service hostname during startup (see [deployment startup fix](deployment-fix.md)). Its port is distinct from the public port. The domain must explicitly target port 3000. Give this service no Discord tokens, database URL, Welcome Pass secret, session credentials or bot volume.

Harmony variables (existing bot service, no hosting change to its existing HTTP/admin server):

| Variable | Value / purpose |
| --- | --- |
| `COUNTDOWN_PUBLIC_ORIGIN` | Same permanent HTTPS origin |
| `COUNTDOWN_PUBLIC_SYNC_URL` | `http://<public-service>.railway.internal:3101/internal/sync` |
| `COUNTDOWN_PUBLIC_SYNC_SECRET` | Same new private sync secret |

Harmony sends only allowlisted public fields over the private network. HMAC signatures, short timestamp windows, nonce replay protection and durable monotonic sequences authenticate/order updates and withdrawals. Full images are sent when the approved projection changes or a missing projection needs repair; routine requests renew its lease. Public traffic never calls Harmony, reads SQLite, queries Discord or triggers image rendering.

Railway private networking reference: https://docs.railway.com/networking/private-networking/how-it-works . Persistent volume reference: https://docs.railway.com/volumes . These recommendations were evaluated against the documented platform, not by provisioning resources.

## Caching, midnight and recovery

The separate service renders at venue-local midnight using the same IANA/calendar-day model. Startup catches up missed days and rebuilds missing cached graphics from approved snapshots. All selected dates remain in one graphic. Cached PNG/thumbnail files have bounded memory caching. GET/HEAD responses support ETags, revalidation and gzip/deflate text; stale daily graphics return a temporary 503 rather than yesterday's numbers. Public requests cannot initiate a render. Concurrency, connections, request size and rate budgets are bounded. Client-forwarded IP headers are deliberately not trusted; behind a shared proxy, tune budgets after the Chicago trial.

The bot renews approved sharing leases every five minutes, with debounced updates after countdown changes. Without a successful authenticated renewal, access expires within 15 minutes. This deliberately fails closed if the bot/sync network is unavailable. Healthy withdrawal immediately makes HTML and every asset return 404, before cache/ETag handling, and removes the stored photo/assets. A failed withdrawal is explicitly reported as unconfirmed; access ends at the old lease expiry rather than being silently advertised as removed. This availability/security tradeoff means long bot outages can temporarily make a permanent URL unavailable. The same URL resumes after recovery/authorized sharing.

## Security and preservation verification

- Opt-in default, private authorization, stale review/control rejection, stable URLs and original configuration/photo/message/topic/automatic-update state preserved.
- Published-source validation, private-edit quarantine, canonical approved calendar reuse and canceled-date withdrawal.
- Public port GET/HEAD only; admin, sync, file, JSON, directory traversal and enumeration probes are rejected. No database/member/Discord identifiers/credentials appear in page data or exported fields.
- Strict ingestion field/schema/photo bounds, HMAC/replay/stale-sequence checks, host-header independence and HTML escaping/CSP/no cookies.
- Venue EXIF removal, byte-identical approved countdown rendering, static Open Graph tags across midnight, image ETag changes, cache/lease withdrawal behavior and traffic that causes no renders.
- Restart persistence, expired-lease fail-closed behavior, authenticated resumption, missing-cache recovery and newer withdrawals winning over late upserts.

Self-review corrected relative image URLs discovered by real browser testing, recovery of missing cached assets, public-control replay scoping, unconsumed sync-response bodies, concurrent cache accounting and failed-withdrawal wording. [Executed test results](test-results.txt) include the final targeted and full regression runs.

## Remaining deployment checks

Choose/configure the permanent HTTPS domain and private-network variables/volume after Q and owner approval. Then enable Chicago only, verify private sync/withdrawal, open the page on real devices, use Meta's Sharing Debugger manually, and observe one live local-midnight transition. No live domain, production data, Discord message/topic, Facebook post or Railway resource was changed here.

Reproduce the review fixture with `node scripts/preview-public-countdowns.cjs` (Python Playwright and a Chromium installation required; optional `CHROMIUM_EXECUTABLE_PATH` / `CHROMIUM_REVIEW_ARGS` select a local review browser). Screenshots were captured in Chromium 158 with CSP active.

**Return for Q review. DO NOT MERGE OR DEPLOY.**
