import {
  CreateBackgroundWorkerRequestBody,
  ResolvedConfig,
  TaskResource,
  clientWebsocketMessages,
  detectDependencyVersion,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import { ZodMessageHandler, ZodMessageSender } from "@trigger.dev/core/v3/zodMessageHandler";
import { watch } from "chokidar";
import { Command } from "commander";
import { BuildContext, Metafile, context } from "esbuild";
import { render, useInput } from "ink";
import { createHash } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import { ClientRequestArgs } from "node:http";
import { basename, dirname, join, normalize } from "node:path";
import pDebounce from "p-debounce";
import { WebSocket } from "partysocket";
import React, { Suspense, useEffect } from "react";
import { ClientOptions, WebSocket as wsWebSocket } from "ws";
import { z } from "zod";
import * as packageJson from "../../package.json";
import { CliApiClient } from "../apiClient";
import { CommonCommandOptions, commonOptions, wrapCommandAction } from "../cli/common.js";
import {
  bundleDependenciesPlugin,
  bundleTriggerDevCore,
  mockServerOnlyPlugin,
  workerSetupImportConfigPlugin,
} from "../utilities/build";
import {
  chalkError,
  chalkGrey,
  chalkLink,
  chalkPurple,
  chalkTask,
  chalkWorker,
  cliLink,
} from "../utilities/cliOutput";
import { readConfig } from "../utilities/configFiles";
import { readJSONFile } from "../utilities/fileSystem";
import { printDevBanner, printStandloneInitialBanner } from "../utilities/initialBanner.js";
import {
  detectPackageNameFromImportPath,
  parsePackageName,
  stripWorkspaceFromVersion,
} from "../utilities/installPackages";
import { logger } from "../utilities/logger.js";
import { isLoggedIn } from "../utilities/session.js";
import { createTaskFileImports, gatherTaskFiles } from "../utilities/taskFiles";
import { TaskMetadataParseError, UncaughtExceptionError } from "../workers/common/errors";
import { BackgroundWorker, BackgroundWorkerCoordinator } from "../workers/dev/backgroundWorker.js";
import { runtimeCheck } from "../utilities/runtimeCheck";
import {
  logESMRequireError,
  logTaskMetadataParseError,
  parseBuildErrorStack,
  parseNpmInstallError,
} from "../utilities/deployErrors";
import { findUp, pathExists } from "find-up";
import { cliRootPath } from "../utilities/resolveInternalFilePath";
import { escapeImportPath } from "../utilities/windows";
import { updateTriggerPackages } from "./update";
import { esbuildDecorators } from "@anatine/esbuild-decorators";
import { callResolveEnvVars } from "../utilities/resolveEnvVars";

let apiClient: CliApiClient | undefined;

const DevCommandOptions = CommonCommandOptions.extend({
  debugger: z.boolean().default(false),
  debugOtel: z.boolean().default(false),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  skipUpdateCheck: z.boolean().default(false),
});

type DevCommandOptions = z.infer<typeof DevCommandOptions>;

export function configureDevCommand(program: Command) {
  return commonOptions(
    program
      .command("dev")
      .description("Run your Trigger.dev tasks locally")
      .argument("[path]", "The path to the project", ".")
      .option("-c, --config <config file>", "The name of the config file, found at [path].")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file."
      )
      .option("--debugger", "Enable the debugger")
      .option("--debug-otel", "Enable OpenTelemetry debugging")
      .option("--skip-update-check", "Skip checking for @trigger.dev package updates")
  ).action(async (path, options) => {
    wrapCommandAction("dev", DevCommandOptions, options, async (opts) => {
      await devCommand(path, opts);
    });
  });
}

const MINIMUM_NODE_MAJOR = 18;
const MINIMUM_NODE_MINOR = 16;

export async function devCommand(dir: string, options: DevCommandOptions) {
  try {
    runtimeCheck(MINIMUM_NODE_MAJOR, MINIMUM_NODE_MINOR);
  } catch (e) {
    logger.log(`${chalkError("X Error:")} ${e}`);
    process.exitCode = 1;
    return;
  }

  const authorization = await isLoggedIn(options.profile);

  if (!authorization.ok) {
    if (authorization.error === "fetch failed") {
      logger.log(
        `${chalkError(
          "X Error:"
        )} Connecting to the server failed. Please check your internet connection or contact eric@trigger.dev for help.`
      );
    } else {
      logger.log(
        `${chalkError("X Error:")} You must login first. Use the \`login\` CLI command.\n\n${
          authorization.error
        }`
      );
    }
    process.exitCode = 1;
    return;
  }

  const devInstance = await startDev(dir, options, authorization.auth, authorization.dashboardUrl);
  const { waitUntilExit } = devInstance.devReactElement;
  await waitUntilExit();
}

