import { intro, spinner } from "@clack/prompts";
import { depot } from "@depot/cli";
import { ResolvedConfig } from "@trigger.dev/core/v3";
import chalk from "chalk";
import { Command, Option as CommandOption } from "commander";
import { Metafile, build } from "esbuild";
import { execa } from "execa";
import { resolve as importResolve } from "import-meta-resolve";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exit } from "node:process";
import { setTimeout } from "node:timers/promises";
import terminalLink from "terminal-link";
import invariant from "tiny-invariant";
import { z } from "zod";
import * as packageJson from "../../package.json";
import { CliApiClient } from "../apiClient";
import { CommonCommandOptions } from "../cli/common.js";
import { readConfig } from "../utilities/configFiles.js";
import { createTempDir, readJSONFile, writeJSONFile } from "../utilities/fileSystem";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { detectPackageNameFromImportPath } from "../utilities/installPackages";
import { logger } from "../utilities/logger.js";
import { isLoggedIn } from "../utilities/session.js";
import { createTaskFileImports, gatherTaskFiles } from "../utilities/taskFiles";

const DeployCommandOptions = CommonCommandOptions.extend({
  skipTypecheck: z.boolean().default(false),
  skipDeploy: z.boolean().default(false),
  env: z.enum(["prod", "staging"]),
  loadImage: z.boolean().default(false),
  buildPlatform: z.enum(["linux/amd64", "linux/arm64"]).default("linux/amd64"),
  selfHosted: z.boolean().default(false),
  registry: z.string().optional(),
  pushImage: z.boolean().default(false),
  config: z.string().optional(),
  projectRef: z.string().optional(),
});

type DeployCommandOptions = z.infer<typeof DeployCommandOptions>;

export function configureDeployCommand(program: Command) {
  program
    .command("deploy")
    .description("Deploy your Trigger.dev v3 project to the cloud.")
    .argument("[path]", "The path to the project", ".")
    .option(
      "-e, --env <env>",
      "Deploy to a specific environment (currently only prod and staging are supported)",
      "prod"
    )
    .option("-T, --skip-typecheck", "Whether to skip the pre-build typecheck")
    .option(
      "-c, --config <config file>",
      "The name of the config file, found at [path]",
      "trigger.config.mjs"
    )
    .option(
      "-p, --project-ref <project ref>",
      "The project ref. Required if there is no config file."
    )
    .addOption(
      new CommandOption(
        "--self-hosted",
        "Build and load the image using your local Docker. Use the --registry option to specify the registry to push the image to when using --self-hosted, or just use --push-image to push to the default registry."
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--push-image",
        "(Coming soon) When using the --self-hosted flag, push the image to the default registry. (defaults to false when not using --registry)"
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--registry <registry>",
        "(Coming soon) The registry to push the image to when using --self-hosted"
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--tag <tag>",
        "(Coming soon) Specify the tag to use when pushing the image to the registry"
      ).hideHelp()
    )
    .addOption(new CommandOption("-D, --skip-deploy", "Skip deploying the image").hideHelp())
    .addOption(
      new CommandOption("--load-image", "Load the built image into your local docker").hideHelp()
    )
    .addOption(
      new CommandOption(
        "--build-platform <platform>",
        "The platform to build the deployment image for"
      )
        .default("linux/amd64")
        .hideHelp()
    )
    .option(
      "-l, --log-level <level>",
      "The log level to use (debug, info, log, warn, error, none)",
      "log"
    )
    .action(async (path, options) => {
      try {
        await deployCommand(path, options);
      } catch (e) {
        //todo error reporting
        throw e;
      }
    });
}

