require("dotenv").config();

const { prepareRuntimeSecrets } = require("./services/runtimeSecrets");
prepareRuntimeSecrets();

const { Client, GatewayIntentBits } = require("discord.js");
const { handleMediaMessage } = require("./handlers/mediaHandler");
const { getDb } = require("./db/sqlite");
const forgetShareCommand = require("./commands/forgetShare");

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

client.once("clientReady", async () => {
  console.log(`💜 Harmony is online as ${client.user.username}!`);

  try {
    const commands = await client.application.commands.fetch();
    const existing = commands.find(
      (command) => command.name === forgetShareCommand.data.name
    );
    const commandData = forgetShareCommand.data.toJSON();

    if (existing) {
      await client.application.commands.edit(
        existing.id,
        commandData
      );
    } else {
      await client.application.commands.create(commandData);
    }

    console.log("Admin command ready: /harmony-forget");
  } catch (error) {
    console.error(
      "Could not register /harmony-forget:",
      error
    );
  }
});

client.on("messageCreate", async (message) => {
  console.log("MESSAGE RECEIVED:", message.content);
  await handleMediaMessage(message);
});

client.on("interactionCreate", async (interaction) => {
  if (
    !interaction.isChatInputCommand() ||
    interaction.commandName !== forgetShareCommand.data.name
  ) {
    return;
  }

  await forgetShareCommand.execute(interaction);
});

client.login(process.env.DISCORD_TOKEN);
