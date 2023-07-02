import fs from "fs/promises";
import pathModule from "path";
import { detectNextJsProject } from "../utils/detectNextJsProject.js";
import { logger } from "../utils/logger.js";
import { resolvePath } from "../utils/parseNameAndPath.js";
import ngrok from "ngrok";
import { z } from "zod";
import { TriggerApi } from "../utils/triggerApi.js";
import chokidar from "chokidar";

export const DevCommandOptionsSchema = z.object({
  port: z.coerce.number(),
  envFile: z.string(),
});

const compileTimeWaitMs = 300;
const throttleTimeMs = 1000;

const formattedDate = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
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

  logger.info(`🔌 Connecting to Trigger.dev...`);

  //refresh function
  let attemptCount = 0;
  const refresh = async () => {
    const result = await refreshEndpoint(apiClient, endpointId, tunnelUrl);
    if (result.success) {
      attemptCount = 0;
      logger.success(
        `🔄 Updated your Jobs ${formattedDate.format(
          new Date(result.data.updatedAt)
        )}`
      );
    } else {
      attemptCount++;
      const delay = backoff(attemptCount);
      // console.log(`Attempt: ${attemptCount}`, delay);
      await wait(delay);
      refresh();
    }
  };

  // Watch for changes to .ts files and refresh endpoints
  const watcher = chokidar.watch(
    [
      `${resolvedPath}/**/*.ts`,
      `${resolvedPath}/**/*.tsx`,
      `${resolvedPath}/**/*.js`,
      `${resolvedPath}/**/*.jsx`,
      `${resolvedPath}/**/*.json`,
      `${resolvedPath}/pnpm-lock.yaml`,
    ],
    {
      ignored: /(node_modules|\.next)/,
      //don't trigger a watch when it collects the paths
      ignoreInitial: true,
    }
  );

  watcher.on("all", (_event, _path) => {
    // console.log(_event, _path);
    throttle(refresh, throttleTimeMs);
  });

  //Do initial refresh
  throttle(refresh, throttleTimeMs);
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
  try {
    const response = await apiClient.registerEndpoint({
      id: endpointId,
      url: `${tunnelUrl}/api/trigger`,
    });

    if (!response.ok) {
      logger.error(`🚨 Endpoint couldn't refresh: ${response.error}`);
      return { success: false as const };
    }

    return { success: true as const, data: response.data };
  } catch (e) {
    logger.error(`🚨 Endpoint couldn't refresh: ${e}`);
    return { success: false as const };
  }
}

//wait function
async function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

//throttle function
let throttleTimeout: NodeJS.Timeout | null = null;
function throttle(fn: () => any, delay: number) {
  if (throttleTimeout) {
    clearTimeout(throttleTimeout);
  }
  throttleTimeout = setTimeout(fn, delay);
}

const maximum_backoff = 30;
const initial_backoff = 0.2;
function backoff(attempt: number) {
  return Math.min((2 ^ attempt) * initial_backoff, maximum_backoff) * 1000;
}
