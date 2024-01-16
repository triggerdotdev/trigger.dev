import { cancel, outro, spinner } from "@clack/prompts";
import { CreateBackgroundWorkerRequestBody, TaskResource } from "@trigger.dev/core/v3";
import { build } from "esbuild";
import { findUp } from "find-up";
import { resolve as importResolve } from "import-meta-resolve";
import { fork } from "node:child_process";
import fs from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ApiClient } from "../apiClient";
import { CLOUD_API_URL } from "../consts";
import { TaskMetadata } from "../types";
import { logger } from "../utilities/logger";
import { RequireKeys } from "../utilities/requiredKeys";
import { isLoggedIn } from "../utilities/session";
import * as packageJson from "../../package.json";

const CONFIG_FILES = ["trigger.config.js", "trigger.config.mjs"];

const ConfigSchema = z.object({
  project: z.string(),
  triggerDirectories: z.string().array().optional(),
  triggerUrl: z.string().optional(),
  projectDir: z.string().optional(),
});

type Config = z.infer<typeof ConfigSchema>;
type ResolvedConfig = RequireKeys<Config, "triggerDirectories" | "triggerUrl" | "projectDir">;
type EntryPoint = {
  triggerDir: string;
  in: string;
  out: string;
};

type EntryPointBundle = Awaited<ReturnType<typeof buildEntryPoints>>;

let apiClient: ApiClient | undefined;

export async function devCommand(dir: string, anyOptions: any) {
  const config = await loadConfig(dir);

  const authorization = await isLoggedIn();

  if (!authorization.ok) {
    logger.error("You must login first. Use `trigger.dev login` to login.");
    return;
  }

  const accessToken = authorization.config.accessToken;
  const apiUrl = authorization.config.apiUrl;

  apiClient = new ApiClient(apiUrl, accessToken);

  const devEnv = await apiClient.getProjectDevEnv({ projectRef: config.project });

  if (!devEnv.success) {
    throw new Error(devEnv.error);
  }

  const entryPoints = await gatherEntryPoints(config);

  const taskRunners = await startTaskRunners(config, entryPoints, {
    TRIGGER_API_URL: config.triggerUrl,
    TRIGGER_API_KEY: devEnv.data.apiKey,
  });

  let taskCount = 0;
  let packageVersion: string | undefined;

  const taskResources: Array<TaskResource> = [];
  const tasksMappedToRunners: Record<string, TaskRunner> = {};

  for (const taskRunner of taskRunners) {
    if (!taskRunner.tasks) {
      throw new Error(`Task Server at ${taskRunner.path} started without tasks`);
    }

    for (const task of taskRunner.tasks!) {
      taskResources.push({
        id: task.id,
        filePath: relative(config.projectDir, taskRunner.sourcePath),
        exportName: task.exportName,
      });

      tasksMappedToRunners[task.id] = taskRunner;

      taskCount++;

      packageVersion = task.packageVersion;
    }
  }

  const indexingSpinner = spinner();
  indexingSpinner.start("Initializing background worker");

  if (!packageVersion) {
    cancel("No tasks found");
    return;
  }

  indexingSpinner.message(`Found ${taskCount} task(s)`);

  const backgroundWorkerBody: CreateBackgroundWorkerRequestBody = {
    localOnly: true,
    metadata: {
      packageVersion,
      cliPackageVersion: packageJson.version,
      tasks: taskResources,
    },
  };

  apiClient = new ApiClient(apiUrl, devEnv.data.apiKey);

  const backgroundWorker = await apiClient.createBackgroundWorker(
    config.project,
    backgroundWorkerBody
  );

  if (!backgroundWorker.success) {
    cancel("Error creating background worker");
    process.exit(1);
  }

  indexingSpinner.stop(`Background worker ${backgroundWorker.data.version} created and ready`);
}

async function startTaskRunners(
  config: ResolvedConfig,
  entryPoints: EntryPoint[],
  env: Record<string, string>
) {
  const bundle = await buildEntryPoints(entryPoints);

  const taskEntryPoints: TaskRunner[] = [];

  for (const entryPoint of entryPoints) {
    taskEntryPoints.push(await startTaskEntryPoint(config, entryPoint, bundle, env));
  }

  return taskEntryPoints;
}