async function startDev(
  dir: string,
  options: DevCommandOptions,
  authorization: { apiUrl: string; accessToken: string },
  dashboardUrl: string
) {
  let rerender: (node: React.ReactNode) => void | undefined;

  try {
    if (options.logLevel) {
      logger.loggerLevel = options.logLevel;
    }

    await printStandloneInitialBanner(true);

    let displayedUpdateMessage = false;

    if (!options.skipUpdateCheck) {
      displayedUpdateMessage = await updateTriggerPackages(dir, { ...options }, true, true);
    }

    printDevBanner(displayedUpdateMessage);

    logger.debug("Starting dev session", { dir, options, authorization });

    let config = await readConfig(dir, {
      projectRef: options.projectRef,
      configFile: options.config,
    });

    logger.debug("Initial config", { config });

    if (config.status === "error") {
      logger.error("Failed to read config", config.error);
      process.exit(1);
    }

    async function getDevReactElement(
      configParam: ResolvedConfig,
      authorization: { apiUrl: string; accessToken: string },
      configPath?: string,
      configModule?: any
    ) {
      const accessToken = authorization.accessToken;
      const apiUrl = authorization.apiUrl;

      apiClient = new CliApiClient(apiUrl, accessToken);

      const devEnv = await apiClient.getProjectEnv({
        projectRef: configParam.project,
        env: "dev",
      });

      if (!devEnv.success) {
        if (devEnv.error === "Project not found") {
          logger.error(
            `Project not found: ${configParam.project}. Ensure you are using the correct project ref and CLI profile (use --profile). Currently using the "${options.profile}" profile, which points to ${authorization.apiUrl}`
          );
        } else {
          logger.error(
            `Failed to initialize dev environment: ${devEnv.error}. Using project ref ${configParam.project}`
          );
        }

        process.exit(1);
      }

      const environmentClient = new CliApiClient(apiUrl, devEnv.data.apiKey);

      return (
        <DevUI
          dashboardUrl={dashboardUrl}
          config={configParam}
          apiUrl={apiUrl}
          apiKey={devEnv.data.apiKey}
          environmentClient={environmentClient}
          projectName={devEnv.data.name}
          debuggerOn={options.debugger}
          debugOtel={options.debugOtel}
          configPath={configPath}
          configModule={configModule}
        />
      );
    }

    const devReactElement = render(
      await getDevReactElement(
        config.config,
        authorization,
        config.status === "file" ? config.path : undefined,
        config.status === "file" ? config.module : undefined
      )
    );

    rerender = devReactElement.rerender;

    return {
      devReactElement,
      stop: async () => {
        devReactElement.unmount();
      },
    };
  } catch (e) {
    throw e;
  }
}

type DevProps = {
  config: ResolvedConfig;
  dashboardUrl: string;
  apiUrl: string;
  apiKey: string;
  environmentClient: CliApiClient;
  projectName: string;
  debuggerOn: boolean;
  debugOtel: boolean;
  configPath?: string;
  configModule?: any;
};

