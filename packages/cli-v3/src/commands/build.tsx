import chalk from "chalk";
import { Command } from "commander";
import { build } from "esbuild";
import { execa } from "execa";
import { findUp } from "find-up";
import { resolve as importResolve } from "import-meta-resolve";
import { createHash } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ApiClient } from "../apiClient.js";
import { CLOUD_API_URL } from "../consts.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { RequireKeys } from "../utilities/requiredKeys.js";
import { isLoggedIn } from "../utilities/session.js";
import { CommonCommandOptions } from "../cli/common.js";

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

const BuildCommandOptions = CommonCommandOptions.extend({
  registry: z.string(),
  repo: z.string(),
});

type BuildCommandOptions = z.infer<typeof BuildCommandOptions>;

export function configureBuildCommand(program: Command) {
  program
    .command("build")
    .description("Build your Trigger.dev tasks locally")
    .argument("[path]", "The path to the project", ".")
    .requiredOption("-r, --repo <repo_name>", "The repo to push images to")
    .option("-rr, --registry <registry_address>", "The registry to push images to", "docker.io")
    .option(
      "-l, --log-level <level>",
      "The log level to use (debug, info, log, warn, error, none)",
      "log"
    )
    .action(async (path, options) => {
      try {
        await buildCommand(path, options);
      } catch (e) {
        //todo error reporting
        throw e;
      }
    });
}

export async function buildCommand(dir: string, anyOptions: unknown) {
  const options = BuildCommandOptions.safeParse(anyOptions);

  if (!options.success) {
    throw new Error(`Invalid options: ${options.error}`);
  }

  const authorization = await isLoggedIn();

  if (!authorization.ok) {
    if (authorization.error === "fetch failed") {
      logger.error("Fetch failed. Platform down?");
    } else {
      logger.error("You must login first. Use `trigger.dev login` to login.");
    }
    process.exitCode = 1;
    return;
  }

  await startBuild(dir, options.data, authorization.config);
}

async function startBuild(
  dir: string,
  options: BuildCommandOptions,
  authorization: { apiUrl: string; accessToken: string }
) {
  try {
    if (options.logLevel) {
      logger.loggerLevel = options.logLevel;
    }

    await printStandloneInitialBanner(true);

    const configPath = await getConfigPath(dir);
    const config = await readConfig(configPath);

    const apiClient = new ApiClient(authorization.apiUrl, authorization.accessToken);

    const devEnv = await apiClient.getProjectDevEnv({ projectRef: config.project });

    if (!devEnv.success) {
      throw new Error(devEnv.error);
    }

    const buildResult = await runBuild(config, options);

    const envClient = new ApiClient(authorization.apiUrl, devEnv.data.apiKey);
    await envClient.createImageDetails(config.project, {
      metadata: {
        contentHash: buildResult.contentHash,
        imageTag: buildResult.imageTag,
      },
    });
  } catch (e) {
    throw e;
  }
}

async function runBuild(config: ResolvedConfig, options: BuildCommandOptions) {
  const taskFiles = await gatherTaskFiles(config);

  const workerFacade = readFileSync(
    new URL(importResolve("./worker-facade.js", import.meta.url)).href.replace("file://", ""),
    "utf-8"
  );
  const entryPointContents = workerFacade.replace("__TASKS__", createTaskFileImports(taskFiles));

  logger.log(chalk.dim("⎔ Bundling tasks..."));

  const result = await build({
    stdin: {
      contents: entryPointContents,
      resolveDir: process.cwd(),
      sourcefile: "__entryPoint.ts",
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
    banner: {
      js: "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
    },
  });

  if (result.errors.length > 0) {
    logger.error(result.errors);
    throw new Error("Build failed");
  }
  if (!result || !result.outputFiles) {
    throw new Error("Build failed: no result");
  }

  const metaOutputKey = join("out", `stdin.js`);

  const metaOutput = result.metafile!.outputs[metaOutputKey];

  if (!metaOutput) {
    throw new Error(`Could not find metafile`);
  }

  const outputFileKey = join(config.projectDir, metaOutputKey);
  const outputFile = result.outputFiles.find((file) => file.path === outputFileKey);

  if (!outputFile) {
    throw new Error(`Could not find output file for entry point ${metaOutput.entryPoint}`);
  }

  const sourceMapFileKey = join(config.projectDir, `${metaOutputKey}.map`);
  const sourceMapFile = result.outputFiles.find((file) => file.path === sourceMapFileKey);

  if (!sourceMapFile) {
    throw new Error(`Could not find source map file for entry point ${metaOutput.entryPoint}`);
  }

  const md5Hasher = createHash("md5");
  md5Hasher.update(Buffer.from(outputFile.contents.buffer));

  const contentHash = md5Hasher.digest("hex");

  // Create a file at join(dir, ".trigger", path) with the fileContents
  const fullPath = join(config.projectDir, ".trigger", `${contentHash}.mjs`);

  await fs.promises.mkdir(dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, outputFile.text);
  const sourceMapPath = `${fullPath}.map`;
  await fs.promises.writeFile(sourceMapPath, sourceMapFile.text);

  logger.log(chalk.green(`Bundling finished.\n`));

  logger.log(chalk.dim("⎔ Checking repo login..."));

  const registryWithRepo = `${options.registry}/${options.repo}`;

  const dockerLogin = execa("docker", ["login", registryWithRepo]);

  dockerLogin.stdout?.on("data", (chunk) => logger.debug(chunk.toString()));
  dockerLogin.stderr?.on("data", (chunk) => logger.debug(chunk.toString()));

  try {
    await new Promise((resolve, reject) => {
      dockerLogin.addListener("exit", (code) => (code === 0 ? resolve(code) : reject(code)));
    });
  } catch (error) {
    throw new Error("Login failed. Please run `docker login` to authenticate.");
  }

  logger.log(chalk.green(`Login succeeded.\n`));

  logger.log(chalk.dim("⎔ Starting docker build..."));

  const containerfileContents = `FROM alpine`;
  const containerfilePath = join(config.projectDir, ".trigger", "Containerfile");
  const imageTag = `${registryWithRepo}:${contentHash}`;

  await fs.promises.writeFile(containerfilePath, containerfileContents);

  const dockerBuild = execa("docker", [
    "build",
    "-f",
    containerfilePath,
    "-t",
    imageTag,
    join(config.projectDir, ".trigger"),
  ]);
  dockerBuild.stdout?.pipe(process.stdout);
  dockerBuild.stderr?.pipe(process.stderr);

  try {
    await new Promise((resolve, reject) => {
      dockerBuild.addListener("exit", (code) => (code === 0 ? resolve(code) : reject(code)));
    });
  } catch (error) {
    throw new Error("Build failed.");
  }

  logger.log(chalk.green(`Build finished.\n`));

  logger.log(chalk.dim("⎔ Pushing image..."));

  await fs.promises.writeFile(containerfilePath, containerfileContents);

  const dockerPush = execa("docker", ["push", imageTag]);
  dockerPush.stdout?.pipe(process.stdout);
  dockerPush.stderr?.pipe(process.stderr);

  try {
    await new Promise((resolve, reject) => {
      dockerPush.addListener("exit", (code) => (code === 0 ? resolve(code) : reject(code)));
    });
  } catch (error) {
    throw new Error("Push failed.");
  }

  logger.log(chalk.green(`Push complete.\n`));

  return {
    contentHash,
    imageTag,
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
