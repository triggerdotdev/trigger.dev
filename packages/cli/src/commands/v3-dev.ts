import { findUp } from "find-up";
import { pathToFileURL } from "node:url";
import { basename, dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import { RequireKeys } from "../utils/requiredKeys";
import fs from "node:fs";
import { CLOUD_API_URL } from "../consts";
import { build } from "esbuild";
import { fork } from "node:child_process";
import { resolve as importResolve } from "import-meta-resolve";
import { TaskMetadata } from "../types";

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

export async function v3DevCommand(dir: string, anyOptions: any) {
  const config = await loadConfig(dir);

  console.log(config);

  const entryPoints = await gatherEntryPoints(config);

  console.log(entryPoints);

  const taskServers = await startTaskServers(config, entryPoints);

  for (const taskServer of taskServers) {
    if (!taskServer.tasks) {
      throw new Error(`Task Server at ${taskServer.path} started without tasks`);
    }

    console.log(`Task Server at ${taskServer.path} started with tasks:`);

    for (const task of taskServer.tasks!) {
      console.log(`  ${task.id} (exported as ${task.exportName})`);
    }
  }
}

async function startTaskServers(config: ResolvedConfig, entryPoints: EntryPoint[]) {
  const bundle = await buildEntryPoints(entryPoints);

  const taskEntryPoints: TaskEntryPoint[] = [];

  for (const entryPoint of entryPoints) {
    taskEntryPoints.push(await loadTaskEntryPoint(config, entryPoint, bundle));
  }

  return taskEntryPoints;
}

async function loadTaskEntryPoint(
  config: ResolvedConfig,
  entryPoint: EntryPoint,
  bundle: EntryPointBundle
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

  const taskServer = await startTaskServer(
    config.projectDir,
    config,
    metaOutputKey,
    outputFile.text,
    sourceMapFile.text,
    metaOutput.exports
  );

  return taskServer;
}

async function startTaskServer(
  dir: string,
  config: ResolvedConfig,
  path: string,
  fileContents: string,
  sourceMapContents: string,
  exports: string[]
) {
  // Create a file at join(dir, ".trigger", path) with the fileContents
  const fullPath = join(dir, ".trigger", `${basename(path, extname(path))}.mjs`);
  await fs.promises.mkdir(dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, fileContents);
  const sourceMapPath = `${fullPath}.map`;
  await fs.promises.writeFile(sourceMapPath, sourceMapContents);

  const taskServer = new TaskEntryPoint(fullPath, exports);
  await taskServer.start();
  return taskServer;
}

class TaskEntryPoint {
  child: undefined | ReturnType<typeof fork>;
  tasks: undefined | Array<TaskMetadata>;

  constructor(
    public path: string,
    private exports: string[]
  ) {}

  async start() {
    const v3DevServerPath = importResolve("./v3-server.js", import.meta.url);

    const modulePath = new URL(v3DevServerPath).href.replace("file://", "");

    await new Promise<void>((resolve) => {
      this.child = fork(modulePath, {
        stdio: "inherit",
        env: {
          TRIGGER_API_URL: "http://localhost:3000",
          TRIGGER_API_KEY: "tr_dev_1234567890",
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
