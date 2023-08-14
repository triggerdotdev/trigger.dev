import z from "zod";
import path from "path";
import util from "util";
import ngrok from "ngrok";
import dotenv from "dotenv";
import fs from "fs/promises";
import pathModule from "path";
import fetch from "node-fetch";
import ora, { Ora } from "ora";
import chokidar from "chokidar";
import childProcess from "child_process";
import { logger } from "../utils/logger.js";
import { CLOUD_API_URL } from "../consts.js";
import { TriggerApi } from "../utils/triggerApi.js";
import { resolvePath } from "../utils/parseNameAndPath.js";
import { telemetryClient } from "../telemetry/telemetry.js";
import { pathExists, readFile } from "../utils/fileSystem.js";
import { getUserPackageManager } from "../utils/getUserPkgManager.js";

interface YarnListOutput {
  data: {
    trees: Array<{ name: string; version: string }>;
  };
}

function getInstalledVersion(packageName: string, packageManager: string, projectPath: string) {
  let installedVersion = null;
  if (packageManager === "npm") {
    const { stdout } = childProcess.spawnSync(packageManager, ["list", packageName, "--json", "--depth=0"], {
      cwd: projectPath,
    });
    installedVersion = JSON.parse(stdout.toString()).dependencies[packageName].version;
  } else if (packageManager === "yarn") {
    const { stdout } = childProcess.spawnSync(packageManager, ["list", "--json", "--depth=0"], {
      cwd: projectPath,
    });
    const parsedOutput: YarnListOutput = JSON.parse(stdout.toString());
    if (Array.isArray(parsedOutput.data.trees)) {
      const tree = parsedOutput.data.trees.find((tree) => tree.name === packageName);
      if (tree) {
        installedVersion = tree.version;
      }
    }
  }
  else {
    const { stdout } = childProcess.spawnSync(packageManager, ["list", packageName, "--json", "--depth=0"], {
      cwd: projectPath,
    });
    installedVersion = JSON.parse(stdout.toString())[0].dependencies[packageName].version;
  }
  return installedVersion;
}

async function checkUpdates(projectPath: string) {
  const triggerDevPackage = "@trigger.dev";
  const packageManager = await getUserPackageManager(projectPath);
  const packageJsonPath = path.join(projectPath, "package.json");
  // In case no package.json found
  if (!fs.existsSync(packageJsonPath)) return;
  const packageJsonData = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const dependencies = packageJsonData.dependencies || {};
  const devDependencies = packageJsonData.devDependencies || {};
  const allDependencies = Object.keys({ ...dependencies, ...devDependencies });
  const triggerPackages = allDependencies.filter((pkg) => pkg.startsWith(triggerDevPackage));
  // If there are no @trigger.dev packages
  if (triggerPackages.length === 0) return;
  // Get an array of the latest versions of @trigger.dev packages
  const newVersions = await Promise.all(
    triggerPackages.map(async (packageName) => {
      try {
        const installedVersion = getInstalledVersion(packageName, packageManager, projectPath);
        const response = await fetch(`https://registry.npmjs.org/${packageName}`);
        if (response.ok) {
          const data = await response.json();
          const schema = z.object({
            "dist-tags": z.object({
              latest: z.string(),
            }),
          });
          const parsed = schema.parse(data);
          return { packageName, installedVersion, latestVersion: parsed["dist-tags"].latest };
        }
        return null;
      } catch (error) {
        // @ts-ignore
        console.error(`Error fetching version for ${packageName}: ${error.message}`);
        return null;
      }
    })
  );
  // Filter the packages with null and what don't match what
  // they are installed with so that they can be updated
  const packagesToUpdate = newVersions.filter(
    (pkg) => pkg && pkg.latestVersion !== pkg.installedVersion
  );
  // If no packages require any updation
  if (packagesToUpdate.length === 0) return;
  // Inform the user of the dependencies that can be updated
  console.log("Newer versions found for the following packages:");
  packagesToUpdate.forEach((entry) => {
    if (entry) {
      console.log(
        `- ${entry.packageName}: current ${dependencies[entry.packageName]} -> latest ${entry.latestVersion
        }`
      );
    }
  });
}

