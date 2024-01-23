import { CreateBackgroundWorkerRequestBody, TaskResource } from "@trigger.dev/core/v3";
import { watch } from "chokidar";
import { Command } from "commander";
import { BuildContext, context } from "esbuild";
import { findUp } from "find-up";
import { resolve as importResolve } from "import-meta-resolve";
import { Box, Text, render, useApp, useInput } from "ink";
import { createHash } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import { ClientRequestArgs } from "node:http";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "partysocket";
import React, { Suspense, useEffect, useState } from "react";
import { ClientOptions, WebSocket as wsWebSocket } from "ws";
import { z } from "zod";
import * as packageJson from "../../package.json";
import { ApiClient } from "../apiClient";
import { CLOUD_API_URL } from "../consts";
import {
  BackgroundWorker,
  BackgroundWorkerCoordinator,
  CurrentWorkers,
} from "../dev/backgroundWorker";
import { printStandloneInitialBanner } from "../utilities/initialBanner";
import { logger } from "../utilities/logger";
import { RequireKeys } from "../utilities/requiredKeys";
import { isLoggedIn } from "../utilities/session";
import chalk from "chalk";
import pThrottle from "p-throttle";

const CONFIG_FILES = ["trigger.config.js", "trigger.config.mjs"];

const ConfigSchema = z.object({
  project: z.string(),
  triggerDirectories: z.string().array().optional(),
  triggerUrl: z.string().optional(),
  projectDir: z.string().optional(),
});

type Config = z.infer<typeof ConfigSchema>;
type ResolvedConfig = RequireKeys<Config, "triggerDirectories" | "triggerUrl" | "projectDir">;
type TaskFile = {
  triggerDir: string;
  filePath: string;
  importPath: string;
  importName: string;
};

let apiClient: ApiClient | undefined;

// Handling file changes
// Use stdin instead of entryPoints
// stdin will dynamically import all the trigger files
// this will create a single output file for all the trigger files
// we can use esbuild context and watch (like partykit)
// So we'll need to be able to read the trigger files, parse them, and detect all the exports
// We can use ink and useEffect where the return value of useEffect will dispose of the esbuild context, and create a new one with a new stdin
// Watch for any changes to
// Step 1: Signal to any existing coordinators that they should stop accepting new tasks and when existing tasks are complete the task runners should be stopped
// Step 2: Build the new entry points
// Step 3: Start the new task runners
// Step 4: Create a new coordinator for the new task runners
// Step 5: Signal the new coordinator that it should start accepting new tasks

const DevCommandOptions = z.object({
  logLevel: z.enum(["debug", "info", "log", "warn", "error", "none"]).default("log"),
});

type DevCommandOptions = z.infer<typeof DevCommandOptions>;

export function configureDevCommand(program: Command) {
  program
    .command("dev")
    .description("Run your Trigger.dev tasks locally")
    .argument("[path]", "The path to the project", ".")
    .option(
      "-l, --log-level <level>",
      "The log level to use (debug, info, log, warn, error, none)",
      "log"
    )
    .action(async (path, options) => {
      try {
        await devCommand(path, options);
      } catch (e) {
        //todo error reporting
        throw e;
      }
    });
}

export async function devCommand(dir: string, anyOptions: unknown) {
  const options = DevCommandOptions.safeParse(anyOptions);

  if (!options.success) {
    throw new Error(`Invalid options: ${options.error}`);
  }

  const authorization = await isLoggedIn();

  if (!authorization.ok) {
    logger.error("You must login first. Use `trigger.dev login` to login.");
    process.exitCode = 1;
    return;
  }

  let watcher;

  try {
    const devInstance = await startDev(dir, options.data, authorization.config);
    watcher = devInstance.watcher;
    const { waitUntilExit } = devInstance.devReactElement;
    await waitUntilExit();
  } finally {
    await watcher?.close();
  }
}

async function startDev(
  dir: string,
  options: DevCommandOptions,
  authorization: { apiUrl: string; accessToken: string }
) {
  let watcher: ReturnType<typeof watch> | undefined;
  let rerender: (node: React.ReactNode) => void | undefined;

  try {
    if (options.logLevel) {
      logger.loggerLevel = options.logLevel;
    }

    await printStandloneInitialBanner(true);

    const configPath = await getConfigPath(dir);
    let config = await readConfig(configPath);

    watcher = watch(configPath, {
      persistent: true,
    }).on("change", async (_event) => {
      config = await readConfig(configPath);
      logger.log(`${basename(configPath)} changed...`);
      logger.debug("New config", { config });
      rerender(await getDevReactElement(config, authorization));
    });

    async function getDevReactElement(
      configParam: ResolvedConfig,
      authorization: { apiUrl: string; accessToken: string }
    ) {
      const accessToken = authorization.accessToken;
      const apiUrl = authorization.apiUrl;

      apiClient = new ApiClient(apiUrl, accessToken);

      const devEnv = await apiClient.getProjectDevEnv({ projectRef: config.project });

      if (!devEnv.success) {
        throw new Error(devEnv.error);
      }

      const environmentClient = new ApiClient(apiUrl, devEnv.data.apiKey);

      return (
        <DevUI
          config={config}
          apiUrl={apiUrl}
          apiKey={devEnv.data.apiKey}
          environmentClient={environmentClient}
        />
      );
    }

    const devReactElement = render(await getDevReactElement(config, authorization));

    rerender = devReactElement.rerender;

    return {
      devReactElement,
      watcher,
      stop: async () => {
        devReactElement.unmount();
        await watcher?.close();
      },
    };
  } catch (e) {
    await watcher?.close();
    throw e;
  }
}

