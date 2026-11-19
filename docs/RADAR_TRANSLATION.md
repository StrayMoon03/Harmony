# Radar presentation and English translation

Radar keeps original normalized source titles, complete retrieved text, URLs, publication dates and metadata. Discord uses a deterministic extractive preview, capped at 420 characters, rather than the article body. Track lists/application-manual boilerplate and raw URL collections are removed from the preview only. The original announcement remains linked. Source date-only values display as dates; known instants use Discord timestamps.

Classification uses explicit original-title rules. Machine translation never changes classification confidence, source identity, correlation, owner decisions or calendar handoff. Existing saved discoveries are reclassified/rendered in place through the normal channel sync. This does not create a new discovery or change the approved handoff/approval workflow.

## Provider and owner configuration

No translation integration or Translator configuration was present in Harmony when this PR was prepared. The implementation uses Azure AI Translator Text Translation REST API v3.0, through a small provider interface. It does not provision Azure resources, enroll in a paid service, or change Railway variables.

Before deploying with automatic English translation, the owner must choose/create an Azure Translator resource and supply:

| Railway variable | Value |
| --- | --- |
| `HARMONY_RADAR_TRANSLATION_PROVIDER` | `azure` to explicitly enable external translation |
| `AZURE_TRANSLATOR_KEY` | Secret key belonging to the owner's Translator resource |
| `AZURE_TRANSLATOR_REGION` | Resource region, required for regional/multi-service resources; use the resource's actual value |
| `AZURE_TRANSLATOR_ENDPOINT` | Optional base origin; defaults to Microsoft's documented global `https://api.cognitive.microsofttranslator.com` |

The standard global endpoint and HTTPS `<resource>.cognitiveservices.azure.com` resource origins are supported. Redirects, credentials embedded in URLs, arbitrary hosts and endpoint paths/queries are rejected so translation keys are not forwarded to an arbitrary destination. Custom-resource API paths are constructed by the adapter. Government/China cloud endpoints are not implemented.

Until configured, original-language cards continue working and indicate translation is unavailable. Configuring Azure is a separate owner-approved step. Do not place keys in GitHub, issue descriptions, screenshots or Discord messages.

Microsoft lists an F0 free tier with **2 million characters per month**. Paid S1 is usage based. No existing Azure resource, SKU, remaining quota or account-specific price was available to inspect; this PR does not select or activate a tier. Confirm the resource's SKU and quota before enabling. Configuration alone is not proof of live provider access; verify it after an approved deployment.

Official references:
- https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/translate
- https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/authentication
- https://azure.microsoft.com/en-us/pricing/details/translator/

## Isolation, cache and usage

Translation is queued independently of polling and delivery. An original-language card can be delivered immediately; a completed translation edits that saved message through the existing recovery/delivery path. Owner decisions are read afresh during that render.

Local script analysis and `franc-min` identify likely non-English input; English is skipped. Azure auto-detects the actual source language. Language detection on very short/mixed-language text can be imperfect. No phrase dictionary is used for translation.

Only the source title (up to 500 characters) and a selected original-language preview (up to 900 characters) are sent to Azure, never the complete long article. These bounds limit translation cost; previews may omit detail, so the source link remains authoritative. Machine translations are labeled and may contain translation errors.

The additive `radar_translations` cache is keyed by observation ID, normalized original-text hash and provider, with a presentation-input version/hash. It stores the selected bounded input, detected language, translated title/preview, status, retry/lease timestamps and sanitized error category. Original source data stays in the observation. The existing 6,000-character discovery/calendar-note bound is retained; only observations store the complete retrieved body. Completed translations and English skips persist across restarts. Identical selected input can reuse a previous successful translation even if only excluded boilerplate changed. Material input changes are translated again without changing the discovery ID.

Work is bounded to two concurrent background jobs, a 100-item queue, 20 external requests per minute per process, and a three-second timeout covering detection/request/response. Queue overflow leaves cards readable and eligible for enrichment on a later sync. Exhausted budgets/provider failures retry on later Radar syncs after backoff. A provider cooldown is shared across jobs for authentication, rate-limit and server errors. Valid representable Retry-After values are respected. Pending leases allow recovery after a restart. A crash after provider acceptance but before persistence can incur a repeated billed request; Azure does not supply a transaction shared with SQLite.

The cache is additive/idempotent and does not delete discoveries or source history. Neither translation nor reclassification rewrites existing Ignore, Watching, Resolved, supporting-source or calendar relationships. Deleted-card recovery and paginated Discord history checkpoints remain in use.

## Existing truncated observations

The previous adapters/store limited text to 6,000 characters. This PR removes those cutoffs for newly fetched observations, within the existing bounded upstream-response size. Previously discarded tails cannot be reconstructed from SQLite alone; they become available if the source is fetched again. No manual production backfill, historical reset or expanded source traversal is included.