function useDev({
  config,
  dashboardUrl,
  apiUrl,
  apiKey,
  environmentClient,
  projectName,
  debuggerOn,
  debugOtel,
  configPath,
  configModule,
}: DevProps) {
  useEffect(() => {
    const websocketUrl = new URL(apiUrl);
    websocketUrl.protocol = websocketUrl.protocol.replace("http", "ws");
    websocketUrl.pathname = `/ws`;

    const websocket = new WebSocket(websocketUrl.href, [], {
      WebSocket: WebsocketFactory(apiKey),
      connectionTimeout: 10000,
      maxRetries: 10,
      minReconnectionDelay: 1000,
      maxReconnectionDelay: 30000,
      reconnectionDelayGrowFactor: 1.4, // This leads to the following retry times: 1, 1.4, 1.96, 2.74, 3.84, 5.38, 7.53, 10.54, 14.76, 20.66
      maxEnqueuedMessages: 250,
    });

    const sender = new ZodMessageSender({
      schema: clientWebsocketMessages,
      sender: async (message) => {
        websocket.send(JSON.stringify(message));
      },
    });

    const backgroundWorkerCoordinator = new BackgroundWorkerCoordinator(
      `${dashboardUrl}/projects/v3/${config.project}`
    );

    const messageHandler = new ZodMessageHandler({
      schema: serverWebsocketMessages,
      messages: {
        SERVER_READY: async (payload) => {
          for (const worker of backgroundWorkerCoordinator.currentWorkers) {
            await sender.send("READY_FOR_TASKS", {
              backgroundWorkerId: worker.id,
              inProgressRuns: worker.worker.inProgressRuns,
            });
          }
        },
        BACKGROUND_WORKER_MESSAGE: async (payload) => {
          await backgroundWorkerCoordinator.handleMessage(payload.backgroundWorkerId, payload.data);
        },
        PONG: async () => {
          logger.debug("Received pong", { timestamp: Date.now() });
        },
      },
    });

    websocket.addEventListener("message", async (event) => {
      const data = JSON.parse(
        typeof event.data === "string" ? event.data : new TextDecoder("utf-8").decode(event.data)
      );

      await messageHandler.handleMessage(data);
    });

    const ping = new WebsocketPing({
      callback: async () => {
        if (websocket.readyState !== WebSocket.OPEN) {
          logger.debug("Websocket not open, skipping ping");
          return;
        }

        logger.debug("Sending ping", { timestamp: Date.now() });

        await sender.send("PING", {});
      },
    });

    websocket.addEventListener("open", async (event) => {
      logger.debug("Websocket opened", { event });

      ping.start();
    });

    websocket.addEventListener("close", (event) => {
      logger.debug("Websocket closed", { event });

      ping.stop();
    });

    websocket.addEventListener("error", (event) => {
      logger.log(`${chalkError("Websocket Error:")} ${event.error.message}`);
      logger.debug("Websocket error", { event, rawError: event.error });

      ping.stop();
    });

    // This is the deprecated task heart beat that uses the friendly attempt ID
    // It will only be used if the worker does not support lazy attempts
    backgroundWorkerCoordinator.onWorkerTaskHeartbeat.attach(
      async ({ worker, backgroundWorkerId, id }) => {
        await sender.send("BACKGROUND_WORKER_MESSAGE", {
          backgroundWorkerId,
          data: {
            type: "TASK_HEARTBEAT",
            id,
          },
        });
      }
    );

    // "Task Run Heartbeat" id is the actual run ID that corresponds to the MarQS message ID
    backgroundWorkerCoordinator.onWorkerTaskRunHeartbeat.attach(
      async ({ worker, backgroundWorkerId, id }) => {
        await sender.send("BACKGROUND_WORKER_MESSAGE", {
          backgroundWorkerId,
          data: {
            type: "TASK_RUN_HEARTBEAT",
            id,
          },
        });
      }
    );

    backgroundWorkerCoordinator.onTaskCompleted.attach(
      async ({ backgroundWorkerId, completion, execution }) => {
        await sender.send("BACKGROUND_WORKER_MESSAGE", {
          backgroundWorkerId,
          data: {
            type: "TASK_RUN_COMPLETED",
            completion,
            execution,
          },
        });
      }
    );

    backgroundWorkerCoordinator.onTaskFailedToRun.attach(
      async ({ backgroundWorkerId, completion }) => {
        await sender.send("BACKGROUND_WORKER_MESSAGE", {
          backgroundWorkerId,
          data: {
            type: "TASK_RUN_FAILED_TO_RUN",
            completion,
          },
        });
      }
    );

    backgroundWorkerCoordinator.onWorkerRegistered.attach(async ({ id, worker, record }) => {
      await sender.send("READY_FOR_TASKS", {
        backgroundWorkerId: id,
      });
    });

    backgroundWorkerCoordinator.onWorkerDeprecated.attach(async ({ id, worker }) => {
      await sender.send("BACKGROUND_WORKER_DEPRECATED", {
        backgroundWorkerId: id,
      });
    });

    let ctx: BuildContext | undefined;

    let firstBuild = true;

    async function runBuild() {
      if (ctx) {
        // This will stop the watching
        await ctx.dispose();
      }

      let latestWorkerContentHash: string | undefined;

      const taskFiles = await gatherTaskFiles(config);

      const workerFacadePath = join(cliRootPath(), "workers", "dev", "worker-facade.js");
      const workerFacade = readFileSync(workerFacadePath, "utf-8");

      const workerSetupPath = join(cliRootPath(), "workers", "dev", "worker-setup.js");

      let entryPointContents = workerFacade
        .replace("__TASKS__", createTaskFileImports(taskFiles))
        .replace(
          "__WORKER_SETUP__",
          `import { tracingSDK, otelTracer, otelLogger, sender } from "${escapeImportPath(
            workerSetupPath
          )}";`
        );

      if (configPath) {
        configPath = normalize(configPath);
        logger.debug("Importing project config from", { configPath });

        entryPointContents = entryPointContents.replace(
          "__IMPORTED_PROJECT_CONFIG__",
          `import * as importedConfigExports from "${escapeImportPath(
            configPath
          )}"; const importedConfig = importedConfigExports.config; const handleError = importedConfigExports.handleError;`
        );
      } else {
        entryPointContents = entryPointContents.replace(
          "__IMPORTED_PROJECT_CONFIG__",
          `const importedConfig = undefined; const handleError = undefined;`
        );
      }

      logger.log(chalkGrey("○ Building background worker…"));

      ctx = await context({
        stdin: {
          contents: entryPointContents,
          resolveDir: process.cwd(),
          sourcefile: "__entryPoint.ts",
        },
        banner: {
          js: `process.on("uncaughtException", function(error, origin) { if (error instanceof Error) { process.send && process.send({ type: "UNCAUGHT_EXCEPTION", payload: { error: { name: error.name, message: error.message, stack: error.stack }, origin }, version: "v1" }); } else { process.send && process.send({ type: "UNCAUGHT_EXCEPTION", payload: { error: { name: "Error", message: typeof error === "string" ? error : JSON.stringify(error) }, origin }, version: "v1" }); } });`,
        },
        bundle: true,
        metafile: true,
        write: false,
        minify: false,
        sourcemap: "external", // does not set the //# sourceMappingURL= comment in the file, we handle it ourselves
        logLevel: "error",
        platform: "node",
        format: "cjs", // This is needed to support opentelemetry instrumentation that uses module patching
        target: ["node18", "es2020"],
        outdir: "out",
        define: {
          TRIGGER_API_URL: `"${config.triggerUrl}"`,
          __PROJECT_CONFIG__: JSON.stringify(config),
        },
        plugins: [
          mockServerOnlyPlugin(),
          bundleTriggerDevCore("workerFacade", config.tsconfigPath),
          bundleDependenciesPlugin(
            "workerFacade",
            (config.dependenciesToBundle ?? []).concat([/^@trigger.dev/]),
            config.tsconfigPath
          ),
          workerSetupImportConfigPlugin(configPath),
          esbuildDecorators({
            tsconfig: config.tsconfigPath,
            tsx: true,
            force: false,
          }),
          {
            name: "trigger.dev v3",
            setup(build) {
              build.onEnd(async (result) => {
                if (result.errors.length > 0) return;
                if (!result || !result.outputFiles) {
                  logger.error("Build failed: no result");
                  return;
                }

                if (!firstBuild) {
                  logger.log(chalkGrey("○ Building background worker…"));
                }

                const metaOutputKey = join("out", `stdin.js`).replace(/\\/g, "/");

                const metaOutput = result.metafile!.outputs[metaOutputKey];

                if (!metaOutput) {
                  throw new Error(`Could not find metafile`);
                }

                const outputFileKey = join(config.projectDir, metaOutputKey);
                const outputFile = result.outputFiles.find((file) => file.path === outputFileKey);

                if (!outputFile) {
                  throw new Error(
                    `Could not find output file for entry point ${metaOutput.entryPoint}`
                  );
                }

                const sourceMapFileKey = join(config.projectDir, `${metaOutputKey}.map`);
                const sourceMapFile = result.outputFiles.find(
                  (file) => file.path === sourceMapFileKey
                );

                const md5Hasher = createHash("md5");
                md5Hasher.update(Buffer.from(outputFile.contents.buffer));

                const contentHash = md5Hasher.digest("hex");

                if (latestWorkerContentHash === contentHash) {
                  logger.log(chalkGrey("○ No changes detected, skipping build…"));

                  return;
                }

                // Create a file at join(dir, ".trigger", path) with the fileContents
                const fullPath = join(config.projectDir, ".trigger", `${contentHash}.js`);
                const sourceMapPath = `${fullPath}.map`;

                const outputFileWithSourceMap = `${
                  outputFile.text
                }\n//# sourceMappingURL=${basename(sourceMapPath)}`;

                await fs.promises.mkdir(dirname(fullPath), { recursive: true });
                await fs.promises.writeFile(fullPath, outputFileWithSourceMap);

                logger.debug(`Wrote background worker to ${fullPath}`);

                const dependencies = await gatherRequiredDependencies(metaOutput, config);

                if (sourceMapFile) {
                  const sourceMapPath = `${fullPath}.map`;
                  await fs.promises.writeFile(sourceMapPath, sourceMapFile.text);
                }

                const environmentVariablesResponse =
                  await environmentClient.getEnvironmentVariables(config.project);

                const processEnv = await gatherProcessEnv();

                const backgroundWorker = new BackgroundWorker(
                  fullPath,
                  {
                    projectConfig: config,
                    dependencies,
                    env: {
                      ...processEnv,
                      TRIGGER_API_URL: apiUrl,
                      TRIGGER_SECRET_KEY: apiKey,
                      ...(environmentVariablesResponse.success
                        ? environmentVariablesResponse.data.variables
                        : {}),
                    },
                    debuggerOn,
                    debugOtel,
                    resolveEnvVariables: createResolveEnvironmentVariablesFunction(configModule),
                  },
                  environmentClient
                );

                try {
                  await backgroundWorker.initialize();

                  latestWorkerContentHash = contentHash;

                  let packageVersion: string | undefined;

                  const taskResources: Array<TaskResource> = [];

                  if (!backgroundWorker.tasks || backgroundWorker.tasks.length === 0) {
                    logger.log(
                      `${chalkError(
                        "X Error:"
                      )} Worker failed to build: no tasks found. Searched in ${config.triggerDirectories.join(
                        ", "
                      )}`
                    );
                    return;
                  }

                  for (const task of backgroundWorker.tasks) {
                    taskResources.push(task);

                    packageVersion = task.packageVersion;
                  }

                  if (!packageVersion) {
                    throw new Error(`Background Worker started without package version`);
                  }

                  // Check for any duplicate task ids
                  const taskIds = taskResources.map((task) => task.id);
                  const duplicateTaskIds = taskIds.filter(
                    (id, index) => taskIds.indexOf(id) !== index
                  );

                  if (duplicateTaskIds.length > 0) {
                    logger.error(
                      createDuplicateTaskIdOutputErrorMessage(duplicateTaskIds, taskResources)
                    );
                    return;
                  }

                  logger.debug("Creating background worker with tasks", {
                    tasks: taskResources,
                  });

                  const backgroundWorkerBody: CreateBackgroundWorkerRequestBody = {
                    localOnly: true,
                    metadata: {
                      packageVersion,
                      cliPackageVersion: packageJson.version,
                      tasks: taskResources,
                      contentHash: contentHash,
                    },
                    supportsLazyAttempts: true,
                  };

                  const backgroundWorkerRecord = await environmentClient.createBackgroundWorker(
                    config.project,
                    backgroundWorkerBody
                  );

                  if (!backgroundWorkerRecord.success) {
                    throw new Error(backgroundWorkerRecord.error);
                  }

                  backgroundWorker.metadata = backgroundWorkerRecord.data;
                  backgroundWorker;

                  const testUrl = `${dashboardUrl}/projects/v3/${config.project}/test?environment=dev`;
                  const runsUrl = `${dashboardUrl}/projects/v3/${config.project}/runs?envSlug=dev`;

                  const pipe = chalkGrey("|");
                  const bullet = chalkGrey("○");
                  const arrow = chalkGrey("->");

                  const testLink = chalkLink(cliLink("Test tasks", testUrl));
                  const runsLink = chalkLink(cliLink("View runs", runsUrl));

                  const workerStarted = chalkGrey("Background worker started");
                  const workerVersion = chalkWorker(backgroundWorkerRecord.data.version);

                  logger.log(
                    `${bullet} ${workerStarted} ${arrow} ${workerVersion} ${pipe} ${testLink} ${pipe} ${runsLink}`
                  );

                  firstBuild = false;

                  await backgroundWorkerCoordinator.registerWorker(
                    backgroundWorkerRecord.data,
                    backgroundWorker
                  );
                } catch (e) {
                  logger.debug("Error starting background worker", {
                    error: e,
                  });

                  if (e instanceof TaskMetadataParseError) {
                    logTaskMetadataParseError(e.zodIssues, e.tasks);
                    return;
                  } else if (e instanceof UncaughtExceptionError) {
                    const parsedBuildError = parseBuildErrorStack(e.originalError);

                    if (parsedBuildError && typeof parsedBuildError !== "string") {
                      logESMRequireError(
                        parsedBuildError,
                        configPath
                          ? { status: "file", path: configPath, config }
                          : { status: "in-memory", config }
                      );
                      return;
                    } else {
                    }

                    if (e.originalError.message || e.originalError.stack) {
                      logger.log(
                        `${chalkError("X Error:")} Worker failed to start`,
                        e.originalError.stack ?? e.originalError.message
                      );
                    }

                    return;
                  }

                  const parsedError = parseNpmInstallError(e);

                  if (typeof parsedError === "string") {
                    logger.log(`\n${chalkError("X Error:")} ${parsedError}`);
                  } else {
                    switch (parsedError.type) {
                      case "package-not-found-error": {
                        logger.log(
                          `\n${chalkError("X Error:")} The package ${chalkPurple(
                            parsedError.packageName
                          )} could not be found in the npm registry.`
                        );

                        break;
                      }
                      case "no-matching-version-error": {
                        logger.log(
                          `\n${chalkError("X Error:")} The package ${chalkPurple(
                            parsedError.packageName
                          )} could not resolve because the version doesn't exist`
                        );

                        break;
                      }
                    }
                  }

                  const stderr = backgroundWorker.stderr
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0)
                    .join("\n");

                  if (stderr) {
                    logger.log(`\n${chalkError("X Error logs:")}\n${stderr}`);
                  }
                }
              });
            },
          },
        ],
      });

      await ctx.watch();
    }

    const throttledRebuild = pDebounce(runBuild, 250, { before: true });

    const taskFileWatcher = watch(
      config.triggerDirectories.map((triggerDir) => `${triggerDir}/**/*.ts`),
      {
        ignoreInitial: true,
      }
    );

    taskFileWatcher.on("add", async (path) => {
      throttledRebuild().catch((error) => {
        logger.error(error);
      });
    });

    taskFileWatcher.on("unlink", async (path) => {
      throttledRebuild().catch((error) => {
        logger.error(error);
      });
    });

    throttledRebuild().catch((error) => {
      logger.error(error);
    });

    return () => {
      const cleanup = async () => {
        logger.debug(`Shutting down dev session for ${config.project}`);

        const start = Date.now();

        await taskFileWatcher.close();

        websocket?.close();
        backgroundWorkerCoordinator.close();
        ctx?.dispose().catch((error) => {
          console.error(error);
        });

        logger.debug(`Shutdown completed in ${Date.now() - start}ms`);
      };

      cleanup();
    };
  }, [config, apiUrl, apiKey, environmentClient]);
}

