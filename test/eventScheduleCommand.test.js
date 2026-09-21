const test = require("node:test");
const assert = require("node:assert/strict");
const command = require("../src/commands/eventSchedule");

test("registers the guided Harmony scheduler command", () => {
  const json = command.data.toJSON();
  assert.equal(json.name, "harmony-schedule");
  assert.deepEqual(json.options.map((option) => option.name), ["create", "list", "cancel"]);

  const create = json.options.find((option) => option.name === "create");
  assert.deepEqual(
    create.options.map((option) => option.name),
    ["title", "link", "channel", "date", "time", "message", "timezone"]
  );
  assert.equal(create.options.find((option) => option.name === "timezone").required, false);
});
