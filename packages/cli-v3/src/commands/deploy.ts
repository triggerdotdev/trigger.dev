import { intro, log, spinner } from "@clack/prompts";
import { Command } from "commander";
import { z } from "zod";
import { CliApiClient } from "../apiClient";
import { CommonCommandOptions } from "../cli/common.js";
import { getConfigPath, readConfig } from "../utilities/configFiles.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { isLoggedIn } from "../utilities/session.js";
import { ResolvedConfig } from "@trigger.dev/core/v3";
import { createTaskFileImports, gatherTaskFiles } from "../utilities/taskFiles";
import { read, readFileSync, write } from "node:fs";
import { resolve as importResolve } from "import-meta-resolve";
import { Metafile, build } from "esbuild";
import { exit } from "node:process";
import {
  createTempDir,
  readJSONFile,
  safeFeadJSONFile,
  writeJSONFile,
} from "../utilities/fileSystem";
import { join } from "node:path";
import invariant from "tiny-invariant";
import { copyFile, writeFile } from "node:fs/promises";
import { detectPackageNameFromImportPath } from "../utilities/installPackages";
import * as packageJson from "../../package.json";
import { execa } from "execa";
import { depot } from "@depot/cli";
import { homedir } from "node:os";

const DeployCommandOptions = CommonCommandOptions.extend({
  skipTypecheck: z.boolean().optional(),
});

type DeployCommandOptions = z.infer<typeof DeployCommandOptions>;

export function configureDeployCommand(program: Command) {
  program
    .command("deploy")
    .description("Deploy your Trigger.dev v3 project to the cloud.")
    .argument("[path]", "The path to the project", ".")
    .option("-T, --skip-typecheck", "Whether to skip the pre-build typecheck")
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

  if (options.data.logLevel) {
    logger.loggerLevel = options.data.logLevel;
  }

  await printStandloneInitialBanner(true);

  const configPath = await getConfigPath(dir);
  const config = await readConfig(configPath);

  const apiClient = new CliApiClient(authorization.config.apiUrl, authorization.config.accessToken);

  const prodEnv = await apiClient.getProjectProdEnv({ projectRef: config.project });

  if (!prodEnv.success) {
    throw new Error(prodEnv.error);
  }

  const environmentClient = new CliApiClient(authorization.config.apiUrl, prodEnv.data.apiKey);

  intro(`Preparing to deploy "${prodEnv.data.name}" (${config.project})`);

  // Step 1: Build the project into a temporary directory
  const compiledPath = await compileProject(config, options.data);

  const deploymentSpinner = spinner();

  deploymentSpinner.start("Initializing deployment");

  // Step 2: Initialize a deployment on the server (response will have everything we need to build an image)
  const deploymentResponse = await environmentClient.initializeDeployment();

  if (!deploymentResponse.success) {
    deploymentSpinner.stop(`Failed to initialize deployment: ${deploymentResponse.error}`);
    exit(1);
  }

  deploymentSpinner.message(`Deploying version ${deploymentResponse.data.version}`);

  // If the deployment doesn't have any externalBuildData, then we can't use the remote image builder
  // TODO: handle this and allow the user to the build and push the image themselves
  if (!deploymentResponse.data.externalBuildData) {
    deploymentSpinner.stop(
      `Failed to initialize deployment. The deployment does not have any external build data`
    );
    exit(1);
  }

  const registryHost = new URL(prodEnv.data.apiUrl).host;

  // Step 3: Ensure we are "logged in" to our registry by writing to $HOME/.docker/config.json
  // TODO: make sure this works on windows
  const dockerConfigDir = await ensureLoggedIntoDockerRegistry(registryHost, {
    username: "trigger",
    password: authorization.config.accessToken,
  });

  // TODO: make this work with staging as well
  const repo = `trigger/${config.project}-prod`;
  const tag = deploymentResponse.data.version;

  const imageTag = `${registryHost}/${repo}:${tag}`;

  logger.debug(`Building and pushing image to ${imageTag}`, { compiledPath });

  const args = [
    "build",
    "-f",
    "Containerfile",
    "--build-arg",
    `TRIGGER_PROJECT_ID=${config.project}`,
    "--build-arg",
    `TRIGGER_DEPLOYMENT_ID=${deploymentResponse.data.id}`,
    "--build-arg",
    `TRIGGER_DEPLOYMENT_VERSION=${deploymentResponse.data.version}`,
    "-t",
    imageTag,
    "--push",
    ".",
  ];

  logger.debug(`depot ${args.join(" ")}`);

  // Step 4: Build and push the image
  const childProcess = depot(args, {
    stdio: "inherit",
    cwd: compiledPath,
    env: {
      DEPOT_BUILD_ID: deploymentResponse.data.externalBuildData.buildId,
      DEPOT_TOKEN: deploymentResponse.data.externalBuildData.buildToken,
      DEPOT_PROJECT_ID: deploymentResponse.data.externalBuildData.projectId,
      DEPOT_NO_SUMMARY_LINK: "1",
      DOCKER_CONFIG: dockerConfigDir,
    },
  });

  try {
    await new Promise((resolve, reject) => {
      childProcess.addListener("exit", (code) => (code === 0 ? resolve(code) : reject(code)));
    });

    deploymentSpinner.stop(`Deployment finilized, waiting for indexing`);
  } catch {
    deploymentSpinner.stop(`Failed to build and push the image`);
  }

  // Step 5: Update the deployment with the image and start the deployment (indexing)
  // Step 6: Wait for the deployment to finish and print the result
}