async function startTaskEntryPoint(
  config: ResolvedConfig,
  entryPoint: EntryPoint,
  bundle: EntryPointBundle,
  env: Record<string, string>
) {
  const metaOutputKey = join("out", `${entryPoint.out}.js`);

  const metaOutput = bundle.metafile.outputs[metaOutputKey];

  if (!metaOutput) {
    throw new Error(`Could not find meta output for entry point ${entryPoint.in}`);
  }

  const outputFileKey = join(config.projectDir, metaOutputKey);
  const outputFile = bundle.outputFiles.find((file) => file.path === outputFileKey);

  if (!outputFile) {
    throw new Error(`Could not find output file for entry point ${metaOutput.entryPoint}`);
  }

  const sourceMapFileKey = join(config.projectDir, `${metaOutputKey}.map`);
  const sourceMapFile = bundle.outputFiles.find((file) => file.path === sourceMapFileKey);

  if (!sourceMapFile) {
    throw new Error(`Could not find source map file for entry point ${metaOutput.entryPoint}`);
  }

  const taskRunner = await startTaskRunner(
    config.projectDir,
    entryPoint.in,
    config,
    metaOutputKey,
    outputFile.text,
    sourceMapFile.text,
    metaOutput.exports,
    env
  );

  return taskRunner;
}

async function startTaskRunner(
  dir: string,
  sourcePath: string,
  config: ResolvedConfig,
  path: string,
  fileContents: string,
  sourceMapContents: string,
  exports: string[],
  env: Record<string, string>
) {
  // Create a file at join(dir, ".trigger", path) with the fileContents
  const fullPath = join(dir, ".trigger", `${basename(path, extname(path))}.mjs`);
  await fs.promises.mkdir(dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, fileContents);
  const sourceMapPath = `${fullPath}.map`;
  await fs.promises.writeFile(sourceMapPath, sourceMapContents);

  const taskRunner = new TaskRunner(sourcePath, fullPath, exports, env);
  await taskRunner.start();
  return taskRunner;
}

class TaskRunner {
  child: undefined | ReturnType<typeof fork>;
  tasks: undefined | Array<TaskMetadata>;

  constructor(
    public sourcePath: string,
    public path: string,
    private exports: string[],
    private env: Record<string, string>
  ) {}

  async start() {
    const v3DevServerPath = importResolve("./task-runner.js", import.meta.url);

    const modulePath = new URL(v3DevServerPath).href.replace("file://", "");

    await new Promise<void>((resolve) => {
      this.child = fork(modulePath, {
        stdio: "inherit",
        env: {
          ...this.env,
        },
      });

      this.child.on("message", (msg: any) => {
        if (msg && typeof msg === "object") {
          if (msg.serverReady) {
            this.child?.send({
              entryPoint: {
                path: this.path,
                exports: this.exports,
              },
            });
          } else if (msg.tasksReady && !this.tasks) {
            this.tasks = msg.tasks;
            resolve();
          }
        }
      });

      this.child.on("exit", (code) => {
        console.log(`Child exited with code ${code}`);
      });
    });
  }
}

async function buildEntryPoints(entryPoints: EntryPoint[]) {
  return await build({
    bundle: true,
    metafile: true,
    write: false,
    minify: false,
    sourcemap: true,
    platform: "node",
    format: "esm",
    target: ["node18", "es2020"],
    outdir: "out",
    entryPoints: entryPoints.map((entry) => ({ out: entry.out, in: entry.in })),
  });
}

// Find all the top-level .js or .ts files in the trigger directories
async function gatherEntryPoints(config: ResolvedConfig): Promise<Array<EntryPoint>> {
  const entryPoints: Array<EntryPoint> = [];

  for (const triggerDir of config.triggerDirectories) {
    const entries = await fs.promises.readdir(triggerDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".js") && !entry.name.endsWith(".ts")) continue;

      const fullPath = join(triggerDir, entry.name);
      entryPoints.push({ triggerDir, in: fullPath, out: basename(fullPath, extname(fullPath)) });
    }
  }

  return entryPoints;
}

async function loadConfig(dir: string): Promise<ResolvedConfig> {
  let configFileName = "next.config.js";

  const path = await findUp(CONFIG_FILES, { cwd: dir });

  if (!path) {
    throw new Error("No config file found.");
  }

  configFileName = basename(path);

  try {
    // import the config file
    const userConfigModule = await import(pathToFileURL(path).href);
    const rawConfig = await normalizeConfig(userConfigModule ? userConfigModule.default : {});
    const config = ConfigSchema.parse(rawConfig);

    return resolveConfig(path, config);
  } catch (error) {
    console.error(`Failed to load ${configFileName}`);
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