const asyncExecFile = util.promisify(childProcess.execFile);

export const DevCommandOptionsSchema = z.object({
  port: z.coerce.number(),
  envFile: z.string(),
  handlerPath: z.string(),
  clientId: z.string().optional(),
});

export type DevCommandOptions = z.infer<typeof DevCommandOptionsSchema>;

const throttleTimeMs = 1000;

const formattedDate = new Intl.DateTimeFormat("en", {
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

export async function devCommand(path: string, anyOptions: any) {
  telemetryClient.dev.started(path, anyOptions);

  const result = DevCommandOptionsSchema.safeParse(anyOptions);
  if (!result.success) {
    logger.error(result.error.message);
    telemetryClient.dev.failed("invalid_options", anyOptions, result.error);
    return;
  }
  const options = result.data;

  const resolvedPath = resolvePath(path);

  checkUpdates(resolvedPath)

  // Read from package.json to get the endpointId
  const endpointId = await getEndpointIdFromPackageJson(resolvedPath, options);
  if (!endpointId) {
    logger.error(
      "You must run the `init` command first to setup the project – you are missing \n'trigger.dev': { 'endpointId': 'your-client-id' } from your package.json file, or pass in the --client-id option to this command"
    );
    telemetryClient.dev.failed("missing_endpoint_id", options);
    return;
  }
  logger.success(`✔️ [trigger.dev] Detected TriggerClient id: ${endpointId}`);

  // Read from .env.local or .env to get the TRIGGER_API_KEY and TRIGGER_API_URL
  const apiDetails = await getTriggerApiDetails(resolvedPath, options.envFile);

  if (!apiDetails) {
    telemetryClient.dev.failed("missing_api_key", options);
    return;
  }

  const { apiUrl, envFile, apiKey } = apiDetails;

  logger.success(`✔️ [trigger.dev] Found API Key in ${envFile} file`);

  logger.info(`  [trigger.dev] Looking for Next.js site on port ${options.port}`);

  const localEndpointHandlerUrl = `http://localhost:${options.port}${options.handlerPath}`;

  try {
    await fetch(localEndpointHandlerUrl, {
      method: "POST",
      headers: {
        "x-trigger-api-key": apiKey,
        "x-trigger-action": "PING",
        "x-trigger-endpoint-id": endpointId,
      },
    });
  } catch (err) {
    logger.error(
      `❌ [trigger.dev] No server found on port ${options.port}. Make sure your Next.js app is running and try again.`
    );
    telemetryClient.dev.failed("no_server_found", options);
    return;
  }

  telemetryClient.dev.serverRunning(path, options);

  // Setup tunnel
  const endpointUrl = await resolveEndpointUrl(apiUrl, options.port);
  if (!endpointUrl) {
    telemetryClient.dev.failed("failed_to_create_tunnel", options);
    return;
  }

  const endpointHandlerUrl = `${endpointUrl}${options.handlerPath}`;
  telemetryClient.dev.tunnelRunning(path, options);

  const connectingSpinner = ora(`[trigger.dev] Registering endpoint ${endpointHandlerUrl}...`);

  //refresh function
  let hasConnected = false;
  let attemptCount = 0;
  const refresh = async () => {
    connectingSpinner.start();

    const refreshedEndpointId = await getEndpointIdFromPackageJson(resolvedPath, options);

    // Read from .env.local to get the TRIGGER_API_KEY and TRIGGER_API_URL
    const apiDetails = await getTriggerApiDetails(resolvedPath, envFile);

    if (!apiDetails) {
      connectingSpinner.fail(`❌ [trigger.dev] Failed to connect: Missing API Key`);
      logger.info(`Will attempt again on the next file change…`);
      attemptCount = 0;
      return;
    }

    const { apiKey, apiUrl } = apiDetails;
    const apiClient = new TriggerApi(apiKey, apiUrl);

    const authorizedKey = await apiClient.whoami(apiKey);
    if (!authorizedKey) {
      logger.error(
        `🛑 The API key you provided is not authorized. Try visiting your dashboard to get a new API key.`
      );

      telemetryClient.dev.failed("invalid_api_key", options);
      return;
    }

    telemetryClient.identify(
      authorizedKey.organization.id,
      authorizedKey.project.id,
      authorizedKey.userId
    );

    const result = await refreshEndpoint(
      apiClient,
      refreshedEndpointId ?? endpointId,
      endpointHandlerUrl
    );
    if (result.success) {
      attemptCount = 0;
      connectingSpinner.succeed(
        `[trigger.dev] 🔄 Refreshed ${refreshedEndpointId ?? endpointId} ${formattedDate.format(
          new Date(result.data.updatedAt)
        )}`
      );

      if (!hasConnected) {
        hasConnected = true;
        telemetryClient.dev.connected(path, options);
      }
    } else {
      attemptCount++;

      if (attemptCount === 10 || !result.retryable) {
        connectingSpinner.fail(`🚨 Failed to connect: ${result.error}`);
        logger.info(`Will attempt again on the next file change…`);
        attemptCount = 0;

        if (!hasConnected) {
          telemetryClient.dev.failed("failed_to_connect", options);
        }
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

async function getEndpointIdFromPackageJson(path: string, options: DevCommandOptions) {
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
    logger.error(`You must add TRIGGER_API_KEY to your ${envFile} file.`);
    return;
  }

  const parsedEnvFile = dotenv.parse(resolvedEnvFile.content);

  if (!parsedEnvFile) {
    logger.error(`You must add TRIGGER_API_KEY to your ${envFile} file.`);
    return;
  }

  const apiKey = parsedEnvFile.TRIGGER_API_KEY;
  const apiUrl = parsedEnvFile.TRIGGER_API_URL;

  if (!apiKey) {
    logger.error(`You must add TRIGGER_API_KEY to your ${envFile} file.`);
    return;
  }

  return { apiKey, apiUrl: apiUrl ?? CLOUD_API_URL, envFile: resolvedEnvFile.fileName };
}

async function resolveEndpointUrl(apiUrl: string, port: number) {
  const apiURL = new URL(apiUrl);

  if (apiURL.hostname === "localhost") {
    return `http://localhost:${port}`;
  }

  // Setup tunnel
  const tunnelSpinner = ora(`🚇 Creating tunnel`).start();

  const tunnelUrl = await createTunnel(port, tunnelSpinner);

  if (tunnelUrl) {
    tunnelSpinner.succeed(`🚇 Created tunnel: ${tunnelUrl}`);
  }

  return tunnelUrl;
}

async function createTunnel(port: number, spinner: Ora) {
  try {
    return await ngrok.connect(port);
  } catch (error: any) {
    if (
      typeof error.message === "string" &&
      error.message.includes("`version` property is required")
    ) {
      await upgradeNgrokConfig(spinner);

      try {
        return await ngrok.connect(port);
      } catch (retryError) {
        spinner.fail(
          `Ngrok failed to create a tunnel for port ${port} after configuration upgrade.\n${retryError}`
        );
        return;
      }
    }
    return;
  }
}

async function upgradeNgrokConfig(spinner: Ora) {
  try {
    await asyncExecFile("ngrok", ["config", "upgrade"]);
    spinner.info("Ngrok configuration upgraded successfully.");
  } catch (error) {
    spinner.fail(`Failed to upgrade ngrok configuration.\n${error}`);
  }
}

async function refreshEndpoint(apiClient: TriggerApi, endpointId: string, endpointUrl: string) {
  try {
    const response = await apiClient.registerEndpoint({
      id: endpointId,
      url: endpointUrl,
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