export async function deployCommand(dir: string, anyOptions: unknown) {
  const options = DeployCommandOptions.safeParse(anyOptions);

  if (!options.success) {
    throw new Error(`Invalid options: ${options.error}`);
  }

  if (options.data.logLevel) {
    logger.loggerLevel = options.data.logLevel;
  }

  logger.debug("Running the deploy command with the following options", {
    options: options.data,
    dir,
  });

  const authorization = await isLoggedIn();

  if (!authorization.ok) {
    if (authorization.error === "fetch failed") {
      logger.error(
        `Failed to connect to ${authorization.config?.apiUrl}. Are you sure it's the correct URL?`
      );
    } else {
      logger.error("You must login first. Use `trigger.dev login` to login.");
    }
    process.exitCode = 1;
    return;
  }

  await printStandloneInitialBanner(true);

  const resolvedConfig = await readConfig(dir, {
    configFile: options.data.config,
    projectRef: options.data.projectRef,
  });

  logger.debug("Resolved config", { resolvedConfig });

  const apiClient = new CliApiClient(authorization.config.apiUrl, authorization.config.accessToken);

  const deploymentEnv = await apiClient.getProjectEnv({
    projectRef: resolvedConfig.config.project,
    env: options.data.env,
  });

  if (!deploymentEnv.success) {
    throw new Error(deploymentEnv.error);
  }

  const environmentClient = new CliApiClient(
    authorization.config.apiUrl,
    deploymentEnv.data.apiKey
  );

  intro(
    `Preparing to deploy "${deploymentEnv.data.name}" (${resolvedConfig.config.project}) to ${options.data.env}`
  );

  // Step 1: Build the project into a temporary directory
  const compilation = await compileProject(
    resolvedConfig.config,
    options.data,
    resolvedConfig.status === "file" ? resolvedConfig.path : undefined
  );

  logger.debug("Compilation result", { compilation });

  const environmentVariablesSpinner = spinner();

  environmentVariablesSpinner.start("Checking environment variables");

  const environmentVariables = await environmentClient.getEnvironmentVariables(
    resolvedConfig.config.project
  );

  if (!environmentVariables.success) {
    environmentVariablesSpinner.stop(`Failed to fetch environment variables, skipping check`);
  } else {
    // Check to see if all the environment variables in the compilation exist
    const missingEnvironmentVariables = compilation.envVars.filter(
      (envVar) => environmentVariables.data.variables[envVar] === undefined
    );

    if (missingEnvironmentVariables.length > 0) {
      environmentVariablesSpinner.stop(
        `Found missing env vars in ${options.data.env}: ${arrayToSentence(
          missingEnvironmentVariables
        )}. Aborting deployment. ${chalk.bgBlueBright(
          terminalLink(
            "Manage env vars",
            `${authorization.config.apiUrl}/projects/v3/${resolvedConfig.config.project}/environment-variables`
          )
        )}`
      );
      exit(1);
    }

    environmentVariablesSpinner.stop(`Environment variable check passed`);
  }

  // Step 2: Initialize a deployment on the server (response will have everything we need to build an image)
  const deploymentResponse = await environmentClient.initializeDeployment({
    contentHash: compilation.contentHash,
    userId: authorization.userId,
  });

  if (!deploymentResponse.success) {
    logger.error(`Failed to start deployment: ${deploymentResponse.error}`);
    exit(1);
  }

  // If the deployment doesn't have any externalBuildData, then we can't use the remote image builder
  // TODO: handle this and allow the user to the build and push the image themselves
  if (!deploymentResponse.data.externalBuildData && !options.data.selfHosted) {
    logger.error(
      `Failed to start deployment, as your instance of trigger.dev does not support hosting. To deploy this project, you must use the --self-hosted flag to build and push the image yourself.`
    );
    exit(1);
  }

  const version = deploymentResponse.data.version;

  const deploymentSpinner = spinner();

  deploymentSpinner.start(`Deploying version ${version}`);
  const registryHost = new URL(deploymentEnv.data.apiUrl).host;

  const buildImage = async () => {
    if (options.data.selfHosted) {
      return buildAndPushSelfHostedImage({
        imageTag: deploymentResponse.data.imageTag,
        cwd: compilation.path,
        projectId: resolvedConfig.config.project,
        deploymentId: deploymentResponse.data.id,
        deploymentVersion: version,
        contentHash: deploymentResponse.data.contentHash,
        projectRef: resolvedConfig.config.project,
        buildPlatform: options.data.buildPlatform,
      });
    }

    if (!deploymentResponse.data.externalBuildData) {
      deploymentSpinner.stop(
        `Failed to initialize deployment. The deployment does not have any external build data. To deploy this project, you must use the --self-hosted flag to build and push the image yourself.`
      );
      exit(1);
    }

    return buildAndPushImage({
      registryHost,
      auth: authorization.config.accessToken,
      imageTag: deploymentResponse.data.imageTag,
      buildId: deploymentResponse.data.externalBuildData.buildId,
      buildToken: deploymentResponse.data.externalBuildData.buildToken,
      buildProjectId: deploymentResponse.data.externalBuildData.projectId,
      cwd: compilation.path,
      projectId: resolvedConfig.config.project,
      deploymentId: deploymentResponse.data.id,
      deploymentVersion: deploymentResponse.data.version,
      contentHash: deploymentResponse.data.contentHash,
      projectRef: resolvedConfig.config.project,
      loadImage: options.data.loadImage,
      buildPlatform: options.data.buildPlatform,
    });
  };

  const image = await buildImage();

  if (!image.ok) {
    deploymentSpinner.stop(`Failed to build project image: ${image.error}`);
    exit(1);
  }

  const imageReference = options.data.selfHosted
    ? `${image.image}${image.digest ? `@${image.digest}` : ""}`
    : `${registryHost}/${image.image}${image.digest ? `@${image.digest}` : ""}`;

  if (options.data.skipDeploy) {
    deploymentSpinner.stop(
      `Project image built: ${imageReference}. Skipping deployment as requested`
    );
    exit(0);
  }

  deploymentSpinner.message(
    `${deploymentResponse.data.version} image built, detecting deployed tasks`
  );

  logger.debug(`Start indexing image ${imageReference}`);

  const startIndexingResponse = await environmentClient.startDeploymentIndexing(
    deploymentResponse.data.id,
    {
      imageReference,
    }
  );

  if (!startIndexingResponse.success) {
    deploymentSpinner.stop(`Failed to start indexing: ${startIndexingResponse.error}`);
    exit(1);
  }

  const finishedDeployment = await waitForDeploymentToFinish(
    deploymentResponse.data.id,
    environmentClient
  );

  if (!finishedDeployment) {
    deploymentSpinner.stop(`Deployment failed to complete`);
    exit(1);
  }

  const deploymentLink = terminalLink(
    "View deployment",
    `${authorization.config.apiUrl}/projects/v3/${resolvedConfig.config.project}/deployments/${finishedDeployment.id}`
  );

  switch (finishedDeployment.status) {
    case "DEPLOYED": {
      const taskCount = finishedDeployment.worker?.tasks.length ?? 0;

      if (taskCount === 0) {
        deploymentSpinner.stop(
          `Deployment of ${version} completed with no detected tasks. Please make sure you are exporting tasks in your project. ${deploymentLink}`
        );
      } else {
        deploymentSpinner.stop(
          `Deployment of ${version} completed with ${taskCount} detected task${
            taskCount === 1 ? "" : "s"
          } ${deploymentLink}`
        );
      }

      break;
    }
    case "FAILED": {
      if (finishedDeployment.errorData) {
        deploymentSpinner.stop(
          `Deployment encountered an error: ${finishedDeployment.errorData.name}. ${deploymentLink}`
        );
        logger.error(finishedDeployment.errorData.stack);
      } else {
        deploymentSpinner.stop(
          `Deployment failed with an unknown error. Please contact eric@trigger.dev for help. ${deploymentLink}`
        );
      }

      exit(1);
    }
    case "CANCELED": {
      deploymentSpinner.stop(`Deployment was canceled. ${deploymentLink}`);
      break;
    }
  }
}

