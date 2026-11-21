# Radar owner-triggered English translation

Radar ingestion and polling remain automatic. **External translation is never initiated by discovery, polling, startup/restart, rendering, source edits, Ignore/Watch, calendar controls, or refresh.** Card synchronization performs local language analysis and reads matching completed cache entries only. There is no automatic retry/restart replay of translation work.

A non-English or uncertain untranslated review card offers **Translate to English** alongside Ignore, Watch for Details, Add to Calendar and Original announcement. Only the configured Harmony server's actual Discord owner may request translation, checked server-side on every interaction. Other administrators cannot spend this allowance. Unknown language detection is conservative; short/mixed titles may need an explicit request. The provider detects the source language.

## Click, cache and delivery

The interaction acknowledges immediately, re-reads the primary observation, and checks completed cache entries before queueing work. Concurrent clicks share one in-process promise. SQLite pending leases also protect against concurrent processes and recover after expiration, but **expiration alone never triggers a request**: another owner click is required. Successful translations edit the existing saved Discord card via normal recovery/delivery. Changed observations cannot show stale translated results. Ignore/Watching/Resolved decisions, discovery IDs, support relationships and calendar handoffs remain unchanged.

Original normalized titles, full retrieved text, links, dates and metadata remain unchanged in observations. English becomes the primary title/concise preview/informational timing when a valid result exists. Machine translation remains labelled and the original source remains authoritative and accessible. Translation never affects classification, confidence, correlation or calendar eligibility/date fields. No translation output is written into calendar truth; the existing Add to Calendar confirmation remains required.

Input is bounded to a title of at most 500 UTF-16 code units and a summary of at most 900. Already-identified, unambiguous source timing evidence can reserve space in that summary if it would otherwise be omitted; no full article is sent to search for dates, infer years or time zones. Preview cleanup still removes hashtags, URLs and marked promotional/track/legal/application boilerplate. These input bounds are not a promise to translate every detail. Source content and original announcement are retained.

The existing additive `radar_translations` table requires **no migration**. Its identity includes observation ID, normalized source hash, provider and versioned input hash. Valid existing Azure **and Google** completed results remain reusable without another provider call, with their actual provider label. New Azure results take precedence. An old English-skip detection is not treated as a valid translation when bounded input contains Japanese/Korean/Chinese script. Changed input requires another explicit click; unrelated boilerplate edits can reuse identical bounded input. No history/cache rows are reset or deleted.

## Azure only for new requests

The only production request adapter is Azure Translator Text REST v3, standard plain-text translation, target `en` only. It POSTs title/summary in one batch to the fixed endpoint:

`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en&textType=plain`

Authentication is server-side `Ocp-Apim-Subscription-Key`, with `Ocp-Apim-Subscription-Region` when the resource requires it. Keys never enter URLs, Discord messages or raw persisted error bodies. Redirects are rejected and response size is bounded. No Google API adapter or alternate-provider fallback exists. Google keys/settings cannot initiate new requests. Reading a pre-existing Google cache entry is not a provider fallback.

Future owner configuration, **not configured by this PR**:

| Variable | Purpose |
| --- | --- |
| `HARMONY_RADAR_TRANSLATION_PROVIDER` | Exactly `azure`; otherwise new requests are disabled |
| `AZURE_TRANSLATOR_KEY` | Secret key from the intended Translator resource |
| `AZURE_TRANSLATOR_REGION` | Required for regional resources; optional for single-service global resources |

No new SDK is necessary. Missing configuration produces a compact unavailable result and does not block Radar.

## Strict $0 setup boundary

The owner must separately create/choose an Azure subscription and a **single-service Translator resource with actual SKU F0**, and verify that SKU before enabling the feature. A global resource is the simplest supported setup. Do not choose S1/pay-as-you-go or treat trial credits as a hard $0 cap. No resource, billing, keys or Railway configuration is created/changed by this PR.

Microsoft documents F0 as 2 million characters per subscription month and states that free translation stops at the allowance. This is a resource-level limit: an API key or request parameter does **not** prove or select F0. Harmony deliberately does not claim a resource is free based on a key/environment label. If an owner later configures a paid resource instead, the request adapter cannot turn it into F0.

Documented Azure error `403001` is recorded as the safe `translator_free_quota_exhausted` category and shown as **Free translation allowance exhausted**. No automatic retry, provider switch or paid fallback occurs. Other failures/timeouts are sanitized, keep discoveries safe and leave retry/cooldown timestamps. Cooldown expiration merely permits a future explicit owner click; it never schedules provider work. Quota/auth/rate/server failures also share an in-process cooldown to prevent bursts across cards.

Work retains limits of two concurrent jobs, a 100-item queue, 20 external requests per minute per process, and a three-second timeout. These are additional usage safeguards, not proof of a pricing tier. A crash after Azure accepts a request but before SQLite commits can require a repeat request after a later owner click; there is no atomic transaction/idempotency guarantee shared with Azure. F0's real resource quota remains the spending boundary.

Official references checked for this phase:
- https://azure.microsoft.com/en-us/pricing/details/translator/
- https://www.microsoft.com/en-us/translator/business/faq/
- https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/quickstart/rest-api
- https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/authentication
- https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/status-response-codes

Tests use injected fake providers/HTTP responses. No live translation request or production setup is part of implementation validation.
