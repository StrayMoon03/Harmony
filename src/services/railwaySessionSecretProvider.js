const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const SECRET_VARIABLES = Object.freeze({
  instagram: "INSTAGRAM_COOKIES_BASE64",
  threads: "THREADS_COOKIES_BASE64",
  facebook: "FACEBOOK_COOKIES_BASE64",
  youtube: "YOUTUBE_COOKIES_BASE64",
});

function createRailwaySessionSecretProvider({
  token = process.env.SESSION_REFRESH_RAILWAY_PROJECT_TOKEN || "",
  serviceId = process.env.SESSION_REFRESH_RAILWAY_SERVICE_ID || "",
  fetchImpl = globalThis.fetch,
} = {}) {
  let scopePromise;

  async function request(query, variables) {
    if (!token || typeof fetchImpl !== "function") throw new Error("rotation_provider_unavailable");
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { "Project-Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error("rotation_provider_unavailable");
    }
    if (!response?.ok) throw new Error("rotation_provider_unavailable");
    let payload;
    try { payload = await response.json(); } catch { throw new Error("rotation_provider_unavailable"); }
    if (payload?.errors?.length || !payload?.data) throw new Error("rotation_provider_unavailable");
    return payload.data;
  }

  async function getScope() {
    if (!scopePromise) {
      scopePromise = request("query { projectToken { projectId environmentId } }", {}).then((data) => {
        const projectId = data.projectToken?.projectId;
        const environmentId = data.projectToken?.environmentId;
        if (!projectId || !environmentId) throw new Error("rotation_provider_unavailable");
        return { projectId, environmentId };
      });
    }
    return scopePromise;
  }

  async function set(service, value) {
    const name = SECRET_VARIABLES[service];
    if (!name || !serviceId || typeof value !== "string" || !value) throw new Error("rotation_provider_unavailable");
    const { projectId, environmentId } = await getScope();
    const data = await request(
      "mutation variableUpsert($input: VariableUpsertInput!) { variableUpsert(input: $input) }",
      { input: { projectId, environmentId, serviceId, name, value, skipDeploys: true } }
    );
    if (data.variableUpsert !== true) throw new Error("rotation_provider_unavailable");
    return true;
  }

  return {
    async rotate(service, base64Value) { return set(service, base64Value); },
    async restore(service, base64Value) { return set(service, base64Value); },
  };
}

module.exports = { ENDPOINT, SECRET_VARIABLES, createRailwaySessionSecretProvider };