// Poll every 1 second for the deployment to finish
async function waitForDeploymentToFinish(
  deploymentId: string,
  client: CliApiClient,
  timeoutInSeconds: number = 60
) {
  const start = Date.now();

  while (true) {
    if (Date.now() - start > timeoutInSeconds * 1000) {
      return;
    }

    const deployment = await client.getDeployment(deploymentId);

    if (!deployment.success) {
      throw new Error(deployment.error);
    }

    logger.debug(`Deployment status: ${deployment.data.status}`);

    if (
      deployment.data.status === "DEPLOYED" ||
      deployment.data.status === "FAILED" ||
      deployment.data.status === "CANCELED"
    ) {
      return deployment.data;
    }

    await setTimeout(1000);
  }
}

type BuildAndPushImageOptions = {
  registryHost: string;
  auth: string;
  imageTag: string;
  buildId: string;
  buildToken: string;
  buildProjectId: string;
  cwd: string;
  projectId: string;
  deploymentId: string;
  deploymentVersion: string;
  contentHash: string;
  projectRef: string;
  loadImage: boolean;
  buildPlatform: string;
};

type BuildAndPushImageResults =
  | {
      ok: true;
      image: string;
      digest?: string;
    }
  | {
      ok: false;
      error: string;
    };

async function buildAndPushImage(
  options: BuildAndPushImageOptions
): Promise<BuildAndPushImageResults> {
  // Step 3: Ensure we are "logged in" to our registry by writing to $HOME/.docker/config.json
  // TODO: make sure this works on windows
  const dockerConfigDir = await ensureLoggedIntoDockerRegistry(options.registryHost, {
    username: "trigger",
    password: options.auth,
  });

  const args = [
    "build",
    "-f",
    "Containerfile",
    "--platform",
    options.buildPlatform,
    "--provenance",
    "false",
    "--build-arg",
    `TRIGGER_PROJECT_ID=${options.projectId}`,
    "--build-arg",
    `TRIGGER_DEPLOYMENT_ID=${options.deploymentId}`,
    "--build-arg",
    `TRIGGER_DEPLOYMENT_VERSION=${options.deploymentVersion}`,
    "--build-arg",
    `TRIGGER_CONTENT_HASH=${options.contentHash}`,
    "--build-arg",
    `TRIGGER_PROJECT_REF=${options.projectRef}`,
    "-t",
    `${options.registryHost}/${options.imageTag}`,
    ".",
    "--push",
    options.loadImage ? "--load" : undefined,
  ].filter(Boolean) as string[];

  logger.debug(`depot ${args.join(" ")}`);

  // Step 4: Build and push the image
  const childProcess = depot(args, {
    cwd: options.cwd,
    env: {
      DEPOT_BUILD_ID: options.buildId,
      DEPOT_TOKEN: options.buildToken,
      DEPOT_PROJECT_ID: options.buildProjectId,
      DEPOT_NO_SUMMARY_LINK: "1",
      DOCKER_CONFIG: dockerConfigDir,
    },
  });

  const errors: string[] = [];

  try {
    await new Promise<void>((res, rej) => {
      // For some reason everything is output on stderr, not stdout
      childProcess.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();

        errors.push(text);
        logger.debug(text);
      });

      childProcess.on("error", (e) => rej(e));
      childProcess.on("close", () => res());
    });

    const digest = extractImageDigest(errors);

    return {
      ok: true,
      image: options.imageTag,
      digest,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : JSON.stringify(e),
    };
  }
}

