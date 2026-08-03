require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const { handleMediaMessage } = require("./handlers/mediaHandler");

if (!process.env.DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is missing from the .env file.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", () => {
  console.log(`💜 Harmony is online as ${client.user.username}!`);
});

client.on("messageCreate", async (message) => {
  await handleMediaMessage(message);
});

client.login(process.env.DISCORD_TOKEN);