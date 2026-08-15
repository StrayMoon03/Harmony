const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");

const { getDb } = require("../db/sqlite");

const execFileAsync = promisify(execFile);

const data = new SlashCommandBuilder()
  .setName("harmony-status")
  .setDescription("Check Harmony’s private system status")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function fileReady(filePath) {
  if (!filePath) return false;
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size >= 500;
  } catch {
    return false;
  }
}

async function commandReady(command, args = ["--version"]) {
  try {
    await execFileAsync(command, args, {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

function mark(ready) {
  return ready ? "✅ Ready" : "❌ Needs attention";
}

async function execute(interaction) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  try {
    let databaseReady = false;
    try {
      getDb().prepare("SELECT 1").get();
      databaseReady = true;
    } catch {
      databaseReady = false;
    }

    const [
      instagramCookies,
      facebookCookies,
      ytDlp,
      galleryDl,
      ffmpeg,
    ] = await Promise.all([
      fileReady(process.env.INSTAGRAM_COOKIES),
      fileReady(process.env.FACEBOOK_COOKIES),
      commandReady(process.env.YTDLP_PATH || "yt-dlp"),
      commandReady(process.env.GALLERYDL_PATH || "gallery-dl"),
      commandReady(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]),
    ]);

    const uptimeMinutes = Math.floor(process.uptime() / 60);
    const content = [
      "💜 **Harmony Status**",
      "",
      `Bot: ✅ Online (${uptimeMinutes} minute${uptimeMinutes === 1 ? "" : "s"})`,
      `Memory database: ${mark(databaseReady)}`,
      `Instagram cookies: ${mark(instagramCookies)}`,
      `Facebook cookies: ${mark(facebookCookies)}`,
      `yt-dlp: ${mark(ytDlp)}`,
      `gallery-dl: ${mark(galleryDl)}`,
      `ffmpeg: ${mark(ffmpeg)}`,
      "",
      "Instagram, Facebook, TikTok, and X are enabled.",
      "",
      "💜 𝑯𝒂𝒓𝒎𝒐𝒏𝒚",
    ].join("\n");

    await interaction.editReply({ content });
  } catch (error) {
    console.error("Harmony status command error:", error);
    await interaction.editReply({
      content:
        "Harmony is online, but I couldn’t complete the full system check. Please check the Railway logs.",
    }).catch(() => {});
  }
}

module.exports = {
  data,
  execute,
};