function DevUI(props: DevProps) {
  return (
    <Suspense>
      <DevUIImp {...props} />
    </Suspense>
  );
}

function DevUIImp(props: DevProps) {
  const dev = useDev(props);

  return (
    <>
      <HotKeys />
    </>
  );
}

function useHotkeys() {
  useInput(async (input, key) => {});
}

function HotKeys() {
  useHotkeys();

  return <></>;
}

function WebsocketFactory(apiKey: string) {
  return class extends wsWebSocket {
    constructor(address: string | URL, options?: ClientOptions | ClientRequestArgs) {
      super(address, { ...(options ?? {}), headers: { Authorization: `Bearer ${apiKey}` } });
    }
  };
}

// Returns the dependencies that are required by the output that are found in output and the CLI package dependencies
// Returns the dependency names and the version to use (taken from the CLI deps package.json)
async function gatherRequiredDependencies(
  outputMeta: Metafile["outputs"][string],
  config: ResolvedConfig
) {
  const dependencies: Record<string, string> = {};

  logger.debug("Gathering required dependencies from imports", {
    imports: outputMeta.imports,
  });

  for (const file of outputMeta.imports) {
    if ((file.kind !== "require-call" && file.kind !== "dynamic-import") || !file.external) {
      continue;
    }

    const packageName = detectPackageNameFromImportPath(file.path);

    if (dependencies[packageName]) {
      continue;
    }

    const internalDependencyVersion =
      (packageJson.dependencies as Record<string, string>)[packageName] ??
      detectDependencyVersion(packageName);

    if (internalDependencyVersion) {
      dependencies[packageName] = stripWorkspaceFromVersion(internalDependencyVersion);
    }
  }

  if (config.additionalPackages) {
    const projectPackageJson = await readJSONFile(join(config.projectDir, "package.json"));

    for (const packageName of config.additionalPackages) {
      if (dependencies[packageName]) {
        continue;
      }

      const packageParts = parsePackageName(packageName);

      if (packageParts.version) {
        dependencies[packageParts.name] = packageParts.version;
        continue;
      } else {
        const externalDependencyVersion = {
          ...projectPackageJson?.devDependencies,
          ...projectPackageJson?.dependencies,
        }[packageName];

        if (externalDependencyVersion) {
          dependencies[packageParts.name] = externalDependencyVersion;
          continue;
        } else {
          logger.warn(
            `Could not find version for package ${packageName}, add a version specifier to the package name (e.g. ${packageParts.name}@latest) or add it to your project's package.json`
          );
        }
      }
    }
  }

  return dependencies;
}

