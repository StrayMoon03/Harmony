const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const commandModules = fs.readdirSync(path.join(__dirname, "../src/commands"))
  .filter((filename) => filename.endsWith(".js"))
  .sort()
  .map((filename) => require(path.join(__dirname, "../src/commands", filename)));
commandModules.push(require("../src/services/adminRoomService"));

function validateOptions(options, commandName, location = "options", parentType = "root") {
  const problems = [];
  if (!Array.isArray(options)) return problems;
  if (options.length > 25) problems.push(`${location} has more than 25 options`);
  const names = new Set();
  let optionalSeen = false;
  const hasSubcommands = options.some((option) => option.type === 1 || option.type === 2);
  const hasRegularOptions = options.some((option) => option.type !== 1 && option.type !== 2);
  if (parentType === "root" && hasSubcommands && hasRegularOptions) {
    problems.push(`${location} mixes subcommands and regular options`);
  }

  for (const option of options) {
    const optionName = String(option.name || "");
    const normalizedName = optionName.toLocaleLowerCase("en-US");
    if (names.has(normalizedName)) problems.push(`${location} repeats option name ${optionName}`);
    names.add(normalizedName);
    if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(optionName)) problems.push(`${location} has invalid option name ${optionName}`);

    if (option.type === 1 || option.type === 2) {
      if (option.required) problems.push(`${location}/${optionName} structural options cannot be required`);
      if (parentType === "subcommand") problems.push(`${location}/${optionName} nests a subcommand`);
      if (option.type === 2 && parentType !== "root") problems.push(`${location}/${optionName} nests a subcommand group`);
      if (option.type === 1 && option.options?.some((child) => child.type === 1 || child.type === 2)) {
        problems.push(`${location}/${optionName} nests structural options`);
      }
      if (option.type === 2 && option.options?.some((child) => child.type !== 1)) {
        problems.push(`${location}/${optionName} contains a non-subcommand option`);
      }
      const childType = option.type === 2 ? "group-child" : "subcommand";
      problems.push(...validateOptions(option.options || [], commandName, `${location}/${optionName}`, childType));
      continue;
    }

    if (option.required) {
      if (optionalSeen) problems.push(`${location} has required option ${optionName} after an optional option`);
    } else {
      optionalSeen = true;
    }
    if (option.choices?.length > 25) problems.push(`${location}/${optionName} has more than 25 choices`);
    if (option.min_value != null && option.max_value != null && option.min_value > option.max_value) {
      problems.push(`${location}/${optionName} has min_value greater than max_value`);
    }
  }
  return problems;
}

test("every registered Harmony application command serializes with a valid Discord schema", () => {
  const definitions = commandModules.map((module) => module.data.toJSON());
  const commandNames = new Set();
  const problems = [];

  for (const command of definitions) {
    const key = `${command.type || 1}:${String(command.name).toLocaleLowerCase("en-US")}`;
    if (commandNames.has(key)) problems.push(`duplicate top-level command ${command.name}`);
    commandNames.add(key);
    if (command.options?.length > 25) problems.push(`${command.name} has more than 25 top-level options`);
    problems.push(...validateOptions(command.options || [], command.name, command.name));
  }

  assert.deepEqual(problems, [], problems.join("\n"));
});

test("/harmony-guard preserves one required rule-add field for each mandatory value and unique edit conditions", () => {
  const command = commandModules.find((module) => module.data.name === "harmony-guard").data.toJSON();
  const add = command.options.find((option) => option.name === "rule-add");
  const edit = command.options.find((option) => option.name === "rule-edit");

  assert.deepEqual(add.options.filter((option) => option.required).map((option) => option.name), ["type", "reason"]);
  assert.deepEqual(edit.options.filter((option) => /^condition-\d+-(type|value)$/.test(option.name)).map((option) => option.name), [
    "condition-1-type", "condition-1-value",
    "condition-2-type", "condition-2-value",
    "condition-3-type", "condition-3-value",
    "condition-4-type", "condition-4-value",
    "condition-5-type", "condition-5-value",
  ]);
});
