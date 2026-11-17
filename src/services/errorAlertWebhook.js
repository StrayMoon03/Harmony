const { safeUrl, sanitizedErrorText, fingerprint } = require("./errorReportSanitize");

const WEBHOOK_TIMEOUT_MS = 8000;

function getErrorAlertWebhookConfig(env = process.env) {
  const url = String(env.HARMONY_ERROR_WEBHOOK_URL || "").trim();
  const key = String(env.HARMONY_ERROR_WEBHOOK_KEY || "").trim();
  if (!url || !key) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return { url, key };
}

function buildErrorAlertPayload({
  platform,
  sourceUrl,
  error,
  fingerprint: reportKey,
  discordMessageLink,
  timestamp,
} = {}) {
  const errorText = sanitizedErrorText(error) || "No technical error details were available.";
  const platformName = platform || "Media";
  return {
    platform: platformName,
    sourceUrl: safeUrl(sourceUrl),
    errorText,
    fingerprint: reportKey || fingerprint(platformName, errorText),
    discordMessageLink: safeUrl(discordMessageLink),
    timestamp: timestamp || new Date().toISOString(),
  };
}

function webhookFailureReason(error) {
  const name = error?.name;
  const code = error?.code;
  if (name === "TimeoutError" || name === "AbortError" || code === "ABORT_ERR") return "timeout";
  return "request failed";
}

async function sendErrorAlertWebhook(details, { env = process.env, fetchImpl = fetch } = {}) {
  const config = getErrorAlertWebhookConfig(env);
  if (!config) return false;

  try {
    const payload = buildErrorAlertPayload(details);
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.key}`,
        "X-Automation-Key": config.key,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response?.ok) {
      const status = Number(response?.status) || "unknown";
      console.warn(`Harmony error alert webhook returned HTTP ${status}.`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`Harmony error alert webhook failed: ${webhookFailureReason(error)}.`);
    return false;
  }
}

function notifyErrorAlertWebhook(details, options) {
  try {
    return sendErrorAlertWebhook(details, options).catch(() => false);
  } catch {
    return false;
  }
}

module.exports = {
  WEBHOOK_TIMEOUT_MS,
  getErrorAlertWebhookConfig,
  buildErrorAlertPayload,
  sendErrorAlertWebhook,
  notifyErrorAlertWebhook,
};