function createDuplicateTaskIdOutputErrorMessage(
  duplicateTaskIds: Array<string>,
  taskResources: Array<TaskResource>
) {
  const duplicateTable = duplicateTaskIds
    .map((id) => {
      const tasks = taskResources.filter((task) => task.id === id);

      return `\n\n${chalkTask(id)} was found in:${tasks
        .map((task) => `\n${task.filePath} -> ${task.exportName}`)
        .join("")}`;
    })
    .join("");

  return `Duplicate ${chalkTask("task id")} detected:${duplicateTable}`;
}

async function gatherProcessEnv() {
  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? "development",
    NODE_PATH: await amendNodePathWithPnpmNodeModules(process.env.NODE_PATH),
  };

  // Filter out undefined values
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined));
}

async function amendNodePathWithPnpmNodeModules(nodePath?: string): Promise<string | undefined> {
  const pnpmModulesPath = await findPnpmNodeModulesPath();

  if (!pnpmModulesPath) {
    return nodePath;
  }

  if (nodePath) {
    if (nodePath.includes(pnpmModulesPath)) {
      return nodePath;
    }

    return `${nodePath}:${pnpmModulesPath}`;
  }

  return pnpmModulesPath;
}

async function findPnpmNodeModulesPath(): Promise<string | undefined> {
  return await findUp(
    async (directory) => {
      const pnpmModules = join(directory, "node_modules", ".pnpm", "node_modules");

      const hasPnpmNodeModules = await pathExists(pnpmModules);

      if (hasPnpmNodeModules) {
        return pnpmModules;
      }
    },
    { type: "directory" }
  );
}