type BuildAndPushSelfHostedImageOptions = Omit<
  BuildAndPushImageOptions,
  "registryHost" | "buildId" | "buildToken" | "buildProjectId" | "auth" | "loadImage"
>;

async function buildAndPushSelfHostedImage(
  options: BuildAndPushSelfHostedImageOptions
): Promise<BuildAndPushImageResults> {
  const args = [
    "build",
    "-f",
    "Containerfile",
    "--platform",
    options.buildPlatform,
    "--build-arg",
    `TRIGGER_PROJECT_ID=${options.projectId}`,
    "--build-arg",
    `TRIGGER_DEPLOYMENT_ID=${options.deploymentId}`,
    "--build-arg",
    `TRIGGER_DEPLOYMENT_VERSION=${options.deploymentVersion}`,
    "--build-arg",
    `TRIGGER_CONTENT_HASH=${options.contentHash}`,
    "--build-arg",
    `TRIGGER_PROJECT_REF=${options.projectRef}`,
    "-t",
    `${options.imageTag}`,
    ".", // The build context
  ].filter(Boolean) as string[];

  logger.debug(`docker ${args.join(" ")}`);

  // Step 4: Build and push the image
  const childProcess = execa("docker", args, {
    cwd: options.cwd,
  });

  const errors: string[] = [];

  try {
    await new Promise<void>((res, rej) => {
      // For some reason everything is output on stderr, not stdout
      childProcess.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();

        errors.push(text);
        logger.debug(text);
      });

      childProcess.on("error", (e) => rej(e));
      childProcess.on("close", () => res());
    });

    const digest = extractImageDigest(errors);

    return {
      ok: true,
      image: options.imageTag,
      digest,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : JSON.stringify(e),
    };
  }
}

