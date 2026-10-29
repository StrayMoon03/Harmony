const auditStore = require("../stores/operationsAuditStore");
const requestStore = require("../stores/credentialRefreshStore");
const runtimeSecrets = require("./runtimeSecrets");
const { validateSessionCookie } = require("./sessionCookieValidator");
const { createRailwaySessionSecretProvider } = require("./railwaySessionSecretProvider");
const { SECRET_VARIABLES } = require("./sessionRefreshConfig");
const { recordSocialSuccess } = require("./operationsStatusService");

const RESULT_MESSAGES = Object.freeze({
  invalid_format: "That does not look like a supported cookie export. The existing session was kept.",
  invalid_session: "The platform did not confirm an active signed-in session. The existing session was kept.",
  owner_required: "The platform returned a security checkpoint. The existing session was kept; owner attention is required.",
  validation_unavailable: "Harmony could not safely verify that session. The existing session was kept.",
  rotation_failure: "Harmony could not update the session setting. The existing session was preserved.",
  rollback_attention: "Harmony could not confirm the session setting was restored. Stop and contact the owner; no credential details are shown here.",
  activation_failure: "Harmony could not safely activate the new session. The previous session was restored.",
  activation_rollback_attention: "Session activation failed and the previous setting could not be confirmed. Contact the owner before retrying.",
  success: "Cookies refreshed, activated, and verified. No restart was required.",
});

function base64Buffer(buffer) {
  return buffer.toString("base64");
}

function createSessionRefreshWorkflow({
  validator = validateSessionCookie,
  providerFactory = () => createRailwaySessionSecretProvider(),
  runtime = runtimeSecrets,
  audit = auditStore,
  requests = requestStore,
  onSuccess = recordSocialSuccess,
  now = () => new Date().toISOString(),
} = {}) {
  function record(context, service, stage, success) {
    try {
      audit.recordCredentialRefreshStage({
        guildId: context.guildId,
        actorId: context.actorId,
        service,
        stage,
        success,
      });
    } catch {
      // Audit storage failure must not interrupt a rollback or reveal secrets.
    }
  }

  function complete(context, service) {
    requests.completeRequest({
      requestId: context.requestId,
      guildId: context.guildId,
      actorId: context.actorId,
      service,
      now: now(),
    });
  }

  async function submit(context, candidate) {
    const { service } = context;
    if (!SECRET_VARIABLES[service] || typeof candidate !== "string" || Buffer.byteLength(candidate, "utf8") > 1024 * 1024) {
      record(context, service, "validation", false);
      complete(context, service);
      return { ok: false, reason: "invalid_format", message: RESULT_MESSAGES.invalid_format };
    }

    let validation;
    try {
      validation = await validator(service, candidate);
    } catch {
      validation = { status: "INCONCLUSIVE" };
    }
    if (validation?.status !== "AUTHENTICATED") {
      const reason = validation?.status === "INVALID_FORMAT" ? "invalid_format"
        : validation?.status === "OWNER_REQUIRED" ? "owner_required"
          : validation?.status === "UNAUTHENTICATED" ? "invalid_session" : "validation_unavailable";
      record(context, service, "validation", false);
      complete(context, service);
      return { ok: false, reason, message: RESULT_MESSAGES[reason] };
    }
    record(context, service, "validation", true);

    let previous;
    let candidateBuffer;
    let previousBase64;
    const previousBase64Env = process.env[SECRET_VARIABLES[service]];
    let swap;
    let provider;
    let activationAttempted = false;
    let verificationAttempted = false;
    try {
      previous = runtime.readCurrentSession(service);
      candidateBuffer = Buffer.from(candidate, "utf8");
      previousBase64 = base64Buffer(previous);
      const nextBase64 = base64Buffer(candidateBuffer);
      provider = providerFactory();
      await provider.rotate(service, nextBase64);
      record(context, service, "rotation", true);
      activationAttempted = true;
      swap = runtime.activateRuntimeSession(service, candidateBuffer);
      process.env[SECRET_VARIABLES[service]] = nextBase64;

      let verified;
      verificationAttempted = true;
      try { verified = await validator(service, candidateBuffer.toString("utf8")); }
      catch { verified = { status: "INCONCLUSIVE" }; }
      if (verified?.status !== "AUTHENTICATED") {
        record(context, service, "activation", false);
        record(context, service, "verification", false);
        record(context, service, "rotation", false);
        let runtimeRestored = true;
        try { runtimeRestored = swap.rollback() !== false; } catch { runtimeRestored = false; }
        if (previousBase64Env === undefined) delete process.env[SECRET_VARIABLES[service]];
        else process.env[SECRET_VARIABLES[service]] = previousBase64Env;
        try {
          await provider.restore(service, previousBase64);
          complete(context, service);
          return runtimeRestored
            ? { ok: false, reason: "activation_failure", message: RESULT_MESSAGES.activation_failure }
            : { ok: false, reason: "activation_rollback_attention", message: RESULT_MESSAGES.activation_rollback_attention };
        } catch {
          complete(context, service);
          return { ok: false, reason: "activation_rollback_attention", message: RESULT_MESSAGES.activation_rollback_attention };
        }
      }

      record(context, service, "activation", true);
      record(context, service, "verification", true);
      onSuccess(service);
      complete(context, service);
      swap.commit();
      return { ok: true, reason: "success", message: RESULT_MESSAGES.success };
    } catch {
      let runtimeRestored = true;
      if (swap) {
        try { runtimeRestored = swap.rollback() !== false; } catch { runtimeRestored = false; }
      }
      if (activationAttempted) record(context, service, "activation", false);
      if (verificationAttempted) record(context, service, "verification", false);
      let restored = true;
      if (previousBase64Env === undefined) delete process.env[SECRET_VARIABLES[service]];
      else process.env[SECRET_VARIABLES[service]] = previousBase64Env;
      if (provider && previousBase64) {
        try {
          await provider.restore(service, previousBase64);
        } catch {
          restored = false;
        }
      }
      record(context, service, "rotation", false);
      if (!restored || !runtimeRestored) {
        complete(context, service);
        return { ok: false, reason: "rollback_attention", message: RESULT_MESSAGES.rollback_attention };
      }
      complete(context, service);
      return { ok: false, reason: "rotation_failure", message: RESULT_MESSAGES.rotation_failure };
    } finally {
      previous?.fill(0);
      candidateBuffer?.fill(0);
      if (typeof candidate === "string") candidate = "";
      previousBase64 = "";
    }
  }

  return { submit };
}

module.exports = { RESULT_MESSAGES, createSessionRefreshWorkflow };
