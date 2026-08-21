require("dotenv").config();

const { prepareRuntimeSecrets } = require("./services/runtimeSecrets");
prepareRuntimeSecrets();

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { handleMediaMessage } = require("./handlers/mediaHandler");
const { getDb } = require("./db/sqlite");
const forgetShareCommand = require("./commands/forgetShare");
const statusCommand = require("./commands/status");
const greetingsCommand = require("./commands/greetings");
const linkWelcomePassCommand = require("./commands/linkWelcomePass");
const welcomePassSetupCommand = require("./commands/welcomePassSetup");
const welcomePassModeCommand = require("./commands/welcomePassMode");
const collectionStatsCommand = require("./commands/collectionStats");
const collectionLeaderboardCommand = require("./commands/collectionLeaderboard");
const collectionAdminCommand = require("./commands/collectionAdmin");
const messageLogsCommand = require("./commands/messageLogs");
const errorInboxCommand = require("./commands/errorInbox");
const communityGuardCommand = require("./commands/communityGuard");
const moderateMessageCommand = require("./commands/moderateMessage");
const shareStore = require("./stores/shareStore");
const {
  handleDeletedShare,
} = require("./services/shareDeletionService");
const {
  handleLoggedMessageCreate,
  handleLoggedMessageUpdate,
  handleLoggedMessageDelete,
  startMessageLogCleanup,
} = require("./services/messageLogService");
const {
  getGreetingSettings,
  renderGreetingMessage,
} = require("./stores/greetingStore");
const {
  assignAllApprovedWelcomePasses,
  handleManualWelcomePassRoleAdded,
} = require("./services/welcomePassService");
const {
  startWelcomePassServer,
} = require("./services/welcomePassServer");
const {
  handleNewCollectionShare,
  startCollectionScheduler,
} = require("./services/collectionService");
const {
  handleGuardedMessage,
  handleGuardComponent,
} = require("./services/communityGuardService");

const commands = [
  forgetShareCommand,
  statusCommand,
  greetingsCommand,
  linkWelcomePassCommand,
  welcomePassSetupCommand,
  welcomePassModeCommand,
  collectionStatsCommand,
  collectionLeaderboardCommand,
  collectionAdminCommand,
  messageLogsCommand,
  errorInboxCommand,
  communityGuardCommand,
  moderateMessageCommand,
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
  partials: [Partials.Message, Partials.Channel],
});

startWelcomePassServer(client);
shareStore.onInserted((record) =>
  handleNewCollectionShare(client, record)
);

async function registerGuildCommands(guild) {
  await guild.commands.set(
    commands.map((command) => command.data.toJSON())
  );

  console.log(
    "Harmony commands ready in " + guild.name + ": " +
      "/harmony-forget, /harmony-status, /harmony-greetings, " +
      "/harmony-pass, /harmony-pass-setup, /harmony-pass-mode, " +
      "/harmony-stats, /harmony-leaderboard, /harmony-collection, /harmony-logs, " +
      "/harmony-errors, /harmony-guard, Harmony: Moderate Message"
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
        `Could not register Harmony commands in ${guild.name}:`,
        error
      );
    }
  }

  await assignAllApprovedWelcomePasses(client);
  startCollectionScheduler(client);
  startMessageLogCleanup(client);
});

client.on("guildCreate", async (guild) => {
  try {
    await registerGuildCommands(guild);
  } catch (error) {
    console.error(
      `Could not register Harmony commands in ${guild.name}:`,
      error
    );
  }
});

async function getConfiguredGreetingChannel(guild, settings) {
  const cached = guild.channels.cache.get(settings.channel_id);
  const channel =
    cached ||
    (await guild.channels
      .fetch(settings.channel_id)
      .catch(() => null));

  return channel && channel.isTextBased()
    ? channel
    : null;
}

client.on("guildMemberAdd", async (member) => {
  console.log(
    "Greeting join event received:",
    member.user.username,
    "in",
    member.guild.name
  );

  if (member.user.bot) {
    console.log("Greeting skipped: joining account is a bot.");
    return;
  }

  const settings = getGreetingSettings(member.guild.id);
  if (!settings || !settings.enabled) {
    console.log("Greeting skipped: greetings are not configured or are off.");
    return;
  }

  const channel = await getConfiguredGreetingChannel(
    member.guild,
    settings
  );
  if (!channel) {
    console.warn(
      "Configured greeting channel is unavailable in " +
        member.guild.name +
        "."
    );
    return;
  }

  const content = renderGreetingMessage(
    settings.entrance_message,
    {
      memberMention: "<@" + member.id + ">",
      memberName:
        member.displayName ||
        member.user.globalName ||
        member.user.username,
      serverName: member.guild.name,
    }
  );

  try {
    await channel.send({
      content,
      allowedMentions: {
        users: [member.id],
      },
    });
    console.log(
      "Entrance greeting delivered for",
      member.user.username,
      "in",
      member.guild.name
    );
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
  if (member.user.bot) return;

  const settings = getGreetingSettings(member.guild.id);
  if (!settings || !settings.enabled) return;

  const channel = await getConfiguredGreetingChannel(
    member.guild,
    settings
  );
  if (!channel) {
    console.warn(
      "Configured greeting channel is unavailable in " +
        member.guild.name +
        "."
    );
    return;
  }

  const memberName =
    member.displayName ||
    member.user.globalName ||
    member.user.username ||
    "A member";
  const content = renderGreetingMessage(
    settings.exit_message,
    {
      memberName,
      serverName: member.guild.name,
    }
  );

  try {
    await channel.send({
      content,
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


client.on("guildMemberUpdate", async (oldMember, newMember) => {
  try {
    await handleManualWelcomePassRoleAdded(oldMember, newMember);
  } catch (error) {
    console.error(
      "Could not process a manually granted Welcome Pass role:",
      error
    );
  }
});

client.on("messageCreate", async (message) => {
  console.log("MESSAGE RECEIVED:", message.content);

  try {
    const heldOrRemoved = await handleGuardedMessage(message);
    if (heldOrRemoved) return;
  } catch (error) {
    console.error("Community Guard message check failed:", error);
  }

  await handleLoggedMessageCreate(message);
  await handleMediaMessage(message);
});

client.on("messageUpdate", async (oldMessage, newMessage) => {
  await handleLoggedMessageUpdate(oldMessage, newMessage);
});

client.on("messageDelete", async (message) => {
  await handleLoggedMessageDelete(message);

  try {
    await handleDeletedShare(message);
  } catch (error) {
    console.error("Could not forget a deleted share:", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    if (await handleGuardComponent(interaction)) return;
  }

  if (
    !interaction.isChatInputCommand() &&
    !interaction.isMessageContextMenuCommand()
  ) return;

  const command = commandsByName.get(interaction.commandName);
  if (!command) return;

  await command.execute(interaction);
});

client.login(process.env.DISCORD_TOKEN);
