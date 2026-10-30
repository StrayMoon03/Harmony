const { spawn } = require("node:child_process");
const path = require("node:path");
const { expectedInstagramUsername } = require("./sessionRefreshConfig");

const VALIDATION_HELPER = path.resolve(__dirname, "../modules/media/sessionCookieValidation.py");
const VALIDATION_STATUSES = new Set(["AUTHENTICATED", "UNAUTHENTICATED", "OWNER_REQUIRED", "INCONCLUSIVE", "INVALID_FORMAT", "IDENTITY_MISMATCH", "IDENTITY_UNVERIFIABLE"]);

function validateSessionCookie(service, candidate, {
  spawnProcess = spawn,
  helperPath = VALIDATION_HELPER,
  pythonPath = process.env.PYTHON_PATH || "python3",
  env = process.env,
  timeoutMs = 35_000,
} = {}) {
  return new Promise((resolve) => {
    if (typeof candidate !== "string" || !["instagram", "threads", "facebook", "youtube"].includes(service)) {
      resolve({ status: "INVALID_FORMAT" });
      return;
    }
    if (service === "instagram" && !expectedInstagramUsername(env)) {
      resolve({ status: "IDENTITY_UNVERIFIABLE" });
      return;
    }
    let child;
    try {
      child = spawnProcess(pythonPath, [helperPath, service], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env });
    } catch {
      resolve({ status: "INCONCLUSIVE" });
      return;
    }
    let output = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: "INCONCLUSIVE" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (output.length + chunk.length > 256) {
        child.kill("SIGKILL");
        finish({ status: "INCONCLUSIVE" });
        return;
      }
      output += chunk.toString("utf8");
    });
    child.stdin.on("error", () => finish({ status: "INCONCLUSIVE" }));
    child.on("error", () => finish({ status: "INCONCLUSIVE" }));
    child.on("close", (code) => {
      if (settled) return;
      try {
        const parsed = JSON.parse(output.trim());
        finish(code === 0 && VALIDATION_STATUSES.has(parsed.status)
          ? { status: parsed.status }
          : { status: "INCONCLUSIVE" });
      } catch {
        finish({ status: "INCONCLUSIVE" });
      }
    });
    try {
      const input = Buffer.from(candidate, "utf8");
      child.stdin.write(input, () => {
        input.fill(0);
        child.stdin.end();
      });
    } catch {
      child.kill("SIGKILL");
      finish({ status: "INCONCLUSIVE" });
    }
  });
}

module.exports = { VALIDATION_STATUSES, validateSessionCookie };
