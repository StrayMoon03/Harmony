require("dotenv").config();

const { prepareRuntimeSecrets } = require("./services/runtimeSecrets");
prepareRuntimeSecrets();

const { Client, GatewayIntentBits } = require("discord.js");
const { handleMediaMessage } = require("./handlers/mediaHandler");
const { getDb } = require("./db/sqlite");
const forgetShareCommand = require("./commands/forgetShare");
const statusCommand = require("./commands/status");

const commands = [
  forgetShareCommand,
  statusCommand,
];
const commandsByName = new Map(
  commands.map((command) => [command.data.name, command])
);

if (!process.env.DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is missing from the .env file.");
}

// Open DB and run migrations at startup
getDb();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function registerGuildCommands(guild) {
  await guild.commands.set(
    commands.map((command) => command.data.toJSON())
  );

  console.log(
    `Admin commands ready in ${guild.name}: /harmony-forget, /harmony-status`
  );
}

client.once("clientReady", async () => {
  console.log(`💜 Harmony is online as ${client.user.username}!`);

  // Remove stale global copies left by earlier deployments. Harmony now
  // publishes one clean command set directly inside each server.
  try {
    await client.application.commands.set([]);
    console.log("Stale global Harmony commands cleared.");
  } catch (error) {
    console.error("Could not clear stale global Harmony commands:", error);
  }

  for (const guild of client.guilds.cache.values()) {
    try {
      await registerGuildCommands(guild);
    } catch (error) {
      console.error(
        `Could not register Harmony admin commands in ${guild.name}:`,
        error
      );
    }
  }
});

client.on("guildCreate", async (guild) => {
  try {
    await registerGuildCommands(guild);
  } catch (error) {
    console.error(
      `Could not register Harmony admin commands in ${guild.name}:`,
      error
    );
  }
});

client.on("guildMemberAdd", async (member) => {
  const channel = member.guild.systemChannel;
  if (!channel) {
    console.warn(
      "No system channel is configured in " +
        member.guild.name +
        "; welcome message skipped."
    );
    return;
  }

  try {
    await channel.send({
      content:
        "✨ Everyone welcome <@" +
        member.id +
        "> to " +
        member.guild.name +
        "! We’re so happy you found your way here. 💜",
      allowedMentions: {
        users: [member.id],
      },
    });
  } catch (error) {
    console.error(
      "Could not send the welcome message in " +
        member.guild.name +
        ":",
      error
    );
  }
});

client.on("guildMemberRemove", async (member) => {
  const channel = member.guild.systemChannel;
  if (!channel) {
    console.warn(
      "No system channel is configured in " +
        member.guild.name +
        "; departure message skipped."
    );
    return;
  }

  const displayName =
    member.displayName ||
    member.user?.globalName ||
    member.user?.username ||
    "A member";

  try {
    await channel.send({
      content:
        "👋 **" +
        displayName +
        "** has left " +
        member.guild.name +
        ". We wish them well on their journey. 💜",
      allowedMentions: {
        parse: [],
      },
    });
  } catch (error) {
    console.error(
      "Could not send the departure message in " +
        member.guild.name +
        ":",
      error
    );
  }
});

client.on("messageCreate", async (message) => {
  console.log("MESSAGE RECEIVED:", message.content);
  await handleMediaMessage(message);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commandsByName.get(interaction.commandName);
  if (!command) return;

  await command.execute(interaction);
});

client.login(process.env.DISCORD_TOKEN);
