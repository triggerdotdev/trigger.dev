import boxen from "boxen";
import childProcess from "child_process";
import chokidar from "chokidar";
import ngrok from "ngrok";
import ora, { Ora } from "ora";
import pRetry, { AbortError } from "p-retry";
import util from "util";
import { z } from "zod";
import https from "https";
import { Framework } from "../frameworks";
import { standardWatchFilePaths, standardWatchIgnoreRegex } from "../frameworks/watchConfig";
import { telemetryClient } from "../telemetry/telemetry";
import { getEnvFilename } from "../utils/env";
import fetch, { RequestInit } from "../utils/fetchUseProxy";
import { getTriggerApiDetails } from "../utils/getTriggerApiDetails";
import { JsRuntime, getJsRuntime } from "../utils/jsRuntime";
import { logger } from "../utils/logger";
import { resolvePath } from "../utils/parseNameAndPath";
import { RequireKeys } from "../utils/requiredKeys";
import { Throttle } from "../utils/throttle";
import { TriggerApi } from "../utils/triggerApi";
import { wait } from "../utils/wait";
import { YaltTunnel } from "@trigger.dev/yalt";
import chalk from "chalk";

const asyncExecFile = util.promisify(childProcess.execFile);

export const DevCommandOptionsSchema = z.object({
  port: z.coerce.number().optional(),
  hostname: z.string().optional(),
  envFile: z.string().optional(),
  handlerPath: z.string(),
  clientId: z.string().optional(),
  tunnel: z
    .string()
    .url()
    .regex(/^(http|https).+/, "only http/https URLs are accepted")
    .optional(),
  https: z.boolean().default(false).optional(),
});

export type DevCommandOptions = z.infer<typeof DevCommandOptionsSchema>;
type ResolvedOptions = RequireKeys<DevCommandOptions, "handlerPath" | "envFile">;

const throttleTimeMs = 1000;

const formattedDate = new Intl.DateTimeFormat("en", {
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

let runtime: JsRuntime;

type TunnelUrl = {
  type: "tunnel";
  url: string;
};

type ResolvedUrl = {
  type: "resolved";
  hostname: string;
  port: number;
  https: boolean;
};

type ServerUrl = TunnelUrl | ResolvedUrl;

type TunnelEndpoint = TunnelUrl & {
  handlerPath: string;
};

type ResolvedEndpoint = ResolvedUrl & {
  handlerPath: string;
};

type ServerEndpoint = TunnelEndpoint | ResolvedEndpoint;

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
  runtime = await getJsRuntime(resolvedPath, logger);
  //check for outdated packages, don't immediately await this
  const checkForOutdatedPackagesPromise = runtime.checkForOutdatedPackages();

  // Read from package.json to get the endpointId
  const endpointId = await getEndpointId(runtime, options.clientId);
  if (!endpointId) {
    logger.error(
      "You must run the `init` command first to setup the project – you are missing \n'trigger.dev': { 'endpointId': 'your-client-id' } from your package.json file, or pass in the --client-id option to this command"
    );
    telemetryClient.dev.failed("missing_endpoint_id", options);
    return;
  }
  logger.success(`✔️ [trigger.dev] Detected TriggerClient id: ${endpointId}`);

  //resolve the options using the detected framework (use default if there isn't a matching framework)
  const packageManager = await runtime.getUserPackageManager();
  const framework = await runtime.getFramework();
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
      `✖ [trigger.dev] Your endpoint couldn't be verified. Make sure your app is running and try again. ${resolvedOptions.handlerPath}`
    );
    logger.info(
      `  [trigger.dev] You can use -H to specify a hostname, or -p to specify a port, or -s to specify https, or -t to specify the tunnel-url pointing to the local dev server.`
    );
    telemetryClient.dev.failed("no_server_found", resolvedOptions);
    return;
  }

  telemetryClient.dev.serverRunning(path, resolvedOptions);

  // Setup tunnel
  const endpointUrl = await resolveEndpointUrl(apiUrl, apiKey, verifiedEndpoint);

  if (!endpointUrl) {
    telemetryClient.dev.failed("failed_to_create_tunnel", resolvedOptions);
    return;
  }

  const endpointHandlerUrl = `${endpointUrl}${verifiedEndpoint.handlerPath}`;
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

  const outdatedPackages = await checkForOutdatedPackagesPromise;

  if (outdatedPackages) {
    console.log(
      chalk.bgYellow(
        `New @trigger.dev/* packages available (${outdatedPackages.from} -> ${outdatedPackages.to})`
      )
    );
    console.log(chalk.bgBlue("Run npx @trigger.dev/cli@latest update"));
  }

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

  // Read from env file to get the TRIGGER_API_KEY and TRIGGER_API_URL
  const apiDetails = await getTriggerApiDetails(options.path, options.resolvedOptions.envFile);
  if (!apiDetails) {
    options.spinner.fail("[trigger.dev] Failed to connect: Missing API Key");
    return;
  }

  const { apiKey, apiUrl } = apiDetails;
  const apiClient = new TriggerApi(apiKey, apiUrl);

  try {
    const index = await pRetry(() => startIndexing({ ...options, apiClient }), {
      retries: 5,
      signal: options.abortController.signal,
      maxTimeout: 5000,
    });
    options.spinner.text = `[trigger.dev] Refreshing ${formattedDate.format(index.updatedAt)}`;

    if (!options.hasConnected) {
      options.hasConnected = true;
      telemetryClient.dev.connected(options.path, options.resolvedOptions);
    }

    //this is for backwards-compatibility with older servers
    if (index.id === undefined) {
      options.spinner.succeed(`[trigger.dev] Refreshed ${formattedDate.format(index.updatedAt)}`);
      return;
    }

    //wait 750ms before attempting to get the indexing result
    await wait(750);

    const indexResult = await pRetry(() => fetchIndexResult({ indexId: index.id, apiClient }), {
      //this means we're polling, same distance between each attempt
      factor: 1,
      retries: 10,
      signal: options.abortController.signal,
    });

    if (indexResult.status === "FAILURE") {
      options.spinner.fail(
        `[trigger.dev] Refreshing failed ${formattedDate.format(indexResult.updatedAt)}`
      );
      logger.error(
        boxen(indexResult.error.message, {
          padding: 1,
          borderStyle: "double",
        })
      );
      return;
    }

    options.spinner.succeed(
      `[trigger.dev] Refreshed ${formattedDate.format(indexResult.updatedAt)}`
    );
  } catch (e) {
    if (e instanceof AbortError) {
      options.spinner.fail(e.message);
      logger.info(`  [trigger.dev] Will attempt again on the next file change…`);
      return;
    }

    let message: string = "";
    if (e instanceof Error) {
      message = e.message;
    } else {
      message = "Unknown error";
    }

    options.spinner.fail(message);
    logger.info(`  [trigger.dev] Will attempt again on the next file change…`);

    if (!options.hasConnected) {
      telemetryClient.dev.failed("failed_to_connect", options.resolvedOptions);
    }
  }
}

