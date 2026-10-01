const test = require("node:test");
const assert = require("node:assert/strict");
const command = require("../src/commands/eventSchedule");

test("registers the guided Harmony scheduler command", () => {
  const json = command.data.toJSON();
  assert.equal(json.name, "harmony-schedule");
  assert.deepEqual(json.options.map((option) => option.name), ["create", "list", "cancel", "update", "setup-calendar", "calendar", "setup-manager"]);
  const setupManager = json.options.find((option) => option.name === "setup-manager");
  assert.deepEqual(setupManager.options.map((option) => option.name), ["control-channel"]);
  assert.equal(setupManager.options[0].required, true);

  const create = json.options.find((option) => option.name === "create");
  assert.deepEqual(
    create.options.map((option) => option.name),
    ["title", "calendar", "event-date", "link", "channel", "date", "time", "message", "event-time", "event-timezone", "description", "category", "all-day", "timezone"]
  );
  assert.equal(create.options.find((option) => option.name === "timezone").required, false);
  const category = create.options.find((option) => option.name === "category");
  assert.ok(category.choices.some((choice) => choice.name === "Shopping / Pop-Up" && choice.value === "shopping"));
});
