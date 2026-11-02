import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const cliRoot = dirname(require.resolve("trigger.dev/package.json"));
const { getPatApiClient } = await import(
  pathToFileURL(join(cliRoot, "dist/esm/commands/projects/common.js")).href
);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const client = await getPatApiClient({ profile: "test" });
if (new URL(client.apiURL).hostname !== "test-cloud.trigger.dev")
  throw new Error("Refusing non-test cloud");
const environment = await client.getProjectEnv({
  projectRef: "proj_wcwcgcodbajkuocrovpq",
  env: "prod",
});
if (!environment.success) throw new Error(environment.error);
const { apiUrl, apiKey } = environment.data;
if (new URL(apiUrl).hostname !== "test-api.trigger.dev") throw new Error("Refusing non-test API");

if (process.argv[2] === "configure") {
  const { CliApiClient } = await import(pathToFileURL(join(cliRoot, "dist/esm/apiClient.js")).href);
  const project = new CliApiClient(apiUrl, apiKey);
  const variables = await project.getEnvironmentVariables("proj_wcwcgcodbajkuocrovpq");
  if (!variables.success)
    throw new Error("Could not inspect artifact authentication configuration");
  let artifactSecret = variables.data.variables.DEMO_ARTIFACT_SECRET;
  if (artifactSecret !== undefined && !/^[a-f0-9]{64}$/.test(artifactSecret)) {
    throw new Error("Existing artifact secret could not be reused; refusing to rotate it");
  }
  if (!artifactSecret) {
    artifactSecret = randomBytes(32).toString("hex");
    const imported = await project.importEnvVars("proj_wcwcgcodbajkuocrovpq", "prod", {
      variables: { DEMO_ARTIFACT_SECRET: artifactSecret },
      override: true,
      isSecret: true,
    });
    if (!imported.success) throw new Error("Could not configure Trigger artifact authentication");
    console.log("Configured Trigger artifact authentication");
  }
  for (const [name, value] of Object.entries({
    DEMO_ARTIFACT_SECRET: artifactSecret,
    TRIGGER_SECRET_KEY: apiKey,
    TRIGGER_API_URL: apiUrl,
    DEMO_ENABLED: process.argv.includes("--enable") ? "true" : "false",
  })) {
    const child = spawnSync(`${root}/node_modules/.bin/convex`, ["env", "set", name], {
      cwd: root,
      input: value,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.status !== 0)
      throw new Error(`Failed to set ${name}; check Convex login and deployment selection`);
    console.log(`Configured ${name}`);
  }
} else if (process.argv[2] === "status") {
  const response = await fetch(`${apiUrl}/api/v1/deployments/current`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`Deployment lookup returned HTTP ${response.status}`);
  const { status, shortCode, version } = await response.json();
  console.log(JSON.stringify({ status, shortCode, version }));
} else {
  throw new Error("Use configure [--enable] or status");
}
