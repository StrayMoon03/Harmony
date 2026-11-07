// Authentication conclusions are carried as structured metadata. Textual
// downloader errors alone are never sufficient to alter persistent health.
function classifyAuthenticatedProviderFailure(error, { authenticatedRequest = false } = {}) {
  if (!authenticatedRequest) return null;
  const text = [error?.message, error?.stderr, typeof error === "string" ? error : ""]
    .filter(Boolean).join(" ").toLowerCase();

  if (/\/checkpoint\/|\/challenge\/|checkpoint(?: page|required| blocked)?|security challenge|account verification required|suspicious login/.test(text)) {
    return { kind: "owner", category: /challenge|verification/.test(text) ? "challenge" : "checkpoint" };
  }
  // Exclude anti-bot prompts and transport/rate-limit failures: these do not
  // prove that the account session is invalid.
  if (/not logged in|login (?:is )?required|sign[ -]?in (?:is )?required|opened a login page|redirected to (?:the )?login|session (?:has )?expired|session is invalid|invalid session|authentication required|auth_required/i.test(text) &&
      !/confirm.*not a bot|not a bot|rate.?limit|too many requests|\b429\b/i.test(text)) {
    return { kind: "session", category: /expired|invalid session/.test(text) ? "session_invalid" : "login_required" };
  }
  return null;
}

module.exports = { classifyAuthenticatedProviderFailure };
