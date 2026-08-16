const http = require("node:http");
const crypto = require("node:crypto");
const {
  normalizeWelcomePassCode,
  isValidWelcomePassCode,
  recordWelcomePassApproval,
} = require("../stores/welcomePassStore");
const {
  assignApprovedWelcomePass,
} = require("./welcomePassService");

const MAX_BODY_BYTES = 16 * 1024;

function secureSecretMatch(supplied, expected) {
  if (!supplied || !expected) return false;
  const suppliedHash = crypto.createHash("sha256").update(supplied).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(suppliedHash, expectedHash);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

function startWelcomePassServer(client) {
  const port = Number(process.env.PORT || 3000);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (
      request.method !== "POST" ||
      url.pathname !== "/welcome-pass/approved"
    ) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    const expectedSecret = process.env.WELCOME_PASS_SHARED_SECRET;
    if (!expectedSecret) {
      sendJson(response, 503, { error: "approval_endpoint_not_configured" });
      return;
    }

    const authorization = request.headers.authorization || "";
    const suppliedSecret = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

    if (!secureSecretMatch(suppliedSecret, expectedSecret)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    try {
      const body = await readJsonBody(request);
      const code = normalizeWelcomePassCode(body.code);
      if (!isValidWelcomePassCode(code)) {
        sendJson(response, 400, { error: "invalid_confirmation_code" });
        return;
      }

      recordWelcomePassApproval({
        code,
        approverName: body.approverName,
      });
      const result = await assignApprovedWelcomePass(client, code);
      const pending = [
        "waiting_for_link",
        "waiting_for_setup",
        "member_missing",
      ].includes(result.status);

      sendJson(response, pending ? 202 : 200, {
        ok: true,
        code,
        status: result.status,
      });
    } catch (error) {
      if (error.message === "body_too_large") {
        sendJson(response, 413, { error: "body_too_large" });
        return;
      }
      if (error.message === "invalid_json") {
        sendJson(response, 400, { error: "invalid_json" });
        return;
      }
      console.error("Welcome Pass approval endpoint error:", error);
      sendJson(response, 500, { error: "internal_error" });
    }
  });

  server.listen(port, () => {
    console.log("Harmony health server listening on port " + port + ".");
    if (!process.env.WELCOME_PASS_SHARED_SECRET) {
      console.warn(
        "WELCOME_PASS_SHARED_SECRET is missing; automatic Welcome Pass approvals are disabled."
      );
    }
  });

  return server;
}

module.exports = { startWelcomePassServer };
