require("dotenv").config();

const { prepareRuntimeSecrets } = require("./services/runtimeSecrets");
prepareRuntimeSecrets();

const { Client, GatewayIntentBits } = require("discord.js");
const { handleMediaMessage } = require("./handlers/mediaHandler");
const { getDb } = require("./db/sqlite");

if (!process.env.DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is missing from the .env file.");
}

// Open DB and run migrations at startup
getDb();

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
  console.log("MESSAGE RECEIVED:", message.content);
  await handleMediaMessage(message);
});

client.login(process.env.DISCORD_TOKEN);
