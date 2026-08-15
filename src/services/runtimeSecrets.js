const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
}

module.exports = { prepareRuntimeSecrets };
