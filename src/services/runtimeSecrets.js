const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const SESSION_PATH_ENV = Object.freeze({
  instagram: "INSTAGRAM_COOKIES",
  threads: "THREADS_COOKIES",
  facebook: "FACEBOOK_COOKIES",
  youtube: "YOUTUBE_COOKIES",
});

function materializeBase64Secret(sourceName, targetName, filename) {
  const encoded = process.env[sourceName];

  if (!encoded) return;

  try {
    const value = Buffer.from(encoded.trim(), "base64");

    if (value.length === 0) {
      throw new Error("decoded value is empty");
    }

    const secretsDir = path.join(os.tmpdir(), "harmony-secrets");
    fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

    const targetPath = path.join(secretsDir, filename);
    fs.writeFileSync(targetPath, value, { mode: 0o600 });
    process.env[targetName] = targetPath;

    console.log(`${targetName} prepared securely for this deployment.`);
  } catch (error) {
    console.error(
      `Could not prepare ${targetName}:`,
      error instanceof Error ? error.message : error
    );
  }
}

function prepareRuntimeSecrets() {
  materializeBase64Secret(
    "INSTAGRAM_COOKIES_BASE64",
    "INSTAGRAM_COOKIES",
    "instagram-cookies.txt"
  );
  materializeBase64Secret(
    "FACEBOOK_COOKIES_BASE64",
    "FACEBOOK_COOKIES",
    "facebook-cookies.txt"
  );
  materializeBase64Secret(
    "YOUTUBE_COOKIES_BASE64",
    "YOUTUBE_COOKIES",
    "youtube-cookies.txt"
  );
  materializeBase64Secret(
    "THREADS_COOKIES_BASE64",
    "THREADS_COOKIES",
    "threads-cookies.txt"
  );
}

function readCurrentSession(service) {
  const envName = SESSION_PATH_ENV[service];
  if (!envName || !process.env[envName]) throw new Error("session_not_materialized");
  return fs.readFileSync(process.env[envName]);
}

function activateRuntimeSession(service, candidate) {
  const envName = SESSION_PATH_ENV[service];
  if (!envName || !process.env[envName] || !Buffer.isBuffer(candidate)) throw new Error("session_activation_unavailable");
  const targetPath = process.env[envName];
  const previous = fs.readFileSync(targetPath);
  const temporaryPath = path.join(path.dirname(targetPath), `.refresh-${service}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, candidate, { mode: 0o600, flag: "wx" });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    previous.fill(0);
    throw error;
  }
  let finished = false;
  return {
    rollback() {
      if (finished) return false;
      const rollbackPath = path.join(path.dirname(targetPath), `.rollback-${service}-${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(rollbackPath, previous, { mode: 0o600, flag: "wx" });
        fs.chmodSync(rollbackPath, 0o600);
        fs.renameSync(rollbackPath, targetPath);
      } catch (error) {
        try { fs.unlinkSync(rollbackPath); } catch {}
        previous.fill(0);
        throw error;
      }
      previous.fill(0);
      finished = true;
      return true;
    },
    commit() {
      if (finished) return false;
      previous.fill(0);
      finished = true;
      return true;
    },
  };
}

module.exports = { prepareRuntimeSecrets, readCurrentSession, activateRuntimeSession, SESSION_PATH_ENV };
