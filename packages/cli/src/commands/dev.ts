import fs from "fs/promises";
import pathModule from "path";
import { detectNextJsProject } from "../utils/detectNextJsProject.js";
import { logger } from "../utils/logger.js";
import { resolvePath } from "../utils/parseNameAndPath.js";
import ngrok from "ngrok";
import { z } from "zod";
import { TriggerApi } from "../utils/triggerApi.js";

export const DevCommandOptionsSchema = z.object({
  port: z.coerce.number(),
  envFile: z.string(),
  tunnel: z.union([z.literal("ngrok"), z.literal("localtunnel")]),
});

export async function devCommand(path: string, anyOptions: any) {
  const result = DevCommandOptionsSchema.safeParse(anyOptions);
  if (!result.success) {
    logger.error(result.error.message);
    process.exit(1);
  }
  const options = result.data;

  const resolvedPath = resolvePath(path);
  // Detect if are are in a Next.js project
  const isNextJsProject = await detectNextJsProject(resolvedPath);
  if (!isNextJsProject) {
    logger.error(
      `You must run this command in a Next.js project: ${resolvedPath}`
    );
    process.exit(1);
  }
  logger.success(`✅ Detected valid Next.js project`);

  // Read from package.json to get the endpointId
  const endpointId = await getEndpointIdFromPackageJson(resolvedPath);
  if (!endpointId) {
    logger.error(
      "You must run the `init` command first to setup the project – you are missing \n'trigger.dev': { 'endpointId': 'your-client-id' } from your package.json file."
    );
    process.exit(1);
  }
  logger.success(`✅ Detected TriggerClient id: ${endpointId}`);

  // Read from .env.local to get the TRIGGER_API_KEY and TRIGGER_API_URL
  const { apiKey, apiUrl } = await getTriggerApiDetails(
    resolvedPath,
    options.envFile
  );
  logger.success(`✅ Found API Key in ${options.envFile} file`);
  const apiClient = new TriggerApi(apiKey, apiUrl);

  // Setup tunnel
  const tunnelUrl = await createTunnel(options.port);
  logger.success(`🚇 Created tunnel: ${tunnelUrl}`);

  logger.info(`Connecting to Trigger.dev...`);
  //wait 200ms
  // await wait(200);

  //do initial refresh of the endpoint
  //todo get path for API
  await refreshEndpoint(apiClient, endpointId, tunnelUrl);
  logger.success(`🔄 Updated your Jobs`);

  // Watch for changes to .ts files and call triggerApi.indexEndpoint
}

async function getEndpointIdFromPackageJson(path: string) {
  const pkgJsonPath = pathModule.join(path, "package.json");
  const pkgBuffer = await fs.readFile(pkgJsonPath);
  const pkgJson = JSON.parse(pkgBuffer.toString());

  const value = pkgJson["trigger.dev"]?.endpointId;
  if (!value || typeof value !== "string") return;

  return value as string;
}

async function getTriggerApiDetails(path: string, envFile: string) {
  const envPath = pathModule.join(path, envFile);
  const envFileContent = await fs.readFile(envPath, "utf-8");

  if (
    !envFileContent.includes("TRIGGER_API_KEY") ||
    !envFileContent.includes("TRIGGER_API_URL")
  ) {
    logger.error(
      `You must add TRIGGER_API_KEY and TRIGGER_API_URL to your ${envFile} file.`
    );
    process.exit(1);
  }

  const envFileLines = envFileContent.split("\n");
  const apiKeyLine = envFileLines.find((line) =>
    line.includes("TRIGGER_API_KEY")
  );
  const apiUrlLine = envFileLines.find((line) =>
    line.includes("TRIGGER_API_URL")
  );

  const apiKey = apiKeyLine?.split("=")[1];
  const apiUrl = apiUrlLine?.split("=")[1];

  if (!apiKey || !apiUrl) {
    logger.error(
      `You must add TRIGGER_API_KEY and TRIGGER_API_URL to your ${envFile} file.`
    );
    process.exit(1);
  }

  return { apiKey, apiUrl };
}

async function createTunnel(port: number) {
  try {
    return await ngrok.connect(port);
  } catch (e) {
    logger.error(`Ngrok failed to create a tunnel for port ${port}.\n${e}`);
    process.exit(1);
  }
}

async function refreshEndpoint(
  apiClient: TriggerApi,
  endpointId: string,
  tunnelUrl: string
) {
  const response = await apiClient.registerEndpoint({
    id: endpointId,
    url: `${tunnelUrl}/api/trigger`,
  });

  if (!response.ok) {
    logger.error(`Endpoint couldn't refresh: ${response.error}`);
    // process.exit(1);
    return;
  }

  return response.data;
}
