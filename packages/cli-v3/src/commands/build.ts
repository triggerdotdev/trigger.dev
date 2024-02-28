import chalk from "chalk";
import { Command } from "commander";
import { build } from "esbuild";
import { execa } from "execa";
import { resolve as importResolve } from "import-meta-resolve";
import { createHash } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as packageJson from "../../package.json";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { isLoggedIn } from "../utilities/session.js";
import { CommonCommandOptions } from "../cli/common.js";
import { getConfigPath, readConfig } from "../utilities/configFiles.js";
import { createTaskFileImports, gatherTaskFiles } from "../utilities/taskFiles.js";
import { CliApiClient, ResolvedConfig } from "@trigger.dev/core/v3";

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
    .option("-rr, --registry <registry_address>", "The registry to push images to", "")
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

    const apiClient = new CliApiClient(authorization.apiUrl, authorization.accessToken);

    const prodEnv = await apiClient.getProjectProdEnv({ projectRef: config.project });

    if (!prodEnv.success) {
      throw new Error(prodEnv.error);
    }

    const buildResult = await runBuild(config, options, {
      apiUrl: authorization.apiUrl,
      apiKey: prodEnv.data.apiKey,
    });

    const envClient = new CliApiClient(authorization.apiUrl, prodEnv.data.apiKey);
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

async function runBuild(
  config: ResolvedConfig,
  options: BuildCommandOptions,
  auth: { apiUrl: string; apiKey: string }
) {
  const taskFiles = await gatherTaskFiles(config);

  const prodFacade = readFileSync(
    new URL(importResolve("./prod-facade.js", import.meta.url)).href.replace("file://", ""),
    "utf-8"
  );
  const entryPointContents = prodFacade.replace("__TASKS__", createTaskFileImports(taskFiles));

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
    logLevel: "warning",
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
  const buildContextPath = join(config.projectDir, ".trigger");

  try {
    // Clean build context dir first
    await fs.promises.rm(buildContextPath, { recursive: true, force: true });
  } catch (err) {
  } finally {
    // ..then ensure it exists
    await fs.promises.mkdir(buildContextPath, { recursive: true });
  }

  // Create a file at join(dir, ".trigger", path) with the fileContents
  const fullPath = join(buildContextPath, `${contentHash}.mjs`);
  await fs.promises.writeFile(fullPath, outputFile.text);
  const sourceMapPath = `${fullPath}.map`;
  await fs.promises.writeFile(sourceMapPath, sourceMapFile.text);

  const prodWorkerPath = new URL(importResolve("./prod-worker.mjs", import.meta.url)).href.replace(
    "file://",
    ""
  );
  await fs.promises.copyFile(prodWorkerPath, join(buildContextPath, "index.mjs"));

  logger.log(chalk.green(`Bundling finished.\n`));

  let localOnly = false;

  if (!options.registry) {
    logger.log(chalk.yellow(`No registry specified, enabling local only mode.\n`));
    localOnly = true;
  }

  const registryWithRepo = localOnly ? options.repo : `${options.registry}/${options.repo}`;

  if (!localOnly) {
    logger.log(chalk.dim("⎔ Checking repo login..."));

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
  }

  logger.log(chalk.dim("⎔ Starting docker build..."));

  const containerfile = await fs.promises.readFile(
    new URL(importResolve("./Containerfile.prod", import.meta.url)).href.replace("file://", ""),
    "utf-8"
  );

  const containerfileContents = containerfile
    .replace("__API_URL__", auth.apiUrl)
    .replace("__API_KEY__", auth.apiKey)
    .replace("__CONTENT_HASH__", contentHash)
    .replace("__PROJECT_DIR__", config.projectDir)
    .replace("__PROJECT_REF__", config.project)
    .replace("__CLI_PACKAGE_VERSION__", packageJson.version);

  const containerfilePath = join(buildContextPath, "Containerfile");
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

  if (!localOnly) {
    logger.log(chalk.dim("⎔ Pushing image..."));

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
  }

  return {
    contentHash,
    imageTag,
  };
}
