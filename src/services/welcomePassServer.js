const http = require("node:http");
const crypto = require("node:crypto");
const {
  normalizeWelcomePassCode,
  isValidWelcomePassCode,
  recordWelcomePassApproval,
  linkSelectedWelcomePassMember,
  archiveWelcomePassDeparture,
  getWelcomePassDeparture,
  getWelcomePassAssignment,
  getWelcomePassSettings,
} = require("../stores/welcomePassStore");
const { saveWelcomePassBirthdayProfile } = require("../stores/birthdayStore");
const { normalizeBiases } = require("./memberBiases");
const { validMmdd } = require("./birthdayService");
const {
  autoLinkWelcomePassByDiscordUsername,
  assignApprovedWelcomePass,
  isWelcomePassAssignmentRunning,
} = require("./welcomePassService");
const { sendWelcomePassSubmissionAlert } = require("./welcomePassSubmissionService");
const { startSessionRefreshWebService } = require("./sessionRefreshWebService");

const { selectedMember, listMembers } = require("./welcomePassMemberService");
const approvalJobs = new Set();

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
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        tooLarge = true;
        body = "";
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new Error("body_too_large"));
        return;
      }
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
  const handleSessionRefresh = startSessionRefreshWebService(client);

  const server = http.createServer(async (request, response) => {
    if (await handleSessionRefresh(request, response)) return;
    const url = new URL(request.url, "http://localhost");

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method !== "POST" || !["/welcome-pass/approved", "/welcome-pass/submitted", "/welcome-pass/members", "/welcome-pass/member", "/welcome-pass/departed"].includes(url.pathname)) {
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
      if (url.pathname === "/welcome-pass/members") {
        sendJson(response, 200, { ok: true, ...await listMembers(client, body.after) });
        return;
      }
      if (url.pathname === "/welcome-pass/member") {
        const code = normalizeWelcomePassCode(body.code);
        if (!isValidWelcomePassCode(code)) { sendJson(response, 400, { error: "invalid_confirmation_code" }); return; }
        const checked = await selectedMember(client, code, body.userId);
        sendJson(response, checked.ok ? 200 : 409, checked);
        return;
      }
      if (url.pathname === "/welcome-pass/submitted") {
        const reference = normalizeWelcomePassCode(body.reference);
        const discordUsername = typeof body.discordUsername === "string" ? body.discordUsername.trim() : "";
        const facebookName = typeof body.facebookName === "string" ? body.facebookName.trim() : "";
        const submittedAt = typeof body.submittedAt === "string" ? body.submittedAt.trim() : "";
        const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
        if (!isValidWelcomePassCode(reference)) {
          sendJson(response, 400, { error: "invalid_reference" });
          return;
        }
        if (!discordUsername || discordUsername.length > 80 || !facebookName || facebookName.length > 100) {
          sendJson(response, 400, { error: "invalid_submission_fields" });
          return;
        }
        if (!isoTimestamp.test(submittedAt) || !Number.isFinite(Date.parse(submittedAt)) || new Date(submittedAt).toISOString() !== submittedAt) {
          sendJson(response, 400, { error: "invalid_submitted_at" });
          return;
        }

        const result = await sendWelcomePassSubmissionAlert(client, {
          reference,
          discordUsername,
          facebookName,
          submittedAt,
        });
        if (result.status === "notified" || result.status === "already_notified" || result.status === "already_attempted") {
          sendJson(response, 200, { ok: true, status: result.status });
          return;
        }
        if (result.status === "delivery_failed") {
          sendJson(response, 502, { error: "notification_delivery_failed" });
          return;
        }
        sendJson(response, 503, { error: result.status });
        return;
      }

      const code = normalizeWelcomePassCode(body.code);
      if (!isValidWelcomePassCode(code)) {
        sendJson(response, 400, { error: "invalid_confirmation_code" });
        return;
      }

      if (url.pathname === "/welcome-pass/departed") {
        if (approvalJobs.has(code) || isWelcomePassAssignmentRunning(code)) { sendJson(response, 409, { error: "approval_in_progress" }); return; }
        archiveWelcomePassDeparture(code);
        sendJson(response, 200, { ok: true, recorded: true, code, status: "departed" });
        return;
      }
      if (getWelcomePassDeparture(code)) { sendJson(response, 410, { error: "departed" }); return; }
      if ((body.requireAdmission !== undefined && typeof body.requireAdmission !== "boolean")
        || (body.requireAdmission === true && (typeof body.discordMemberId !== "string" || !/^\d{17,20}$/.test(body.discordMemberId)))) {
        sendJson(response, 400, { error: "invalid_discord_member" }); return;
      }

      const birthdayOptIn =
        body.birthdayOptIn === true &&
        validMmdd(body.birthdayMmdd);
      let memberBiases;
      try {
        const rawBiases = body.biases ?? body.birthdayBiases ?? body.birthdayBias;
        memberBiases = normalizeBiases(
          rawBiases === undefined && birthdayOptIn ? ["Still deciding"] : rawBiases,
          { allowEmpty: true }
        );
      } catch (error) {
        sendJson(response, 400, { error: "invalid_member_bias_selection" });
        return;
      }
      if (approvalJobs.has(code)) { sendJson(response, 409, { error: "approval_in_progress" }); return; }
      approvalJobs.add(code);
      try {
        // Validate selected identity and all fields before recording approval.
        let matchResult;
        if (body.discordMemberId !== undefined) {
          const checked = await selectedMember(client, code, body.discordMemberId);
          if (!checked.ok) { sendJson(response, 409, { error: checked.reason }); return; }
          if (body.requireAdmission === true && getWelcomePassSettings(checked.guildId)?.grant_mode === "manual") {
            sendJson(response, 409, { error: "manual_role_required" }); return;
          }
          const linked = linkSelectedWelcomePassMember({ code, guildId: checked.guildId, userId: checked.userId });
          if (!linked.ok) { sendJson(response, 409, { error: linked.reason }); return; }
          matchResult = { status: "admin_selected", guildId: checked.guildId, userId: checked.userId };
        }
        recordWelcomePassApproval({ code, approverName: body.approverName });
        saveWelcomePassBirthdayProfile({
          code,
          celebrationEnabled: birthdayOptIn,
          birthdayMmdd: birthdayOptIn ? String(body.birthdayMmdd) : null,
          birthdayName: birthdayOptIn
            ? String(body.birthdayName || "").trim().slice(0, 80)
            : null,
          discordUsername: String(body.discordUsername || "").slice(0, 100),
          timezone: birthdayOptIn
            ? String(body.timezone || "").trim().slice(0, 100)
            : null,
          biases: memberBiases,
        });

        matchResult = matchResult || await autoLinkWelcomePassByDiscordUsername(
          client,
          code,
          String(body.discordUsername || "").slice(0, 100)
        );
        const result = await assignApprovedWelcomePass(client, code);
        let discordMember;
        if (body.requireAdmission === true) {
          // A historical assigned_at alone is not proof of CURRENT admission.
          const assignment = getWelcomePassAssignment(code);
          const guild = client.guilds.cache.get(matchResult.guildId) || await client.guilds.fetch(matchResult.guildId);
          const member = await guild.members.fetch({ user: body.discordMemberId, force: true }).catch((error) => {
            if (error.code === 10007) return null;
            throw error;
          });
          const settings = getWelcomePassSettings(matchResult.guildId);
          if (!["assigned", "already_assigned", "reconciled"].includes(result.status) || !assignment?.assigned_at
            || assignment.user_id !== body.discordMemberId || assignment.guild_id !== guild.id || !member || member.id !== body.discordMemberId || member.user.bot || !settings?.role_id || !member.roles.cache.has(settings.role_id)) {
            sendJson(response, 409, { ok: false, recorded: true, code, status: result.status, error: "selected_admission_not_confirmed" }); return;
          }
          discordMember = { id: member.id, username: member.user.username, guildId: guild.id };
        }
        const pending = [
          "waiting_for_link",
          "waiting_for_setup",
          "member_missing",
          "manual_role_required",
        ].includes(result.status);

        const accepted = pending || ["assigned", "already_assigned", "reconciled"].includes(result.status);
        console.info("Welcome Pass approval processed:", code, result.status);
        sendJson(response, accepted ? (pending ? 202 : 200) : 503, {
          ok: accepted,
          recorded: true,
          code,
          status: result.status,
          matchStatus: matchResult.status,
          ...(discordMember ? { admitted: true, discordMember } : {}),
        });
      } finally { approvalJobs.delete(code); }
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
