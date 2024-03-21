import {
  CreateBackgroundWorkerRequestBody,
  ResolvedConfig,
  TaskResource,
  ZodMessageHandler,
  ZodMessageSender,
  clientWebsocketMessages,
  detectDependencyVersion,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import chalk from "chalk";
import { watch } from "chokidar";
import { Command } from "commander";
import { BuildContext, Metafile, context } from "esbuild";
import { resolve as importResolve } from "import-meta-resolve";
import { Box, Text, render, useApp, useInput } from "ink";
import { createHash } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import { ClientRequestArgs } from "node:http";
import { basename, dirname, join } from "node:path";
import pThrottle from "p-throttle";
import { WebSocket } from "partysocket";
import React, { Suspense, useEffect } from "react";
import { ClientOptions, WebSocket as wsWebSocket } from "ws";
import { z } from "zod";
import * as packageJson from "../../package.json";
import { CliApiClient } from "../apiClient";
import { CommonCommandOptions, commonOptions, wrapCommandAction } from "../cli/common.js";
import { readConfig } from "../utilities/configFiles";
import { readJSONFile } from "../utilities/fileSystem";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import {
  detectPackageNameFromImportPath,
  parsePackageName,
  stripWorkspaceFromVersion,
} from "../utilities/installPackages";
import { logger } from "../utilities/logger.js";
import { isLoggedIn } from "../utilities/session.js";
import { createTaskFileImports, gatherTaskFiles } from "../utilities/taskFiles";
import { UncaughtExceptionError } from "../workers/common/errors";
import { BackgroundWorker, BackgroundWorkerCoordinator } from "../workers/dev/backgroundWorker.js";

let apiClient: CliApiClient | undefined;

const DevCommandOptions = CommonCommandOptions.extend({
  debugger: z.boolean().default(false),
  debugOtel: z.boolean().default(false),
  config: z.string().optional(),
  projectRef: z.string().optional(),
});

type DevCommandOptions = z.infer<typeof DevCommandOptions>;

export function configureDevCommand(program: Command) {
  return commonOptions(
    program
      .command("dev")
      .description("Run your Trigger.dev tasks locally")
      .argument("[path]", "The path to the project", ".")
      .option("-c, --config <config file>", "The name of the config file, found at [path]")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file."
      )
      .option("--debugger", "Enable the debugger")
      .option("--debug-otel", "Enable OpenTelemetry debugging")
  ).action(async (path, options) => {
    wrapCommandAction("dev", DevCommandOptions, options, async (opts) => {
      await devCommand(path, opts);
    });
  });
}

export async function devCommand(dir: string, options: DevCommandOptions) {
  const authorization = await isLoggedIn(options.profile);

  if (!authorization.ok) {
    if (authorization.error === "fetch failed") {
      logger.error("Fetch failed. Platform down?");
    } else {
      logger.error("You must login first. Use `trigger.dev login` to login.");
    }
    process.exitCode = 1;
    return;
  }

  const devInstance = await startDev(dir, options, authorization.auth);
  const { waitUntilExit } = devInstance.devReactElement;
  await waitUntilExit();
}