async function startIndexing({
  spinner,
  path,
  endpointId,
  endpointHandlerUrl,
  resolvedOptions,
  apiClient,
}: RefreshOptions & { apiClient: TriggerApi }) {
  spinner.start();
  const refreshedEndpointId = await getEndpointId(runtime, resolvedOptions.clientId);

  const authorizedKey = await apiClient.whoami();
  if (!authorizedKey) {
    telemetryClient.dev.failed("invalid_api_key", resolvedOptions);
    throw new AbortError(
      "[trigger.dev] The API key you provided is not authorized. Try visiting your dashboard to get a new API key."
    );
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

  return { id: result.data.endpointIndex?.id, updatedAt: new Date(result.data.updatedAt) };
}

async function fetchIndexResult({
  indexId,
  apiClient,
}: {
  indexId: string;
  apiClient: TriggerApi;
}) {
  const result = await apiClient.getEndpointIndex(indexId);

  if (result.status === "STARTED" || result.status === "PENDING") {
    throw new Error("Indexing is still in progress");
  }

  return result;
}

async function resolveOptions(
  framework: Framework | undefined,
  path: string,
  unresolvedOptions: DevCommandOptions
): Promise<ResolvedOptions> {
  if (!framework) {
    logger.info("  [trigger.dev] Failed to detect framework, using default values");
    return {
      port: unresolvedOptions.port ?? 3000,
      hostname: unresolvedOptions.hostname ?? "localhost",
      envFile: unresolvedOptions.envFile ?? ".env",
      handlerPath: unresolvedOptions.handlerPath,
      clientId: unresolvedOptions.clientId,
      tunnel: unresolvedOptions.tunnel,
      https: unresolvedOptions.https,
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
    tunnel: unresolvedOptions.tunnel,
    https: unresolvedOptions.https,
  };
}

async function verifyEndpoint(
  resolvedOptions: ResolvedOptions,
  endpointId: string,
  apiKey: string,
  framework?: Framework
) {
  const serverUrls = findServerUrls(resolvedOptions, framework);

  //try each url
  for (const serverUrl of serverUrls) {
    const protocol = resolvedOptions.https ? "https" : "http";
    const url =
      serverUrl.type === "tunnel"
        ? serverUrl.url
        : `${protocol}://${serverUrl.hostname}:${serverUrl.port}`;
    const localEndpointHandlerUrl = `${url}${resolvedOptions.handlerPath}`;

    const spinner = ora(
      `[trigger.dev] Looking for your trigger endpoint: ${localEndpointHandlerUrl}`
    ).start();

    try {
      const agent = new https.Agent({
        rejectUnauthorized: false, // Ignore self-signed certificates
      });

      // Conditionally include the agent in fetch options
      const fetchOptions: RequestInit = {
        method: "POST",
        headers: {
          "x-trigger-api-key": apiKey,
          "x-trigger-action": "PING",
          "x-trigger-endpoint-id": endpointId,
        },
        ...(resolvedOptions.https && { agent }),
      };

      const response = await fetch(localEndpointHandlerUrl, fetchOptions);

      if (!response.ok || response.status !== 200) {
        spinner.fail(
          `[trigger.dev] Server responded with ${response.status} (${localEndpointHandlerUrl}).`
        );
        continue;
      }

      spinner.succeed(`[trigger.dev] Found your trigger endpoint: ${localEndpointHandlerUrl}`);

      return {
        ...serverUrl,
        handlerPath: resolvedOptions.handlerPath,
        https: resolvedOptions.https ?? false,
      };
    } catch (err) {
      spinner.fail(`[trigger.dev] No server found (${localEndpointHandlerUrl}).`);
    }
  }

  return;
}

export function getEndpointId(runtime: JsRuntime, clientId?: string) {
  if (clientId) {
    return clientId;
  } else return runtime.getEndpointId();
}

function findServerUrls(resolvedOptions: ResolvedOptions, framework?: Framework): ServerUrl[] {
  if (resolvedOptions.tunnel) {
    logger.info(`  Using provided tunnel URL: ${resolvedOptions.tunnel}`);
    return [{ type: "tunnel", url: resolvedOptions.tunnel }];
  }

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
  const urls: ResolvedUrl[] = [];
  for (const hostname of hostnames) {
    for (const port of ports) {
      urls.push({ type: "resolved", hostname, port, https: resolvedOptions.https ?? false });
    }
  }

  return urls;
}

async function resolveEndpointUrl(apiUrl: string, apiKey: string, endpoint: ServerEndpoint) {
  // use tunnel URL if provided
  if (endpoint.type === "tunnel") {
    return endpoint.url;
  }

  const apiURL = new URL(apiUrl);

  // if the API is localhost and the hostname is localhost
  if (apiURL.hostname === "localhost" && endpoint.hostname === "localhost") {
    return `http://${endpoint.hostname}:${endpoint.port}`;
  }

  const triggerApi = new TriggerApi(apiKey, apiUrl);

  const supportsTunneling = await triggerApi.supportsTunneling();

  if (supportsTunneling) {
    const tunnelSpinner = ora(`🚇 Creating Trigger.dev tunnel`).start();
    const tunnelUrl = await createNativeTunnel(
      endpoint.hostname,
      endpoint.port,
      endpoint.https,
      triggerApi,
      tunnelSpinner
    );

    if (tunnelUrl) {
      tunnelSpinner.succeed(`🚇 Trigger.dev tunnel ready`);
    }

    return tunnelUrl;
  } else {
    // Setup tunnel
    const tunnelSpinner = ora(`🚇 Creating tunnel`).start();
    const tunnelUrl = await createNgrokTunnel(endpoint.hostname, endpoint.port, tunnelSpinner);

    if (tunnelUrl) {
      tunnelSpinner.succeed(`🚇 Created tunnel: ${tunnelUrl}`);
    }

    return tunnelUrl;
  }
}

let yaltTunnel: YaltTunnel | null = null;

async function createNativeTunnel(
  hostname: string,
  port: number,
  https: boolean,
  triggerApi: TriggerApi,
  spinner: Ora
) {
  try {
    const response = await triggerApi.createTunnel();

    // import WS dynamically
    const WebSocket = await import("ws");

    yaltTunnel = new YaltTunnel(
      response.url,
      `${hostname}:${port}`,
      https,
      {
        WebSocket: WebSocket.default,
        connectionTimeout: getConnectionTimeoutValue(),
        maxRetries: 10,
      },
      { verbose: process.env.TUNNEL_VERBOSE === "1" }
    );

    await yaltTunnel.connect();

    return `https://${response.url}`;
  } catch (e) {
    spinner.fail(`Failed to create tunnel.\n${e}`);
    return;
  }
}

function getConnectionTimeoutValue() {
  if (typeof process.env.TUNNEL_CONNECTION_TIMEOUT === "string") {
    return parseInt(process.env.TUNNEL_CONNECTION_TIMEOUT);
  }

  return 5000;
}

async function createNgrokTunnel(hostname: string, port: number, spinner: Ora) {
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
        `Ngrok failed to create a tunnel for port ${port} because ngrok is already running.\n  You may want to use -t flag to use an existing URL that points to the local dev server.`
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
