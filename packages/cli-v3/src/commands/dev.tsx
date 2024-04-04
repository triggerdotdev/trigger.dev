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
import { watch } from "chokidar";
import { Command } from "commander";
import { BuildContext, Metafile, context } from "esbuild";
import { resolve as importResolve } from "import-meta-resolve";
import { render, useInput } from "ink";
import { createHash } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import { ClientRequestArgs } from "node:http";
import { basename, dirname, join } from "node:path";
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
  workerSetupImportConfigPlugin,
} from "../utilities/build";
import { chalkError, chalkGrey, chalkPurple, chalkTask, chalkWorker } from "../utilities/cliOutput";
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
      .option("-c, --config <config file>", "The name of the config file, found at [path].")
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
      logger.log(`${chalkError("X Error:")} You must login first. Use the \`login\` CLI command.`);
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
    printDevBanner();

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
        if (devEnv.error === "Project not found") {
          logger.error(
            `Project not found: ${config.config.project}. Ensure you are using the correct project ref and CLI profile (use --profile). Currently using the "${options.profile}" profile, which points to ${authorization.apiUrl}`
          );
        } else {
          logger.error(
            `Failed to initialize dev environment: ${devEnv.error}. Using project ref ${config.config.project}`
          );
        }

        process.exit(1);
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
        // This will stop the watching
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

      logger.log(chalkGrey("○ Building background worker…"));

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
          bundleTriggerDevCore("workerFacade", config.tsconfigPath),
          bundleDependenciesPlugin(
            "workerFacade",
            (config.dependenciesToBundle ?? []).concat([/^@trigger.dev/]),
            config.tsconfigPath
          ),
          workerSetupImportConfigPlugin(configPath),
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

                  logger.log(
                    `${chalkGrey(
                      `○ Background worker started -> ${chalkWorker(
                        backgroundWorkerRecord.data.version
                      )}`
                    )}`
                  );

                  firstBuild = false;

                  await backgroundWorkerCoordinator.registerWorker(
                    backgroundWorkerRecord.data,
                    backgroundWorker
                  );
                } catch (e) {
                  if (e instanceof TaskMetadataParseError) {
                    logTaskMetadataParseError(e.zodIssues, e.tasks);
                    return;
                  } else if (e instanceof UncaughtExceptionError) {
                    const parsedBuildError = parseBuildErrorStack(e.originalError);

                    if (typeof parsedBuildError !== "string") {
                      logESMRequireError(
                        parsedBuildError,
                        configPath
                          ? { status: "file", path: configPath, config }
                          : { status: "in-memory", config }
                      );
                      return;
                    } else {
                    }

                    if (e.originalError.stack) {
                      logger.log(
                        `${chalkError("X Error:")} Worker failed to start`,
                        e.originalError.stack
                      );
                    }

                    return;
                  }

                  const parsedError = parseNpmInstallError(e);

                  if (typeof parsedError === "string") {
                    logger.log(`${chalkError("X Error:")} ${parsedError}`);
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
    NODE_ENV: process.env.NODE_ENV ?? "development",
    PATH: process.env.PATH,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    NVM_INC: process.env.NVM_INC,
    NVM_DIR: process.env.NVM_DIR,
    NVM_BIN: process.env.NVM_BIN,
    LANG: process.env.LANG,
    TERM: process.env.TERM,
    NODE_PATH: await amendNodePathWithPnpmNodeModules(process.env.NODE_PATH),
    HOME: process.env.HOME,
    BUN_INSTALL: process.env.BUN_INSTALL,
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
