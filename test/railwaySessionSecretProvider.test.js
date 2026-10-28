const test = require("node:test");
const assert = require("node:assert/strict");
const { createRailwaySessionSecretProvider, ENDPOINT, SECRET_VARIABLES } = require("../src/services/railwaySessionSecretProvider");

test("Railway provider writes only the selected cookie variable with deploys skipped", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (calls.length === 1) return new Response(JSON.stringify({ data: { projectToken: { projectId: "project", environmentId: "environment" } } }));
    return new Response(JSON.stringify({ data: { variableUpsert: true } }));
  };
  const provider = createRailwaySessionSecretProvider({ token: "mock-token", serviceId: "harmony-service", fetchImpl });
  await provider.rotate("instagram", "mock-candidate-base64");
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].options.headers["Project-Access-Token"], "mock-token");
  assert.deepEqual(calls[1].body.variables.input, {
    projectId: "project", environmentId: "environment", serviceId: "harmony-service",
    name: SECRET_VARIABLES.instagram, value: "mock-candidate-base64", skipDeploys: true,
  });
  assert.equal(Object.keys(SECRET_VARIABLES).length, 4);
});

test("Railway provider rejects unsupported variables and hides provider error details", async () => {
  const provider = createRailwaySessionSecretProvider({ token: "mock-token", serviceId: "harmony-service", fetchImpl: async () => new Response(JSON.stringify({ errors: [{ message: "PRIVATE_PROVIDER_DETAIL" }] })) });
  await assert.rejects(provider.rotate("other", "candidate"), /rotation_provider_unavailable/);
  await assert.rejects(provider.rotate("youtube", "candidate"), /rotation_provider_unavailable/);
});
