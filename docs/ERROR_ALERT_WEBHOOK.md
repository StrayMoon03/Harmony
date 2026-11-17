# External media-error alert webhook

After Harmony posts a media failure to its Discord error inbox (and after the existing 5-minute inbox dedupe), it can also fire-and-forget a small JSON POST to an external webhook so an assistant or operator is alerted immediately.

The feature is off unless both values below are set. If either is missing, Harmony does nothing. Failures contacting the webhook are logged as a short warning and never enter the media pipeline. The webhook URL and key are never logged.

These are ordinary server-side environment variables, loaded the same way as `HARMONY_ERROR_GITHUB_TOKEN` (from the process environment / `.env` via `dotenv`, or Railway service variables). They are not cookie files and are not handled by `runtimeSecrets.js`.

| Variable | Purpose |
| --- | --- |
| `HARMONY_ERROR_WEBHOOK_URL` | HTTPS (or HTTP) endpoint that receives the alert POST. |
| `HARMONY_ERROR_WEBHOOK_KEY` | Shared secret sent as `Authorization: Bearer <key>` and `X-Automation-Key: <key>`. |

The JSON body includes `platform`, a query-stripped `sourceUrl`, redacted `errorText`, a `fingerprint` shared with the private GitHub reporter, `discordMessageLink` when the original message link is already known, and an ISO `timestamp`. It does not include Discord user identity or media bytes.

Set both values in the Harmony Railway service variables (same place as `HARMONY_ERROR_GITHUB_TOKEN` and `HARMONY_ERROR_GITHUB_REPO`). For local runs, add them to `.env`. Restart or redeploy Harmony after changing them so the process picks up the new values.