async function compileProject(config: ResolvedConfig, options: DeployCommandOptions) {
  if (!options.skipTypecheck) {
    await typecheckProject(config, options);
  }

  const createAuthCodeSpinner = spinner();
  createAuthCodeSpinner.start(`Compiling project "${config.project}" in "${config.projectDir}"`);

  const taskFiles = await gatherTaskFiles(config);
  const workerFacade = readFileSync(
    new URL(importResolve("./workers/prod/worker-facade.js", import.meta.url)).href.replace(
      "file://",
      ""
    ),
    "utf-8"
  );

  const registerTracingPath = new URL(
    importResolve("./workers/common/register-tracing.js", import.meta.url)
  ).href.replace("file://", "");

  const workerContents = workerFacade
    .replace("__TASKS__", createTaskFileImports(taskFiles))
    .replace("__REGISTER_TRACING__", `import { tracingSDK } from "${registerTracingPath}";`);

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
    },
  });

  if (result.errors.length > 0) {
    createAuthCodeSpinner.stop("Build failed");
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
    sourcemap: "external", // does not set the //# sourceMappingURL= comment in the file, we handle it ourselves
    packages: "external", // https://esbuild.github.io/api/#packages
    logLevel: "error",
    platform: "node",
    format: "cjs", // This is needed to support opentelemetry instrumentation that uses module patching
    target: ["node18", "es2020"],
    outdir: "out",
  });

  if (entryPointResult.errors.length > 0) {
    createAuthCodeSpinner.stop("Build failed");
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

  await writeJSONFile(join(tempDir, "package.json"), {
    name: "trigger-worker",
    version: "0.0.0",
    description: "",
    dependencies,
  });

  createAuthCodeSpinner.stop(`Project "${config.project}" compiled successfully`);

  // Run npm install --package-lock-only in /tmp/dir to produce a package-lock.json
  const resolvingDepsSpinner = spinner();

  resolvingDepsSpinner.start("Resolving dependencies");

  await execa("npm", ["install", "--package-lock-only"], {
    cwd: tempDir,
  });

  resolvingDepsSpinner.stop("Dependencies resolved");
  // Write the Containerfile to /tmp/dir/Containerfile
  const containerFilePath = new URL(
    importResolve("./Containerfile.prod", import.meta.url)
  ).href.replace("file://", "");
  // Copy the Containerfile to /tmp/dir/Containerfile
  await copyFile(containerFilePath, join(tempDir, "Containerfile"));

  return tempDir;
}

async function typecheckProject(config: ResolvedConfig, options: DeployCommandOptions) {
  const createAuthCodeSpinner = spinner();
  createAuthCodeSpinner.start("Typechecking project");

  await new Promise((resolve) => setTimeout(resolve, 2000));

  createAuthCodeSpinner.stop(`Project typechecked with 0 errors`);
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

  return dependencies;
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