async function startDev(
  dir: string,
  options: DevCommandOptions,
  authorization: { apiUrl: string; accessToken: string }
) {
  let rerender: (node: React.ReactNode) => void | undefined;

  try {
    if (options.logLevel) {
      logger.loggerLevel = options.logLevel;
    }

    await printStandloneInitialBanner(true);

    logger.debug("Starting dev session", { dir, options, authorization });

    let config = await readConfig(dir, {
      projectRef: options.projectRef,
      configFile: options.config,
    });

    logger.debug("Initial config", { config });

    async function getDevReactElement(
      configParam: ResolvedConfig,
      authorization: { apiUrl: string; accessToken: string },
      configPath?: string
    ) {
      const accessToken = authorization.accessToken;
      const apiUrl = authorization.apiUrl;

      apiClient = new CliApiClient(apiUrl, accessToken);

      const devEnv = await apiClient.getProjectEnv({
        projectRef: config.config.project,
        env: "dev",
      });

      if (!devEnv.success) {
        throw new Error(devEnv.error);
      }

      const environmentClient = new CliApiClient(apiUrl, devEnv.data.apiKey);

      return (
        <DevUI
          config={configParam}
          apiUrl={apiUrl}
          apiKey={devEnv.data.apiKey}
          environmentClient={environmentClient}
          projectName={devEnv.data.name}
          debuggerOn={options.debugger}
          debugOtel={options.debugOtel}
          configPath={configPath}
        />
      );
    }

    const devReactElement = render(
      await getDevReactElement(
        config.config,
        authorization,
        config.status === "file" ? config.path : undefined
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
  apiUrl: string;
  apiKey: string;
  environmentClient: CliApiClient;
  projectName: string;
  debuggerOn: boolean;
  debugOtel: boolean;
  configPath?: string;
};

function useDev({
  config,
  apiUrl,
  apiKey,
  environmentClient,
  projectName,
  debuggerOn,
  debugOtel,
  configPath,
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
      `${apiUrl}/projects/v3/${config.project}`
    );

    websocket.addEventListener("open", async (event) => {});
    websocket.addEventListener("close", (event) => {});
    websocket.addEventListener("error", (event) => {});

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

    websocket.addEventListener("message", async (event) => {
      const data = JSON.parse(
        typeof event.data === "string" ? event.data : new TextDecoder("utf-8").decode(event.data)
      );

      const messageHandler = new ZodMessageHandler({
        schema: serverWebsocketMessages,
        messages: {
          SERVER_READY: async (payload) => {
            for (const worker of backgroundWorkerCoordinator.currentWorkers) {
              await sender.send("READY_FOR_TASKS", {
                backgroundWorkerId: worker.id,
              });
            }
          },
          BACKGROUND_WORKER_MESSAGE: async (payload) => {
            await backgroundWorkerCoordinator.handleMessage(
              payload.backgroundWorkerId,
              payload.data
            );
          },
        },
      });

      await messageHandler.handleMessage(data);
    });

    let ctx: BuildContext | undefined;

    async function runBuild() {
      if (ctx) {
        await ctx.cancel();
        await ctx.dispose();
      }

      let latestWorkerContentHash: string | undefined;

      const taskFiles = await gatherTaskFiles(config);

      const workerFacade = readFileSync(
        new URL(importResolve("./workers/dev/worker-facade.js", import.meta.url)).href.replace(
          "file://",
          ""
        ),
        "utf-8"
      );

      const workerSetupPath = new URL(
        importResolve("./workers/dev/worker-setup.js", import.meta.url)
      ).href.replace("file://", "");

      let entryPointContents = workerFacade
        .replace("__TASKS__", createTaskFileImports(taskFiles))
        .replace("__WORKER_SETUP__", `import { tracingSDK, sender } from "${workerSetupPath}";`);

      if (configPath) {
        logger.debug("Importing project config from", { configPath });

        entryPointContents = entryPointContents.replace(
          "__IMPORTED_PROJECT_CONFIG__",
          `import * as importedConfigExports from "${configPath}"; const importedConfig = importedConfigExports.config; const handleError = importedConfigExports.handleError;`
        );
      } else {
        entryPointContents = entryPointContents.replace(
          "__IMPORTED_PROJECT_CONFIG__",
          `const importedConfig = undefined; const handleError = undefined;`
        );
      }

      let firstBuild = true;

      logger.log(chalk.dim("⎔ Building background worker..."));

      ctx = await context({
        stdin: {
          contents: entryPointContents,
          resolveDir: process.cwd(),
          sourcefile: "__entryPoint.ts",
        },
        bundle: true,
        metafile: true,
        write: false,
        minify: false,
        sourcemap: "external", // does not set the //# sourceMappingURL= comment in the file, we handle it ourselves
        packages: "external", // https://esbuild.github.io/api/#packages
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
                  logger.log(chalk.dim("⎔ Rebuilding background worker..."));
                }

                const metaOutputKey = join("out", `stdin.js`);

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
                  logger.log(chalk.dim("⎔ No changes detected, skipping build..."));

                  logger.debug(`No changes detected, skipping build`);
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

                const processEnv = gatherProcessEnv();

                const backgroundWorker = new BackgroundWorker(fullPath, {
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
                });

                try {
                  await backgroundWorker.initialize();

                  latestWorkerContentHash = contentHash;

                  let packageVersion: string | undefined;

                  const taskResources: Array<TaskResource> = [];

                  if (!backgroundWorker.tasks) {
                    throw new Error(`Background Worker started without tasks`);
                  }

                  for (const task of backgroundWorker.tasks) {
                    taskResources.push(task);

                    packageVersion = task.packageVersion;
                  }

                  if (!packageVersion) {
                    throw new Error(`Background Worker started without package version`);
                  }

                  const backgroundWorkerBody: CreateBackgroundWorkerRequestBody = {
                    localOnly: true,
                    metadata: {
                      packageVersion,
                      cliPackageVersion: packageJson.version,
                      tasks: taskResources,
                      contentHash: contentHash,
                    },
                  };

                  const backgroundWorkerRecord = await environmentClient.createBackgroundWorker(
                    config.project,
                    backgroundWorkerBody
                  );

                  if (!backgroundWorkerRecord.success) {
                    throw new Error(backgroundWorkerRecord.error);
                  }

                  backgroundWorker.metadata = backgroundWorkerRecord.data;

                  if (firstBuild) {
                    logger.log(
                      chalk.green(
                        `Background worker started (${backgroundWorkerRecord.data.version})`
                      )
                    );
                  } else {
                    logger.log(
                      chalk.dim(
                        `Background worker rebuilt (${backgroundWorkerRecord.data.version})`
                      )
                    );
                  }

                  firstBuild = false;

                  await backgroundWorkerCoordinator.registerWorker(
                    backgroundWorkerRecord.data,
                    backgroundWorker
                  );
                } catch (e) {
                  if (e instanceof UncaughtExceptionError) {
                    if (e.originalError.stack) {
                      logger.error("Background worker failed to start", e.originalError.stack);
                    }

                    return;
                  }

                  if (e instanceof Error) {
                    logger.error(`Background worker failed to start`, e.stack);

                    return;
                  }

                  logger.error(`Background worker failed to start: ${e}`);
                }
              });
            },
          },
        ],
      });

      await ctx.watch();
    }

    const throttle = pThrottle({
      limit: 2,
      interval: 1000,
    });

    const throttledRebuild = throttle(runBuild);

    const taskFileWatcher = watch(
      config.triggerDirectories.map((triggerDir) => `${triggerDir}/*.ts`),
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
      logger.debug(`Shutting down dev session for ${config.project}`);

      taskFileWatcher.close();

      websocket?.close();
      backgroundWorkerCoordinator.close();
      ctx?.dispose().catch((error) => {
        console.error(error);
      });
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
  const { exit } = useApp();

  useInput(async (input, key) => {
    if (key.return) {
      console.log("");
      return;
    }
    switch (input.toLowerCase()) {
      // clear console
      case "c":
        console.clear();
        // This console.log causes Ink to re-render the `DevSession` component.
        // Couldn't find a better way to tell it to do so...
        console.log();
        break;
      // open browser
      case "b": {
        break;
      }
      // toggle inspector
      // case "d": {
      // 	if (inspect) {
      // 		await openInspector(inspectorPort, props.worker);
      // 	}
      // 	break;
      // }

      // shut down
      case "q":
      case "x":
        exit();
        break;
      default:
        // nothing?
        break;
    }
  });
}

function HotKeys() {
  useHotkeys();

  return (
    <Box borderStyle="round" paddingLeft={1} paddingRight={1}>
      <Text bold={true}>[b]</Text>
      <Text> open a browser, </Text>
      <Text bold={true}>[c]</Text>
      <Text> clear console, </Text>
      <Text bold={true}>[x]</Text>
      <Text> to exit</Text>
    </Box>
  );
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

  for (const file of outputMeta.imports) {
    if (file.kind !== "require-call" || !file.external) {
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

function gatherProcessEnv() {
  const env = {
    NODE_ENV: process.env.NODE_ENV ?? "development",
    PATH: process.env.PATH,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    NVM_INC: process.env.NVM_INC,
    NVM_DIR: process.env.NVM_DIR,
    NVM_BIN: process.env.NVM_BIN,
    LANG: process.env.LANG,
    TERM: process.env.TERM,
    NODE_PATH: process.env.NODE_PATH,
    HOME: process.env.HOME,
    BUN_INSTALL: process.env.BUN_INSTALL,
  };

  // Filter out undefined values
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined));
}