let hasResolvedEnvVars = false;
let resolvedEnvVars: Record<string, string> = {};

function createResolveEnvironmentVariablesFunction(configModule?: any) {
  return async (
    env: Record<string, string>,
    worker: BackgroundWorker
  ): Promise<Record<string, string> | undefined> => {
    if (hasResolvedEnvVars) {
      return resolvedEnvVars;
    }

    const $resolvedEnvVars = await callResolveEnvVars(
      configModule,
      env,
      "dev",
      worker.params.projectConfig.project
    );

    if ($resolvedEnvVars) {
      resolvedEnvVars = $resolvedEnvVars.variables;
      hasResolvedEnvVars = true;
    }

    return resolvedEnvVars;
  };
}

type WebsocketPingOptions = {
  callback: () => Promise<void>;
  pingIntervalInMs?: number;
};

class WebsocketPing {
  private _callback: () => Promise<void>;
  private _pingIntervalInMs: number;
  private _nextPingIteration: NodeJS.Timeout | undefined;

  constructor(opts: WebsocketPingOptions) {
    this._callback = opts.callback;
    this._pingIntervalInMs = opts.pingIntervalInMs ?? 45_000;
    this._nextPingIteration = undefined;
  }

  start() {
    this.#sendPing();
  }

  stop() {
    clearTimeout(this._nextPingIteration);
  }

  #sendPing = async () => {
    await this._callback();

    this._nextPingIteration = setTimeout(this.#sendPing, this._pingIntervalInMs);
  };
}
