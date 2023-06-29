import fs from "fs/promises";
import pathModule from "path";
import { detectNextJsProject } from "../utils/detectNextJsProject.js";
import { logger } from "../utils/logger.js";
import { resolvePath } from "../utils/parseNameAndPath.js";

export type DevCommandOptions = {
  port: string;
  envFile: string;
  tunnel: "ngrok" | "localtunnel";
};

export async function devCommand(path: string, options: DevCommandOptions) {
  console.log("devCommand", path, options);
  const resolvedPath = resolvePath(path);
  // Detect if are are in a Next.js project
  const isNextJsProject = await detectNextJsProject(resolvedPath);

  if (!isNextJsProject) {
    logger.error("You must run this command in a Next.js project.");
    process.exit(1);
  }

  // Read from package.json to get the endpointId
  const endpointId = await getEndpointIdFromPackageJson(resolvedPath);
  if (!endpointId) {
    logger.error(
      "You must run the `init` command first to setup the project – you are missing \n'trigger.dev': { 'endpointId': 'your-client-id' } from your package.json file."
    );
    process.exit(1);
  }

  // Read from .env.local to get the TRIGGER_API_KEY and TRIGGER_API_URL
  const { apiKey, apiUrl } = await getTriggerApiDetails(
    resolvedPath,
    options.envFile
  );
  console.log("apiKey", apiKey);
  console.log("apiUrl", apiUrl);

  // Setup tunnel

  // Call triggerApi.registerEndpoint
  // Watch for changes to .ts files and call triggerApi.indexEndpoint
}

async function getEndpointIdFromPackageJson(path: string) {
  const pkgJsonPath = pathModule.join(path, "package.json");
  const pkgBuffer = await fs.readFile(pkgJsonPath);
  const pkgJson = JSON.parse(pkgBuffer.toString());

  return pkgJson["trigger.dev"]?.endpointId;
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
