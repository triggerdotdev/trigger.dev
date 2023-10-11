import chalk from "chalk";
import childProcess from "child_process";
import chokidar from "chokidar";
import fs from "fs/promises";
import ngrok from "ngrok";
import { run as ncuRun } from "npm-check-updates";
import ora, { Ora } from "ora";
import pathModule from "path";
import util from "util";
import { z } from "zod";
import { Framework, getFramework } from "../frameworks";
import { telemetryClient } from "../telemetry/telemetry";
import { getEnvFilename } from "../utils/env";
import fetch from "../utils/fetchUseProxy";
import { getTriggerApiDetails } from "../utils/getTriggerApiDetails";
import { getUserPackageManager } from "../utils/getUserPkgManager";
import { logger } from "../utils/logger";
import { resolvePath } from "../utils/parseNameAndPath";
import { RequireKeys } from "../utils/requiredKeys";
import { TriggerApi } from "../utils/triggerApi";
import { standardWatchIgnoreRegex, standardWatchFilePaths } from "../frameworks/watchConfig";
import { Throttle } from "../utils/throttle";
import { wait } from "../utils/wait";
import pRetry, { AbortError } from "p-retry";
import { abort } from "process";

const asyncExecFile = util.promisify(childProcess.execFile);

export const DevCommandOptionsSchema = z.object({
  port: z.coerce.number().optional(),
  hostname: z.string().optional(),
  envFile: z.string().optional(),
  handlerPath: z.string(),
  clientId: z.string().optional(),
});

export type DevCommandOptions = z.infer<typeof DevCommandOptionsSchema>;
type ResolvedOptions = RequireKeys<DevCommandOptions, "handlerPath" | "envFile">;

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

  //check for outdated packages, don't await this
  checkForOutdatedPackages(resolvedPath);

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

  //resolve the options using the detected framework (use default if there isn't a matching framework)
  const packageManager = await getUserPackageManager(resolvedPath);
  const framework = await getFramework(resolvedPath, packageManager);
  const resolvedOptions = await resolveOptions(framework, resolvedPath, options);

  // Read from .env.local or .env to get the TRIGGER_API_KEY and TRIGGER_API_URL
  const apiDetails = await getTriggerApiDetails(resolvedPath, resolvedOptions.envFile);
  if (!apiDetails) {
    telemetryClient.dev.failed("missing_api_key", resolvedOptions);
    return;
  }
  const { apiUrl, apiKey, apiKeySource } = apiDetails;
  logger.success(`✔️ [trigger.dev] Found API Key in ${apiKeySource}`);

  //verify that the endpoint can be reached
  const verifiedEndpoint = await verifyEndpoint(resolvedOptions, endpointId, apiKey, framework);
  if (!verifiedEndpoint) {
    logger.error(
      `✖ [trigger.dev] Failed to find a valid Trigger.dev endpoint. Make sure your app is running and try again.`
    );
    logger.info(`  [trigger.dev] You can use -H to specify a hostname, or -p to specify a port.`);
    telemetryClient.dev.failed("no_server_found", resolvedOptions);
    return;
  }

  const { hostname, port, handlerPath } = verifiedEndpoint;

  telemetryClient.dev.serverRunning(path, resolvedOptions);

  // Setup tunnel
  const endpointUrl = await resolveEndpointUrl(apiUrl, port, hostname);
  if (!endpointUrl) {
    telemetryClient.dev.failed("failed_to_create_tunnel", resolvedOptions);
    return;
  }

  const endpointHandlerUrl = `${endpointUrl}${handlerPath}`;
  telemetryClient.dev.tunnelRunning(path, resolvedOptions);

  // Watch for changes to files and refresh endpoints
  const watchPaths = (framework?.watchFilePaths ?? standardWatchFilePaths).map(
    (path) => `${resolvedPath}/${path}`
  );
  const ignored = framework?.watchIgnoreRegex ?? standardWatchIgnoreRegex;
  const watcher = chokidar.watch(watchPaths, {
    ignored,
    //don't trigger a watch when it collects the paths
    ignoreInitial: true,
  });

  const connectingSpinner = ora(`[trigger.dev] Registering endpoint ${endpointHandlerUrl}...`);
  let hasConnected = false;
  const abortController = new AbortController();

  const r = () => {
    refresh({
      endpointId,
      spinner: connectingSpinner,
      path: resolvedPath,
      endpointHandlerUrl,
      resolvedOptions,
      hasConnected,
      abortController,
    });
  };

  const throttle = new Throttle(r, throttleTimeMs);

  watcher.on("all", (_event, _path) => {
    throttle.call();
  });

  //Do initial refresh
  throttle.call();
}

