# Public countdown startup failure — Q review

## Confirmed production cause

Read-only Railway deploy/build/DNS inspection on November 25, 2026 (New York time) identified the failure in deployment `7a6d3a8a-fecf-4ce0-924d-f54f8ef70b2f`, commit `5d101837f0f0fa6d9327c8015b60ed5637a2868e` (merged PR #341).

The image builds successfully. Before either listener is opened, the original entrypoint awaits `dns.lookup(RAILWAY_PRIVATE_DOMAIN)`. Railway's canonical A and AAAA queries for `youtiful-stay-countdowns.railway.internal` returned **NXDOMAIN** at all six recorded startup attempts. Search-suffix retries also returned NXDOMAIN: 36 DNS records in total. These align with repeated generic startup errors; `/health` never starts. Changing Harmony's outbound sync URL cannot resolve this earlier failure in the receiving service's own startup.

This establishes the startup self-DNS failure. It does not establish why Railway had not registered the hostname: DNS registration/readiness behavior was not observable through the connector. Secret/configuration values are redacted by Railway OAuth; they were neither retrieved nor changed. The failed deployment never reached the later configuration/storage/listener stages, so further deployment checks remain necessary.

The public service has its own volume mounted at `/data/countdowns`, a public domain targeting port 3000, and no known bot/database credential variable names. Harmony was left running. No Railway setting, secret, production database, consent, photograph, message, topic or pin was modified.

## Implementation

- The entrypoint now selects a private IP **actually assigned to the local container** via `os.networkInterfaces()`, instead of resolving the service's own DNS name. It prefers one IPv6 ULA (`fc00::/7`), with a 10/8 IPv4 fallback. Public, wildcard, loopback, IPv4-mapped and ambiguous addresses are rejected. There is no wildcard fallback for sync. If no private interface is ready, bounded retries wait up to 19 seconds and then fail closed.
- The sync listener binds the validated local address on port 3101; public GET/HEAD routes bind port 3000 separately. Both binds are awaited. Readiness is logged only after both succeed. A failed bind closes the service; runtime listener errors also close both listeners safely.
- Configuration guards still reject known bot/database credentials, invalid Railway domain/origin/secret, invalid port/rate values and public/private port collisions. The dedicated Docker image includes the startup module through its existing service-directory COPY; no new dependency is added.
- Structured diagnostic lines contain only constant component/event/stage identifiers and allowlisted error codes. No exception message, stack, environment value, credential, filesystem path, network address, Discord identifier or projection data is logged. Storage errors such as EACCES/ENOSPC and bind errors such as EADDRINUSE are distinguishable. Unknown/forged error codes are redacted.
- The private sharing screen displays **Waiting for synchronization** until a recent acknowledgment exists without a pending operation/error. It explains that sharing remains enabled and retries automatically, without instructing the owner to enable it again. Confirmed sharing shows the copyable permanent link; expired confirmation returns to waiting. Off and removal-pending states have their own instructions. Existing consent, slug and retry worker are unchanged.

### Example safe log lines

```json
{"component":"public-countdowns","event":"waiting","stage":"private-interface","code":"PRIVATE_INTERFACE_NOT_READY"}
{"component":"public-countdowns","event":"startup-failed","stage":"projection-storage","code":"EACCES"}
{"component":"public-countdowns","event":"startup-failed","stage":"private-listener","code":"EADDRINUSE"}
{"component":"public-countdowns","event":"ready","stage":"ready"}
```

## Security and preservation

No security protection has been relaxed. The private listener is still bound to a specific private interface, on a separate port that must have no public domain or TCP proxy. The public route allowlist remains read-only and has no sync/admin/data endpoints. HMAC/timestamp/nonce authentication, strict public-field schema, monotonic sequences, short leases, withdrawals, EXIF removal, CSP, caching and rate limits are unchanged. The public image still contains no Discord/admin/database implementation or dependencies. It reads only its separate public projection volume.

The bot exporter continues to send only explicitly approved concert city/country/venue/timezone/dates/photo fields. No private channel, conversation, member, credential or Harmony database access is added. Original countdown renderer/calculations, schedules, photos, room assignments, message IDs, pins, topics and automatic-update preferences are untouched.

## Verification performed

**213 focused tests and 1,115 full regression tests passed, with zero failures.** A final manager-only run after an import cleanup also passed all 45 tests. See [executed results](deployment-fix-tests.txt), [redacted production diagnosis](startup-evidence.json) and [actual sharing-screen output](sharing-status-preview.json). The screen output is generated by the real manager using an isolated Chicago fixture, not production consent or data.

New regressions cover self-DNS returning ENOTFOUND while startup succeeds without a lookup; private address validation/ambiguity; bounded readiness retries; fail-closed configuration; awaited private/public bind failures and cleanup; sanitized configuration/storage/unknown/runtime errors; and all sharing-screen states. An initial failed sync is persisted, the test database is reopened, and the existing startup worker catches up with the same consent/slug and unchanged Discord configuration. Existing public HTTP tests cover route isolation, auth/replay/schema/sequence checks, withdrawal/expiry, restart recovery, rate limits, unchanged rendered PNG bytes and midnight/metadata behavior.

Self-review checked that no DNS-derived stale/remote address can be bound, no startup readiness is reported before private binding, non-ULA short IPv6 prefixes are rejected, raw errors/forged diagnostic fields cannot leak, and the pending-sharing screen remains revocable. The first restart-worker test woke on another fixture's sync; its completion signal was corrected to wait for the intended slug, then the targeted suite passed.

## Deployment verification instructions — after Q/owner approval only

1. Review/merge separately when authorized. Deploy the reviewed commit to **both** the isolated public service (startup fix) and Harmony (sharing wording). Do not copy Harmony environment variables, dependencies, SQLite volume or bot entrypoint into the public service. Retain one public replica and the existing dedicated public volume; do not delete/reinitialize it.
2. Confirm the service still builds from `deploy/public-countdowns.Dockerfile`, uses the existing Node entrypoint, has `/health` as its healthcheck, and exposes **only port 3000** publicly. No public domain/TCP proxy may target 3101. Keep the same canonical HTTPS origin (no trailing slash), existing private sync secret and private sync URL. Do not print or paste secrets into logs/review comments.
3. Check deployment logs for `{"component":"public-countdowns","event":"ready","stage":"ready"}` and Railway's successful healthcheck. Public `GET /health` must return 200 `ok`. No self-DNS query is needed to reach readiness. If startup fails, inspect only its stage/code: invalid configuration names the field, `private-interface` indicates missing/ambiguous local networking, `projection-storage` indicates the dedicated volume, and a listener stage identifies the failed bind. Fix the indicated configuration rather than adding public exposure or disabling guards.
4. Chicago's existing sharing consent is already enabled. **Do not enable again, republish, re-upload or change the countdown.** Harmony's exporter retries on startup and every five minutes. Reopen the private Get Facebook Countdown Link screen after a retry: it should progress from Waiting for synchronization to On with the same permanent slug/URL. If it stays pending, verify private DNS resolution **from Harmony to the now-running public service**, the exact HTTP `/internal/sync` port/path and matching existing secret through the provider's secure settings. This outbound DNS requirement remains; only the receiving service's self-DNS dependency was removed.
5. Verify the existing Chicago URL without Discord login: HTML 200, countdown PNG 200 and venue image 200. Confirm city/venue/all selected dates and the existing approved photograph. Other unpublished/unshared countdowns must remain unavailable. Compare saved Discord message IDs, pins, photos and update flags without editing them.
6. Check public `GET /internal/sync`, `/admin`, `/data` and `/countdowns` return 404; public POST/PUT/DELETE must return 405. In an isolated staging environment only, verify an unsigned POST to the private sync endpoint returns 401 and an authenticated lease/withdrawal behaves normally. Do not send test projections or toggle the owner's Chicago sharing for security tests.
7. Restart the public service through an approved maintenance action: verify readiness and the same Chicago URL/approved snapshot. A missed/expired lease may make the URL temporarily unavailable until the next existing Harmony retry (at most the normal five-minute interval). Observe one venue-local midnight and compare the PNG/ETag before and after; Facebook Open Graph metadata should stay unchanged. Discord midnight updates continue independently.

No merge or deployment was performed for this fix. Live Railway startup, private synchronization, and the Chicago public URL must be verified after the reviewed code is deployed; local regression results are not a claim of successful production recovery.

Platform reference: [Railway private networking](https://docs.railway.com/networking/private-networking/how-it-works) documents internal DNS and IPv4/IPv6 support. Local interface binding avoids depending on that DNS during this service's startup while preserving the separate private listener.
