# Radar presentation and English translation

Radar keeps original normalized source titles, complete retrieved text, URLs, publication dates and metadata. Discord uses a deterministic extractive preview, capped at 420 characters, rather than the article body. Track lists/application-manual boilerplate and raw URL collections are removed from the preview only. The original announcement remains linked. Source date-only values display as dates; known instants use Discord timestamps.

Classification uses explicit original-title rules. Machine translation never changes classification confidence, source identity, correlation, owner decisions or calendar handoff. Existing saved discoveries are reclassified/rendered in place through the normal channel sync. This does not create a new discovery or change the approved handoff/approval workflow.

## Provider and owner configuration

The provider is Google Cloud Translation **Basic (v2)** using standard Neural Machine Translation (NMT), through the existing provider interface. This fits bounded plain-text title/preview translation; it does not require Advanced v3, a custom model, a glossary or a document/LLM translation service. No new SDK/dependency is needed for Node's existing server-side HTTPS fetch path.

Basic v2 officially supports API keys as well as OAuth/service-account authentication. This implementation uses a server-side API key sent in the `x-goog-api-key` header, never in the URL. It POSTs JSON to the fixed official endpoint `https://translation.googleapis.com/language/translate/v2` with `target=en`, `format=text`, `model=nmt` and no source language so Google auto-detects it. Redirects are rejected; arbitrary endpoint overrides are not supported. Returned character references are decoded once while literal angle brackets are retained as text.

The owner must configure the following later, before an approved deployment:

1. Choose/create the intended Google Cloud project. Do not assume an existing Firebase project is the correct billing/quota project.
2. Verify/link billing for that project. Google requires enabled billing even when usage falls within the monthly allowance.
3. Enable the Cloud Translation API for that project, if not already enabled.
4. Create an API key in that project and restrict it to the Cloud Translation API. Keep it server-side. HTTP-referrer restrictions are intended for browser callers; IP restrictions require verified stable server egress, which this PR does not assume.
5. Review usage quotas and billing alerts. Google's documented default daily character quota is unlimited. The monthly credit is not a hard spending cap, and alerts alone do not stop charges.
6. Set these Railway variables only after owner approval:

| Railway variable | Value |
| --- | --- |
| `HARMONY_RADAR_TRANSLATION_PROVIDER` | `google` to explicitly enable new external translations |
| `GOOGLE_CLOUD_TRANSLATION_API_KEY` | Secret API key from the intended owner-configured project |

No project ID, region, endpoint override, service-account JSON file or Azure credentials are required by this Basic/API-key implementation. The key associates requests with its project for billing/quota. Azure settings are no longer read and cannot activate Azure API requests. Old Azure variables may be removed later by the owner; this PR does not modify them.

Without explicit Google configuration, new uncached announcements continue in their original language. Existing successful Azure cache entries remain usable for unchanged source/input hashes, retaining their actual Azure provider label; they are not relabeled Google or deleted. New/materially changed content uses Google. Successful Google results take precedence. Failed/pending Azure cache entries cannot block Google work. No schema migration or data reset is required for this provider change.

### Pricing verified for this provider change

Google lists the first **500,000 NMT characters per month** as free via a **$10 monthly credit**, shared collectively between Basic and Advanced, with no rollover. Standard Basic NMT usage above the allowance is listed at **$20 per million characters** under standard USD on-demand pricing through one billion characters/month. This is not unlimited free Google Translate. Detection within a translation request adds no separate detection charge. Other usage and account-specific terms can affect remaining credit/cost.

No project, API activation, billing account, existing key, remaining allowance or quota state was assumed or configured by this PR. The owner must verify those before enabling translation. No resource was created, paid service activated, credentials changed or live billable verification request made. Provider calls are mocked in tests; live verification awaits separately approved setup/deployment.

Official references:
- https://docs.cloud.google.com/translate/docs/api-overview
- https://docs.cloud.google.com/translate/docs/authentication
- https://docs.cloud.google.com/docs/authentication/api-keys-use
- https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate
- https://docs.cloud.google.com/translate/docs/setup
- https://cloud.google.com/products/translate/pricing

## Isolation, cache and usage

Translation is queued independently of polling and delivery. An original-language card can be delivered immediately; a completed translation edits that saved message through the existing recovery/delivery path. Owner decisions are read afresh during that render.

Local script analysis and `franc-min` identify likely non-English input; English is skipped. Google auto-detects the actual source language. Language detection on very short/mixed-language text can be imperfect. No phrase dictionary is used for translation.

Only the source title (up to 500 characters) and a selected original-language preview (up to 900 characters) are sent to Google, never the complete long article. These bounds limit translation cost; previews may omit detail, so the source link remains authoritative. Machine translations are labeled and may contain translation errors.

The additive `radar_translations` cache is keyed by observation ID, normalized original-text hash and provider, with a presentation-input version/hash. It stores the selected bounded input, detected language, translated title/preview, status, retry/lease timestamps and sanitized error category. Original source data stays in the observation. The existing 6,000-character discovery/calendar-note bound is retained; only observations store the complete retrieved body. Completed translations and English skips persist across restarts. Identical selected input can reuse a previous successful translation even if only excluded boilerplate changed. Material input changes are translated again without changing the discovery ID.

Work is bounded to two concurrent background jobs, a 100-item queue, 20 external requests per minute per process, and a three-second timeout covering detection/request/response. Queue overflow leaves cards readable and eligible for enrichment on a later sync. Exhausted budgets/provider failures retry on later Radar syncs after backoff. A provider cooldown is shared across jobs for authentication, rate-limit and server errors. Valid representable Retry-After values are respected. Pending leases allow recovery after a restart. A crash after provider acceptance but before persistence can incur a repeated billed request; the provider does not supply a transaction shared with SQLite.

The cache is additive/idempotent and does not delete discoveries or source history. Neither translation nor reclassification rewrites existing Ignore, Watching, Resolved, supporting-source or calendar relationships. Deleted-card recovery and paginated Discord history checkpoints remain in use.

## Existing truncated observations

The previous adapters/store limited text to 6,000 characters. This PR removes those cutoffs for newly fetched observations, within the existing bounded upstream-response size. Previously discarded tails cannot be reconstructed from SQLite alone; they become available if the source is fetched again. No manual production backfill, historical reset or expanded source traversal is included.