type RefreshOptions = {
  spinner: Ora;
  path: string;
  endpointId: string;
  endpointHandlerUrl: string;
  resolvedOptions: ResolvedOptions;
  hasConnected: boolean;
  abortController: AbortController;
};

async function refresh(options: RefreshOptions) {
  //stop any existing refreshes
  options.abortController.abort();
  options.abortController = new AbortController();

  try {
    const result = await pRetry(() => startRefresh(options), {
      retries: 5,
      signal: options.abortController.signal,
    });
    options.spinner.text = `[trigger.dev] 🔄 Refreshing ${formattedDate.format(result.updatedAt)}`;

    if (!options.hasConnected) {
      options.hasConnected = true;
      telemetryClient.dev.connected(options.path, options.resolvedOptions);
    }
  } catch (e) {
    logger.error(e);
    if (e instanceof AbortError) {
      return;
    }

    let message: string = "";
    if (e instanceof Error) {
      message = e.message;
    } else {
      message = "Unknown error";
    }

    options.spinner.fail(`Failed to connect: ${message}`);
    logger.info(`Will attempt again on the next file change…`);

    if (!options.hasConnected) {
      telemetryClient.dev.failed("failed_to_connect", options.resolvedOptions);
    }
  }
}

async function startRefresh({
  spinner,
  path,
  endpointId,
  endpointHandlerUrl,
  resolvedOptions,
}: RefreshOptions) {
  spinner.start();

  const refreshedEndpointId = await getEndpointIdFromPackageJson(path, resolvedOptions);

  // Read from env file to get the TRIGGER_API_KEY and TRIGGER_API_URL
  const apiDetails = await getTriggerApiDetails(path, resolvedOptions.envFile);
  if (!apiDetails) {
    spinner.fail(`[trigger.dev] Failed to connect: Missing API Key`);
    logger.info(`Will attempt again on the next file change…`);
    throw new AbortError("Missing API Key");
  }

  const { apiKey, apiUrl } = apiDetails;
  const apiClient = new TriggerApi(apiKey, apiUrl);

  const authorizedKey = await apiClient.whoami(apiKey);
  if (!authorizedKey) {
    logger.error(
      `✖ [trigger.dev] The API key you provided is not authorized. Try visiting your dashboard to get a new API key.`
    );

    telemetryClient.dev.failed("invalid_api_key", resolvedOptions);
    throw new AbortError("Invalid API Key");
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

  if (!result.success) {
    throw new Error(result.error);
  }

  return { id: result.data.id, updatedAt: new Date(result.data.updatedAt) };
}

async function resolveOptions(
  framework: Framework | undefined,
  path: string,
  unresolvedOptions: DevCommandOptions
): Promise<ResolvedOptions> {
  if (!framework) {
    logger.info("Failed to detect framework, using default values");
    return {
      port: unresolvedOptions.port ?? 3000,
      hostname: unresolvedOptions.hostname ?? "localhost",
      envFile: unresolvedOptions.envFile ?? ".env",
      handlerPath: unresolvedOptions.handlerPath,
      clientId: unresolvedOptions.clientId,
    };
  }

  //get env filename
  const envName = await getEnvFilename(path, framework.possibleEnvFilenames());

  return {
    port: unresolvedOptions.port,
    hostname: unresolvedOptions.hostname,
    envFile: unresolvedOptions.envFile ?? envName ?? ".env",
    handlerPath: unresolvedOptions.handlerPath,
    clientId: unresolvedOptions.clientId,
  };
}

async function verifyEndpoint(
  resolvedOptions: ResolvedOptions,
  endpointId: string,
  apiKey: string,
  framework?: Framework
) {
  //create list of hostnames to try
  const hostnames = [];
  if (resolvedOptions.hostname) {
    hostnames.push(resolvedOptions.hostname);
  }
  if (framework) {
    hostnames.push(...framework.defaultHostnames);
  } else {
    hostnames.push("localhost");
  }

  //create list of ports to try
  const ports = [];
  if (resolvedOptions.port) {
    ports.push(resolvedOptions.port);
  }
  if (framework) {
    ports.push(...framework.defaultPorts);
  } else {
    ports.push(3000);
  }

  //create list of urls to try
  const urls: { hostname: string; port: number }[] = [];
  for (const hostname of hostnames) {
    for (const port of ports) {
      urls.push({ hostname, port });
    }
  }

  //try each hostname
  for (const url of urls) {
    const { hostname, port } = url;
    const localEndpointHandlerUrl = `http://${hostname}:${port}${resolvedOptions.handlerPath}`;

    const spinner = ora(
      `[trigger.dev] Looking for your trigger endpoint: ${localEndpointHandlerUrl}`
    ).start();

    try {
      const response = await fetch(localEndpointHandlerUrl, {
        method: "POST",
        headers: {
          "x-trigger-api-key": apiKey,
          "x-trigger-action": "PING",
          "x-trigger-endpoint-id": endpointId,
        },
      });

      if (!response.ok || response.status !== 200) {
        spinner.fail(
          `[trigger.dev] Server responded with ${response.status} (${localEndpointHandlerUrl}).`
        );
        continue;
      }

      spinner.succeed(`[trigger.dev] Found your trigger endpoint: ${localEndpointHandlerUrl}`);
      return { hostname, port, handlerPath: resolvedOptions.handlerPath };
    } catch (err) {
      spinner.fail(`[trigger.dev] No server found (${localEndpointHandlerUrl}).`);
    }
  }

  return;
}

export async function checkForOutdatedPackages(path: string) {
  const updates = (await ncuRun({
    packageFile: `${path}/package.json`,
    filter: "/trigger.dev/.+$/",
    upgrade: false,
  })) as {
    [key: string]: string;
  };

  if (typeof updates === "undefined" || Object.keys(updates).length === 0) {
    return;
  }

  const packageFile = await fs.readFile(`${path}/package.json`);
  const data = JSON.parse(Buffer.from(packageFile).toString("utf8"));
  const dependencies = data.dependencies;
  console.log(chalk.bgYellow("Updates available for trigger.dev packages"));
  console.log(chalk.bgBlue("Run npx @trigger.dev/cli@latest update"));

  for (let dep in updates) {
    console.log(`${dep}  ${dependencies[dep]}  →  ${updates[dep]}`);
  }
}

export async function getEndpointIdFromPackageJson(path: string, options: DevCommandOptions) {
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

async function resolveEndpointUrl(apiUrl: string, port: number, hostname: string) {
  const apiURL = new URL(apiUrl);

  //if the API is localhost and the hostname is localhost
  if (apiURL.hostname === "localhost" && hostname === "localhost") {
    return `http://${hostname}:${port}`;
  }

  // Setup tunnel
  const tunnelSpinner = ora(`🚇 Creating tunnel`).start();
  const tunnelUrl = await createTunnel(hostname, port, tunnelSpinner);

  if (tunnelUrl) {
    tunnelSpinner.succeed(`🚇 Created tunnel: ${tunnelUrl}`);
  }

  return tunnelUrl;
}

async function createTunnel(hostname: string, port: number, spinner: Ora) {
  try {
    return await ngrok.connect({ addr: `${hostname}:${port}` });
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
    if (
      typeof error.message === "string" &&
      error.message.includes("connect ECONNREFUSED 127.0.0.1:4041")
    ) {
      spinner.fail(
        `Ngrok failed to create a tunnel for port ${port} because ngrok is already running`
      );
      return;
    }
    spinner.fail(`Ngrok failed to create a tunnel for port ${port}.\n${error.message}`);
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

//todo dev command gets the endpointIndex id and polls for the status
//todo create an EndpointIndex API endpoint that will return the status of the endpointIndex row, with errors and stats
//todo the dev command should poll. We need to make sure that we're only polling for the last endpointIndex record that was received

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
