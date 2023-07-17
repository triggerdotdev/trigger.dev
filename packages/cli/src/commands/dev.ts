import chokidar from "chokidar";
import fs from "fs/promises";
import ngrok from "ngrok";
import ora from "ora";
import pathModule from "path";
import { z } from "zod";
import { pathExists, readFile } from "../utils/fileSystem.js";
import { logger } from "../utils/logger.js";
import { resolvePath } from "../utils/parseNameAndPath.js";
import { TriggerApi } from "../utils/triggerApi.js";

export const DevCommandOptionsSchema = z.object({
  port: z.coerce.number(),
  envFile: z.string(),
  clientId: z.string().optional(),
});

type DevCommandOptions = z.infer<typeof DevCommandOptionsSchema>;

const throttleTimeMs = 1000;

const formattedDate = new Intl.DateTimeFormat("en", {
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

  // Read from package.json to get the endpointId
  const endpointId = await getEndpointIdFromPackageJson(resolvedPath, options);
  if (!endpointId) {
    logger.error(
      "You must run the `init` command first to setup the project – you are missing \n'trigger.dev': { 'endpointId': 'your-client-id' } from your package.json file, or pass in the --client-id option to this command"
    );
    process.exit(1);
  }
  logger.success(`✔️ [trigger.dev] Detected TriggerClient id: ${endpointId}`);

  // Read from .env.local or .env to get the TRIGGER_API_KEY and TRIGGER_API_URL
  const { apiUrl, envFile } = await getTriggerApiDetails(
    resolvedPath,
    options.envFile
  );

  logger.success(`✔️ [trigger.dev] Found API Key in ${envFile} file`);

  logger.info(
    `  [trigger.dev] Looking for Next.js site on port ${options.port}`
  );

  // Setup tunnel
  const endpointUrl = await resolveEndpointUrl(apiUrl, options.port);

  const connectingSpinner = ora(`[trigger.dev] Connecting to Trigger.dev...`);

  //refresh function
  let attemptCount = 0;
  const refresh = async () => {
    connectingSpinner.start();

    const refreshedEndpointId = await getEndpointIdFromPackageJson(
      resolvedPath,
      options
    );

    // Read from .env.local to get the TRIGGER_API_KEY and TRIGGER_API_URL
    const { apiKey, apiUrl } = await getTriggerApiDetails(
      resolvedPath,
      envFile
    );

    const apiClient = new TriggerApi(apiKey, apiUrl);

    const result = await refreshEndpoint(
      apiClient,
      refreshedEndpointId ?? endpointId,
      endpointUrl
    );
    if (result.success) {
      attemptCount = 0;
      connectingSpinner.succeed(
        `[trigger.dev] 🔄 Refreshed ${
          refreshedEndpointId ?? endpointId
        } ${formattedDate.format(new Date(result.data.updatedAt))}`
      );
    } else {
      attemptCount++;

      if (attemptCount === 10 || !result.retryable) {
        connectingSpinner.fail(`🚨 Failed to connect: ${result.error}`);
        logger.info(`Will attempt again on the next file change…`);
        attemptCount = 0;
        return;
      }

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

async function getEndpointIdFromPackageJson(
  path: string,
  options: DevCommandOptions
) {
  if (options.clientId) {
    return options.clientId;
  }

  const pkgJsonPath = pathModule.join(path, "package.json");
  const pkgBuffer = await fs.readFile(pkgJsonPath);
  const pkgJson = JSON.parse(pkgBuffer.toString());

  const value = pkgJson["trigger.dev"]?.endpointId;
  if (!value || typeof value !== "string") return;

  return value as string;
}

async function readEnvFilesWithBackups(
  path: string,
  envFile: string,
  backups: string[]
): Promise<{ content: string; fileName: string } | undefined> {
  const envFilePath = pathModule.join(path, envFile);
  const envFileExists = await pathExists(envFilePath);

  if (envFileExists) {
    const content = await readFile(envFilePath);

    return { content, fileName: envFile };
  }

  for (const backup of backups) {
    const backupPath = pathModule.join(path, backup);
    const backupExists = await pathExists(backupPath);

    if (backupExists) {
      const content = await readFile(backupPath);

      return { content, fileName: backup };
    }
  }

  return;
}

async function getTriggerApiDetails(path: string, envFile: string) {
  const resolvedEnvFile = await readEnvFilesWithBackups(path, envFile, [
    ".env",
    ".env.local",
    ".env.development.local",
  ]);

  if (!resolvedEnvFile) {
    logger.error(
      `You must add TRIGGER_API_KEY and TRIGGER_API_URL to your ${envFile} file.`
    );
    process.exit(1);
  }

  if (
    !resolvedEnvFile.content.includes("TRIGGER_API_KEY") ||
    !resolvedEnvFile.content.includes("TRIGGER_API_URL")
  ) {
    logger.error(
      `You must add TRIGGER_API_KEY and TRIGGER_API_URL to your ${envFile} file.`
    );
    process.exit(1);
  }

  const envFileLines = resolvedEnvFile.content.split("\n");
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

  return { apiKey, apiUrl, envFile: resolvedEnvFile.fileName };
}

async function resolveEndpointUrl(apiUrl: string, port: number) {
  const apiURL = new URL(apiUrl);

  if (apiURL.hostname === "localhost") {
    return `http://localhost:${port}`;
  }

  // Setup tunnel
  const tunnelSpinner = ora(`🚇 Creating tunnel`).start();
  const tunnelUrl = await createTunnel(port);
  tunnelSpinner.succeed(`🚇 Created tunnel: ${tunnelUrl}`);

  return tunnelUrl;
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
      return {
        success: false as const,
        error: response.error,
        retryable: response.retryable,
      };
    }

    return { success: true as const, data: response.data };
  } catch (e) {
    if (e instanceof Error) {
      return { success: false as const, error: e.message, retryable: true };
    } else {
      return {
        success: false as const,
        error: "Unknown error",
        retryable: true,
      };
    }
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
