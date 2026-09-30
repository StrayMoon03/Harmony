const test = require("node:test");
const assert = require("node:assert/strict");
const command = require("../src/commands/eventSchedule");

test("registers the guided Harmony scheduler command", () => {
  const json = command.data.toJSON();
  assert.equal(json.name, "harmony-schedule");
  assert.deepEqual(json.options.map((option) => option.name), ["create", "list", "cancel", "update", "setup-calendar", "calendar"]);

  const create = json.options.find((option) => option.name === "create");
  assert.deepEqual(
    create.options.map((option) => option.name),
    ["title", "calendar", "event-date", "link", "channel", "date", "time", "message", "event-time", "event-timezone", "description", "category", "all-day", "timezone"]
  );
  assert.equal(create.options.find((option) => option.name === "timezone").required, false);
});
