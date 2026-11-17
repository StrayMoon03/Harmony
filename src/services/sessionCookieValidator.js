const { spawn } = require("node:child_process");
const path = require("node:path");
const { expectedInstagramUsername } = require("./sessionRefreshConfig");

const VALIDATION_HELPER = path.resolve(__dirname, "../modules/media/sessionCookieValidation.py");
const VALIDATION_STATUSES = new Set(["AUTHENTICATED", "UNAUTHENTICATED", "OWNER_REQUIRED", "INCONCLUSIVE", "INVALID_FORMAT", "MISSING_REQUIRED_COOKIES", "IDENTITY_MISMATCH", "IDENTITY_UNVERIFIABLE"]);

const DIAGNOSTIC_SERVICES = new Set(["instagram", "youtube", "threads"]);
const STAGES = new Set(["cookie_parse", "browser_import", "browser_launch", "cookie_setup", "navigation", "page_inspection", "complete"]);
const DOCUMENTS = new Set(["google_sign_in", "external", "challenge", "login", "instagram_edit", "youtube_feed", "threads_net", "threads_com", "provider_other"]);
const EVIDENCE = new Set(["challenge_detected", "login_detected", "username_mismatch", "username_unreadable", "username_match", "edit_form_missing",
  "avatar_found", "avatar_evidence_missing", "youtube_feed_missing", "youtube_sign_in_link_present", "account_menu_found", "account_menu_missing"]);

function safeProbeDetails(details) {
  if (!details || !STAGES.has(details.stage)) return {};
  const result = { stage: details.stage };
  if (DOCUMENTS.has(details.document)) result.document = details.document;
  if (EVIDENCE.has(details.evidence)) result.evidence = details.evidence;
  if (details.error === "timeout" || details.error === "probe_error") result.error = details.error;
  if (Array.isArray(details.navigation)) {
    result.navigation = details.navigation.slice(0, 8).filter((entry) => Array.isArray(entry) &&
      Number.isInteger(entry[0]) && entry[0] >= 100 && entry[0] <= 599 && DOCUMENTS.has(entry[1]))
      .map(([status, category]) => ({ status, category }));
  }
  return result;
}

function validateSessionCookie(service, candidate, {
  spawnProcess = spawn,
  helperPath = VALIDATION_HELPER,
  pythonPath = process.env.PYTHON_PATH || "python3",
  env = process.env,
  timeoutMs = 35_000,
  diagnosticLogger,
} = {}) {
  return new Promise((resolve) => {
    const report = (status, details = {}) => {
      if (typeof diagnosticLogger === "function" && DIAGNOSTIC_SERVICES.has(service)) {
        try { diagnosticLogger({ service, decision: status, ...details }); } catch {}
      }
      resolve({ status });
    };
    if (typeof candidate !== "string" || !["instagram", "threads", "facebook", "youtube"].includes(service)) {
      report("INVALID_FORMAT", { stage: "input" });
      return;
    }
    if (service === "instagram" && !expectedInstagramUsername(env)) {
      report("IDENTITY_UNVERIFIABLE", { stage: "expected_identity_missing_or_invalid" });
      return;
    }
    let child;
    try {
      child = spawnProcess(pythonPath, [helperPath, service], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env });
    } catch {
      report("INCONCLUSIVE", { stage: "helper_spawn" });
      return;
    }
    let output = "";
    let settled = false;
    const finish = (status, details) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      report(status, details);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("INCONCLUSIVE", { stage: "helper_timeout" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (output.length + chunk.length > 1024) {
        child.kill("SIGKILL");
        finish("INCONCLUSIVE", { stage: "helper_output_limit" });
        return;
      }
      output += chunk.toString("utf8");
    });
    child.stdin.on("error", () => finish("INCONCLUSIVE", { stage: "helper_input" }));
    child.on("error", () => finish("INCONCLUSIVE", { stage: "helper_spawn" }));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish("INCONCLUSIVE", { stage: "helper_exit" });
        return;
      }
      try {
        const parsed = JSON.parse(output.trim());
        if (VALIDATION_STATUSES.has(parsed.status)) {
          finish(parsed.status, safeProbeDetails(parsed.diagnostics));
          return;
        }
      } catch {}
      finish("INCONCLUSIVE", { stage: "helper_invalid_result" });
    });
    try {
      const input = Buffer.from(candidate, "utf8");
      child.stdin.write(input, () => {
        input.fill(0);
        child.stdin.end();
      });
    } catch {
      child.kill("SIGKILL");
      finish("INCONCLUSIVE", { stage: "helper_input" });
    }
  });
}

module.exports = { VALIDATION_STATUSES, validateSessionCookie };