type DevProps = {
  config: ResolvedConfig;
  apiUrl: string;
  apiKey: string;
  environmentClient: ApiClient;
};

function useDev({ config, apiUrl, apiKey, environmentClient }: DevProps) {
  useEffect(() => {
    const websocketUrl = new URL(apiUrl);
    websocketUrl.protocol = websocketUrl.protocol.replace("http", "ws");
    websocketUrl.pathname = `/ws`;

    const websocket = new WebSocket(websocketUrl.href, [], {
      WebSocket: WebsocketFactory(apiKey),
      connectionTimeout: 10000,
      maxRetries: 6,
    });

    websocket.addEventListener("open", (foo) => {});
    websocket.addEventListener("close", (event) => {});
    websocket.addEventListener("error", (event) => {});

    const backgroundWorkerCoordinator = new BackgroundWorkerCoordinator(
      `${apiUrl}/projects/v3/${config.project}`
    );

    backgroundWorkerCoordinator.onTaskCompleted.attach(({ backgroundWorkerId, execution }) => {
      websocket?.send(
        JSON.stringify({
          message: "BACKGROUND_WORKER_MESSAGE",
          backgroundWorkerId,
          data: {
            type: "TASK_RUN_COMPLETED",
            taskRunCompletion: execution,
          },
        })
      );
    });

    backgroundWorkerCoordinator.onWorkerClosed.attach(({ id }) => {
      websocket.send(
        JSON.stringify({
          message: "WORKER_SHUTDOWN",
          backgroundWorkerId: id,
        })
      );
    });

    backgroundWorkerCoordinator.onWorkerRegistered.attach(({ id, worker, record }) => {
      websocket.send(
        JSON.stringify({
          message: "READY_FOR_TASKS",
          backgroundWorkerId: id,
        })
      );
    });

    backgroundWorkerCoordinator.onWorkerStopped.attach(({ id }) => {
      websocket.send(
        JSON.stringify({
          message: "WORKER_STOPPED",
          backgroundWorkerId: id,
        })
      );
    });

    const serverMessageSchema = z.discriminatedUnion("message", [
      z.object({
        message: z.literal("SERVER_READY"),
        id: z.string(),
      }),
      z.object({
        message: z.literal("BACKGROUND_WORKER_MESSAGE"),
        backgroundWorkerId: z.string(),
        data: z.unknown(),
      }),
    ]);

    websocket.addEventListener("message", async (event) => {
      const data = JSON.parse(
        typeof event.data === "string" ? event.data : new TextDecoder("utf-8").decode(event.data)
      );

      const message = serverMessageSchema.safeParse(data);

      if (!message.success) {
        console.error("Received invalid message", { data });
        return;
      }

      switch (message.data.message) {
        case "SERVER_READY": {
          break;
        }
        case "BACKGROUND_WORKER_MESSAGE": {
          await backgroundWorkerCoordinator.handleMessage(
            message.data.backgroundWorkerId,
            message.data.data
          );

          break;
        }
      }
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
        new URL(importResolve("./worker-facade.js", import.meta.url)).href.replace("file://", ""),
        "utf-8"
      );
      const entryPointContents = workerFacade.replace(
        "__TASKS__",
        createTaskFileImports(taskFiles)
      );

      logger.log(chalk.dim("⎔ Building background worker..."));

      ctx = await context({
        stdin: {
          contents: entryPointContents,
          resolveDir: process.cwd(),
          sourcefile: "src/trigger-worker.ts",
        },
        bundle: true,
        metafile: true,
        write: false,
        minify: false,
        sourcemap: true,
        logLevel: "silent",
        platform: "node",
        format: "esm",
        target: ["node18", "es2020"],
        outdir: "out",
        define: {
          TRIGGER_API_URL: `"${config.triggerUrl}"`,
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

                if (!sourceMapFile) {
                  throw new Error(
                    `Could not find source map file for entry point ${metaOutput.entryPoint}`
                  );
                }

                const md5Hasher = createHash("md5");
                md5Hasher.update(Buffer.from(outputFile.contents.buffer));

                const contentHash = md5Hasher.digest("hex");

                if (latestWorkerContentHash === contentHash) {
                  logger.debug(`No changes detected, skipping build`);
                  return;
                }

                // Create a file at join(dir, ".trigger", path) with the fileContents
                const fullPath = join(config.projectDir, ".trigger", `${contentHash}.mjs`);

                await fs.promises.mkdir(dirname(fullPath), { recursive: true });
                await fs.promises.writeFile(fullPath, outputFile.text);
                const sourceMapPath = `${fullPath}.map`;
                await fs.promises.writeFile(sourceMapPath, sourceMapFile.text);

                const backgroundWorker = new BackgroundWorker(fullPath, {
                  TRIGGER_API_URL: config.triggerUrl,
                  TRIGGER_API_KEY: apiKey,
                });

                await backgroundWorker.start();

                latestWorkerContentHash = contentHash;

                let packageVersion: string | undefined;

                const taskResources: Array<TaskResource> = [];

                if (!backgroundWorker.tasks) {
                  throw new Error(`Background Worker started without tasks`);
                }

                for (const task of backgroundWorker.tasks) {
                  taskResources.push({
                    id: task.id,
                    filePath: task.filePath,
                    exportName: task.exportName,
                  });

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

                logger.log(
                  chalk.green(`Background worker ${backgroundWorkerRecord.data.version} started`)
                );

                await backgroundWorkerCoordinator.registerWorker(
                  backgroundWorkerRecord.data,
                  backgroundWorker
                );
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

function createTaskFileImports(taskFiles: TaskFile[]) {
  return taskFiles
    .map(
      (taskFile) =>
        `import * as ${taskFile.importName} from "./${taskFile.importPath}"; TaskFileImports["${
          taskFile.importName
        }"] = ${taskFile.importName}; TaskFiles["${taskFile.importName}"] = ${JSON.stringify(
          taskFile
        )};`
    )
    .join("\n");
}

// Find all the top-level .js or .ts files in the trigger directories
async function gatherTaskFiles(config: ResolvedConfig): Promise<Array<TaskFile>> {
  const taskFiles: Array<TaskFile> = [];

  for (const triggerDir of config.triggerDirectories) {
    const files = await fs.promises.readdir(triggerDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      if (!file.name.endsWith(".js") && !file.name.endsWith(".ts")) continue;

      const fullPath = join(triggerDir, file.name);

      const filePath = relative(config.projectDir, fullPath);
      const importPath = filePath.replace(/\.(js|ts)$/, "");
      const importName = importPath.replace(/\//g, "_");

      taskFiles.push({ triggerDir, importPath, importName, filePath });
    }
  }

  return taskFiles;
}

async function getConfigPath(dir: string): Promise<string> {
  const path = await findUp(CONFIG_FILES, { cwd: dir });

  if (!path) {
    throw new Error("No config file found.");
  }

  return path;
}

async function readConfig(path: string): Promise<ResolvedConfig> {
  try {
    // import the config file
    const userConfigModule = await import(`${pathToFileURL(path).href}?_ts=${Date.now()}`);
    const rawConfig = await normalizeConfig(userConfigModule ? userConfigModule.default : {});
    const config = ConfigSchema.parse(rawConfig);

    return resolveConfig(path, config);
  } catch (error) {
    console.error(`Failed to load config file at ${path}`);
    throw error;
  }
}

async function resolveConfig(path: string, config: Config): Promise<ResolvedConfig> {
  if (!config.triggerDirectories) {
    config.triggerDirectories = await findTriggerDirectories(path);
  }

  config.triggerDirectories = resolveTriggerDirectories(config.triggerDirectories);

  if (!config.triggerUrl) {
    config.triggerUrl = CLOUD_API_URL;
  }

  if (!config.projectDir) {
    config.projectDir = dirname(path);
  }

  return config as ResolvedConfig;
}

async function normalizeConfig(config: any): Promise<any> {
  if (typeof config === "function") {
    config = config();
  }

  return await config;
}

function resolveTriggerDirectories(dirs: string[]): string[] {
  return dirs.map((dir) => resolve(dir));
}

const IGNORED_DIRS = ["node_modules", ".git", "dist", "build"];

async function findTriggerDirectories(filePath: string): Promise<string[]> {
  const dirPath = dirname(filePath);
  return getTriggerDirectories(dirPath);
}

async function getTriggerDirectories(dirPath: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const triggerDirectories: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRS.includes(entry.name)) continue;

    const fullPath = join(dirPath, entry.name);

    if (entry.name === "trigger") {
      triggerDirectories.push(fullPath);
    }

    triggerDirectories.push(...(await getTriggerDirectories(fullPath)));
  }

  return triggerDirectories;
}