function extractImageDigest(outputs: string[]) {
  const imageDigestRegex = /sha256:[a-f0-9]{64}/;

  for (const line of outputs) {
    if (line.includes("pushing manifest")) {
      const imageDigestMatch = line.match(imageDigestRegex);
      if (imageDigestMatch) {
        return imageDigestMatch[0];
      }
    }
  }
}

async function compileProject(
  config: ResolvedConfig,
  options: DeployCommandOptions,
  configPath?: string
) {
  if (!options.skipTypecheck) {
    await typecheckProject(config, options);
  }

  const compileSpinner = spinner();
  compileSpinner.start(`Building project in ${config.projectDir}`);

  const taskFiles = await gatherTaskFiles(config);
  const workerFacade = readFileSync(
    new URL(importResolve("./workers/prod/worker-facade.js", import.meta.url)).href.replace(
      "file://",
      ""
    ),
    "utf-8"
  );

  const workerSetupPath = new URL(
    importResolve("./workers/prod/worker-setup.js", import.meta.url)
  ).href.replace("file://", "");

  let workerContents = workerFacade
    .replace("__TASKS__", createTaskFileImports(taskFiles))
    .replace("__WORKER_SETUP__", `import { tracingSDK } from "${workerSetupPath}";`);

  if (configPath) {
    logger.debug("Importing project config from", { configPath });

    workerContents = workerContents.replace(
      "__IMPORTED_PROJECT_CONFIG__",
      `import importedConfig from "${configPath}";`
    );
  } else {
    workerContents = workerContents.replace(
      "__IMPORTED_PROJECT_CONFIG__",
      `const importedConfig = undefined;`
    );
  }

  const result = await build({
    stdin: {
      contents: workerContents,
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
  });

  if (result.errors.length > 0) {
    compileSpinner.stop("Build failed, aborting deployment");
    exit(1);
  }

  const entryPointContents = readFileSync(
    new URL(importResolve("./workers/prod/entry-point.js", import.meta.url)).href.replace(
      "file://",
      ""
    ),
    "utf-8"
  );

  const entryPointResult = await build({
    stdin: {
      contents: entryPointContents,
      resolveDir: process.cwd(),
      sourcefile: "index.ts",
    },
    bundle: true,
    metafile: true,
    write: false,
    minify: false,
    sourcemap: false,
    packages: "external", // https://esbuild.github.io/api/#packages
    logLevel: "error",
    platform: "node",
    format: "cjs", // This is needed to support opentelemetry instrumentation that uses module patching
    target: ["node18", "es2020"],
    outdir: "out",
    define: {
      __PROJECT_CONFIG__: JSON.stringify(config),
    },
  });

  if (entryPointResult.errors.length > 0) {
    compileSpinner.stop("Build failed, aborting deployment");
    exit(1);
  }

  // Create a tmp directory to store the build
  const tempDir = await createTempDir();

  logger.debug(`Writing compiled files to ${tempDir}`);

  // Get the metaOutput for the result build
  const metaOutput = result.metafile!.outputs[join("out", "stdin.js")];

  invariant(metaOutput, "Meta output for the result build is missing");

  // Get the metaOutput for the entryPoint build
  const entryPointMetaOutput = entryPointResult.metafile!.outputs[join("out", "stdin.js")];

  invariant(entryPointMetaOutput, "Meta output for the entryPoint build is missing");

  // Get the outputFile and the sourceMapFile for the result build
  const workerOutputFile = result.outputFiles.find(
    (file) => file.path === join(config.projectDir, "out", "stdin.js")
  );

  invariant(workerOutputFile, "Output file for the result build is missing");

  const workerSourcemapFile = result.outputFiles.find(
    (file) => file.path === join(config.projectDir, "out", "stdin.js.map")
  );

  invariant(workerSourcemapFile, "Sourcemap file for the result build is missing");

  // Get the outputFile for the entryPoint build

  const entryPointOutputFile = entryPointResult.outputFiles.find(
    (file) => file.path === join(config.projectDir, "out", "stdin.js")
  );

  invariant(entryPointOutputFile, "Output file for the entryPoint build is missing");

  // Save the result outputFile to /tmp/dir/worker.js (and make sure to map the sourceMap to the correct location in the file)
  await writeFile(
    join(tempDir, "worker.js"),
    `${workerOutputFile.text}\n//# sourceMappingURL=worker.js.map`
  );
  // Save the sourceMapFile to /tmp/dir/worker.js.map
  await writeFile(join(tempDir, "worker.js.map"), workerSourcemapFile.text);
  // Save the entryPoint outputFile to /tmp/dir/index.js
  await writeFile(join(tempDir, "index.js"), entryPointOutputFile.text);

  // Get all the required dependencies from the metaOutputs and save them to /tmp/dir/package.json
  const allImports = [...metaOutput.imports, ...entryPointMetaOutput.imports];
  const projectPackageJson = await readJSONFile(join(config.projectDir, "package.json"));
  const dependencies = gatherRequiredDependencies(allImports, projectPackageJson);

  const packageJsonContents = {
    name: "trigger-worker",
    version: "0.0.0",
    description: "",
    dependencies,
  };

  await writeJSONFile(join(tempDir, "package.json"), packageJsonContents);

  compileSpinner.stop("Project built successfully");

  // Run npm install --package-lock-only in /tmp/dir to produce a package-lock.json
  const resolvingDepsSpinner = spinner();

  resolvingDepsSpinner.start("Resolving dependencies");

  await resolveDependencies(tempDir, packageJsonContents, config, options);

  resolvingDepsSpinner.stop("Dependencies resolved");
  // Write the Containerfile to /tmp/dir/Containerfile
  const containerFilePath = new URL(
    importResolve("./Containerfile.prod", import.meta.url)
  ).href.replace("file://", "");
  // Copy the Containerfile to /tmp/dir/Containerfile
  await copyFile(containerFilePath, join(tempDir, "Containerfile"));

  const contentHasher = createHash("sha256");
  contentHasher.update(Buffer.from(entryPointOutputFile.text));
  contentHasher.update(Buffer.from(workerOutputFile.text));
  contentHasher.update(Buffer.from(JSON.stringify(dependencies)));

  const contentHash = contentHasher.digest("hex");

  const workerSetupEnvVars = await findAllEnvironmentVariableReferencesInFile(workerSetupPath);

  const workerFacadeEnvVars = findAllEnvironmentVariableReferences(workerContents);

  const envVars = findAllEnvironmentVariableReferences(workerOutputFile.text);

  // Remove workerFacadeEnvVars and workerSetupEnvVars from envVars
  const finalEnvVars = envVars.filter(
    (envVar) => !workerFacadeEnvVars.includes(envVar) && !workerSetupEnvVars.includes(envVar)
  );

  return { path: tempDir, contentHash, envVars: finalEnvVars };
}

// Let's first create a digest from the package.json, and then use that digest to lookup a cached package-lock.json
// in the `.trigger/cache` directory. If the package-lock.json is found, we'll write it to the project directory
// If the package-lock.json is not found, we will run `npm install --package-lock-only` and then write the package-lock.json
// to the project directory, and finally we'll write the digest to the `.trigger/cache` directory with the contents of the package-lock.json
async function resolveDependencies(
  projectDir: string,
  packageJsonContents: any,
  config: ResolvedConfig,
  options: DeployCommandOptions
) {
  const hasher = createHash("sha256");
  hasher.update(JSON.stringify(packageJsonContents));
  const digest = hasher.digest("hex").slice(0, 16);

  const cacheDir = join(config.projectDir, ".trigger", "cache");
  const cachePath = join(cacheDir, `${digest}.json`);

  try {
    const cachedPackageLock = await readFile(cachePath, "utf-8");

    logger.debug(`Using cached package-lock.json for ${digest}`);

    await writeFile(join(projectDir, "package-lock.json"), cachedPackageLock);

    return;
  } catch (e) {
    // If the file doesn't exist, we'll continue to the next step
    if (e instanceof Error && "code" in e && e.code !== "ENOENT") {
      throw e;
    }

    logger.debug(`No cached package-lock.json found for ${digest}`);

    await execa("npm", ["install", "--package-lock-only"], {
      cwd: projectDir,
    });

    const packageLockContents = await readFile(join(projectDir, "package-lock.json"), "utf-8");

    logger.debug(`Writing package-lock.json to cache for ${digest}`);

    // Make sure the cache directory exists
    await mkdir(cacheDir, { recursive: true });

    // Save the package-lock.json to the cache
    await writeFile(cachePath, packageLockContents);

    // Write the package-lock.json to the project directory
    await writeFile(join(projectDir, "package-lock.json"), packageLockContents);
  }
}

async function typecheckProject(config: ResolvedConfig, options: DeployCommandOptions) {
  const typecheckSpinner = spinner();
  typecheckSpinner.start("Typechecking project");

  const tscTypecheck = execa("npm", ["exec", "tsc", "--", "--noEmit"], {
    cwd: config.projectDir,
  });

  const stdouts: string[] = [];
  const stderrs: string[] = [];

  tscTypecheck.stdout?.on("data", (chunk) => stdouts.push(chunk.toString()));
  tscTypecheck.stderr?.on("data", (chunk) => stderrs.push(chunk.toString()));

  try {
    await new Promise((resolve, reject) => {
      tscTypecheck.addListener("exit", (code) => (code === 0 ? resolve(code) : reject(code)));
    });
  } catch (error) {
    typecheckSpinner.stop(
      `Typechecking failed, check the logs below to view the issues. To skip typechecking, pass the --skip-typecheck flag`
    );

    logger.log("");

    for (const stdout of stdouts) {
      logger.log(stdout);
    }

    exit(1);
  }

  typecheckSpinner.stop(`Typechecking passed with 0 errors`);
}

// Returns the dependencies that are required by the output that are found in output and the CLI package dependencies
// Returns the dependency names and the version to use (taken from the CLI deps package.json)
function gatherRequiredDependencies(
  imports: Metafile["outputs"][string]["imports"],
  externalPackageJson?: { dependencies: Record<string, string> }
) {
  const dependencies: Record<string, string> = {};

  for (const file of imports) {
    if (file.kind !== "require-call" || !file.external) {
      continue;
    }

    const packageName = detectPackageNameFromImportPath(file.path);

    if (dependencies[packageName]) {
      continue;
    }

    const externalDependencyVersion = (externalPackageJson?.dependencies ?? {})[packageName];

    if (externalDependencyVersion) {
      dependencies[packageName] = externalDependencyVersion;
      continue;
    }

    const internalDependencyVersion = (packageJson.dependencies as Record<string, string>)[
      packageName
    ];

    if (internalDependencyVersion) {
      dependencies[packageName] = internalDependencyVersion;
    }
  }

  // Make sure we sort the dependencies by key to ensure consistent hashing
  return Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));
}

async function ensureLoggedIntoDockerRegistry(
  registryHost: string,
  auth: { username: string; password: string }
) {
  const tmpDir = await createTempDir();
  // Read the current docker config
  const dockerConfigPath = join(tmpDir, "config.json");

  await writeJSONFile(dockerConfigPath, {
    auths: {
      [registryHost]: {
        auth: Buffer.from(`${auth.username}:${auth.password}`).toString("base64"),
      },
    },
  });

  logger.debug(`Writing docker config to ${dockerConfigPath}`);

  return tmpDir;
}

async function findAllEnvironmentVariableReferencesInFile(filePath: string) {
  const fileContents = await readFile(filePath, "utf-8");

  return findAllEnvironmentVariableReferences(fileContents);
}

function findAllEnvironmentVariableReferences(code: string): string[] {
  const regex = /\bprocess\.env\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g;

  const matches = code.matchAll(regex);

  const matchesArray = Array.from(matches, (match) => match[1]).filter(Boolean) as string[];

  // Make sure and remove duplicates
  return Array.from(new Set(matchesArray));
}

function arrayToSentence(items: string[]): string {
  if (items.length === 1 && typeof items[0] === "string") {
    return items[0];
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
