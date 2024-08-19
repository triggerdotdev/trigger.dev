import { intro, outro } from "@clack/prompts";
import { CORE_VERSION } from "@trigger.dev/core/v3";
import { DEFAULT_RUNTIME, ResolvedConfig } from "@trigger.dev/core/v3/build";
import { BuildManifest, InitializeDeploymentResponseBody } from "@trigger.dev/core/v3/schemas";
import { Command, Option as CommandOption } from "commander";
import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { readPackageJSON, writePackageJSON } from "pkg-types";
import { z } from "zod";
import { CliApiClient } from "../apiClient.js";
import { bundleWorker } from "../build/bundle.js";
import {
  createBuildContext,
  notifyExtensionOnBuildComplete,
  notifyExtensionOnBuildStart,
  resolvePluginsForContext,
} from "../build/extensions.js";
import { createExternalsBuildExtension } from "../build/externals.js";
import {
  deployEntryPoint,
  deployIndexerEntryPoint,
  telemetryEntryPoint,
} from "../build/packageModules.js";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  SkipLoggingError,
  wrapCommandAction,
} from "../cli/common.js";
import { loadConfig } from "../config.js";
import { buildImage, generateContainerfile } from "../deploy/buildImage.js";
import {
  checkLogsForErrors,
  checkLogsForWarnings,
  printErrors,
  printWarnings,
  saveLogs,
} from "../deploy/logs.js";
import { buildManifestToJSON } from "../utilities/buildManifest.js";
import { chalkError, cliLink } from "../utilities/cliOutput.js";
import { writeJSONFile } from "../utilities/fileSystem.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { getProjectClient } from "../utilities/session.js";
import { resolveFileSources } from "../utilities/sourceFiles.js";
import { getTmpDir } from "../utilities/tempDirectories.js";
import { spinner } from "../utilities/windows.js";
import { VERSION } from "../version.js";
import { login } from "./login.js";
import { updateTriggerPackages } from "./update.js";
import { loadDotEnvVars, resolveDotEnvVars } from "../utilities/dotEnv.js";

const DeployCommandOptions = CommonCommandOptions.extend({
  dryRun: z.boolean().default(false),
  skipSyncEnvVars: z.boolean().default(false),
  env: z.enum(["prod", "staging"]),
  loadImage: z.boolean().default(false),
  buildPlatform: z.enum(["linux/amd64", "linux/arm64"]).default("linux/amd64"),
  selfHosted: z.boolean().default(false),
  registry: z.string().optional(),
  push: z.boolean().default(false),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  apiUrl: z.string().optional(),
  saveLogs: z.boolean().default(false),
  skipUpdateCheck: z.boolean().default(false),
  noCache: z.boolean().default(false),
});

type DeployCommandOptions = z.infer<typeof DeployCommandOptions>;

type Deployment = InitializeDeploymentResponseBody;

export function configureDeployCommand(program: Command) {
  return commonOptions(
    program
      .command("deploy")
      .description("Deploy your Trigger.dev v3 project to the cloud.")
      .argument("[path]", "The path to the project", ".")
      .option(
        "-e, --env <env>",
        "Deploy to a specific environment (currently only prod and staging are supported)",
        "prod"
      )
      .option("--skip-update-check", "Skip checking for @trigger.dev package updates")
      .option("-c, --config <config file>", "The name of the config file, found at [path]")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file. This will override the project specified in the config file."
      )
      .option(
        "--dry-run",
        "Do a dry run of the deployment. This will not actually deploy the project, but will show you what would be deployed."
      )
      .option(
        "--skip-sync-env-vars",
        "Skip syncing environment variables when using the syncEnvVars extension."
      )
  )
    .addOption(
      new CommandOption(
        "--self-hosted",
        "Build and load the image using your local Docker. Use the --registry option to specify the registry to push the image to when using --self-hosted, or just use --push to push to the default registry."
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--no-cache",
        "Do not use the cache when building the image. This will slow down the build process but can be useful if you are experiencing issues with the cache."
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--push",
        "When using the --self-hosted flag, push the image to the default registry. (defaults to false when not using --registry)"
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--registry <registry>",
        "The registry to push the image to when using --self-hosted"
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--tag <tag>",
        "(Coming soon) Specify the tag to use when pushing the image to the registry"
      ).hideHelp()
    )
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
    .addOption(
      new CommandOption(
        "--save-logs",
        "If provided, will save logs even for successful builds"
      ).hideHelp()
    )
    .action(async (path, options) => {
      await handleTelemetry(async () => {
        await printStandloneInitialBanner(true);
        await deployCommand(path, options);
      });
    });
}

export async function deployCommand(dir: string, options: unknown) {
  return await wrapCommandAction("deployCommand", DeployCommandOptions, options, async (opts) => {
    return await _deployCommand(dir, opts);
  });
}

async function _deployCommand(dir: string, options: DeployCommandOptions) {
  intro("Deploying project");

  if (!options.skipUpdateCheck) {
    await updateTriggerPackages(dir, { ...options }, true, true);
  }

  const projectPath = resolve(process.cwd(), dir);

  const authorization = await login({
    embedded: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
  });

  if (!authorization.ok) {
    if (authorization.error === "fetch failed") {
      throw new Error(
        `Failed to connect to ${authorization.auth?.apiUrl}. Are you sure it's the correct URL?`
      );
    } else {
      throw new Error(
        `You must login first. Use the \`login\` CLI command.\n\n${authorization.error}`
      );
    }
  }

  const resolvedConfig = await loadConfig({
    cwd: projectPath,
    overrides: { project: options.projectRef },
  });

  logger.debug("Resolved config", resolvedConfig);

  const projectClient = await getProjectClient({
    accessToken: authorization.auth.accessToken,
    apiUrl: authorization.auth.apiUrl,
    projectRef: resolvedConfig.project,
    env: options.env,
    profile: options.profile,
  });

  if (!projectClient) {
    throw new Error("Failed to get project client");
  }

  const serverEnvVars = await projectClient.client.getEnvironmentVariables(resolvedConfig.project);
  loadDotEnvVars(resolvedConfig.workingDir);

  const destination = getTmpDir(resolvedConfig.workingDir, "build", options.dryRun);
  const externalsExtension = createExternalsBuildExtension("deploy", resolvedConfig);
  const buildContext = createBuildContext("deploy", resolvedConfig);
  buildContext.prependExtension(externalsExtension);
  await notifyExtensionOnBuildStart(buildContext);
  const pluginsFromExtensions = resolvePluginsForContext(buildContext);

  const $buildSpinner = spinner();
  $buildSpinner.start("Building project");

  const bundleResult = await bundleWorker({
    target: "deploy",
    cwd: resolvedConfig.workingDir,
    destination: destination.path,
    watch: false,
    resolvedConfig,
    plugins: [...pluginsFromExtensions],
    jsxFactory: resolvedConfig.build.jsx.factory,
    jsxFragment: resolvedConfig.build.jsx.fragment,
    jsxAutomatic: resolvedConfig.build.jsx.automatic,
  });

  $buildSpinner.stop("Successfully built project");

  logger.debug("Bundle result", bundleResult);

  let buildManifest: BuildManifest = {
    contentHash: bundleResult.contentHash,
    runtime: resolvedConfig.runtime ?? DEFAULT_RUNTIME,
    environment: options.env,
    packageVersion: CORE_VERSION,
    cliPackageVersion: VERSION,
    target: "deploy",
    files: bundleResult.files,
    sources: await resolveFileSources(bundleResult.files, resolvedConfig.workingDir),
    config: {
      project: resolvedConfig.project,
      dirs: resolvedConfig.dirs,
    },
    outputPath: destination.path,
    workerEntryPoint: bundleResult.workerEntryPoint ?? deployEntryPoint,
    indexerEntryPoint: bundleResult.indexerEntryPoint ?? deployIndexerEntryPoint,
    loaderEntryPoint: bundleResult.loaderEntryPoint ?? telemetryEntryPoint,
    configPath: bundleResult.configPath,
    deploy: {
      env: serverEnvVars.success ? serverEnvVars.data.variables : {},
    },
    build: {},
  };

  buildManifest = await notifyExtensionOnBuildComplete(buildContext, buildManifest);
  buildManifest = rewriteBuildManifestPaths(buildManifest, destination.path);

  await writeProjectFiles(buildManifest, resolvedConfig, destination.path);

  logger.debug("Successfully built project to", destination.path);

  if (options.dryRun) {
    logger.info(`Dry run complete. View the built project at ${destination.path}`);
    return;
  }

  const deploymentResponse = await projectClient.client.initializeDeployment({
    contentHash: buildManifest.contentHash,
    userId: authorization.userId,
  });

  if (!deploymentResponse.success) {
    throw new Error(`Failed to start deployment: ${deploymentResponse.error}`);
  }

  const deployment = deploymentResponse.data;

  // If the deployment doesn't have any externalBuildData, then we can't use the remote image builder
  // TODO: handle this and allow the user to the build and push the image themselves
  if (!deployment.externalBuildData && !options.selfHosted) {
    throw new Error(
      `Failed to start deployment, as your instance of trigger.dev does not support hosting. To deploy this project, you must use the --self-hosted flag to build and push the image yourself.`
    );
  }

  if (
    buildManifest.deploy.sync &&
    buildManifest.deploy.sync.env &&
    Object.keys(buildManifest.deploy.sync.env).length > 0
  ) {
    const numberOfEnvVars = Object.keys(buildManifest.deploy.sync.env).length;
    const vars = numberOfEnvVars === 1 ? "var" : "vars";

    if (!options.skipSyncEnvVars) {
      const $spinner = spinner();
      $spinner.start(`Syncing ${numberOfEnvVars} env ${vars} with the server`);
      const success = await syncEnvVarsWithServer(
        projectClient.client,
        resolvedConfig.project,
        options.env,
        buildManifest.deploy.sync.env
      );

      if (!success) {
        await failDeploy(
          projectClient.client,
          deployment,
          {
            name: "SyncEnvVarsError",
            message: `Failed to sync ${numberOfEnvVars} env ${vars} with the server`,
          },
          "",
          $spinner
        );
      } else {
        $spinner.stop(`Successfully synced ${numberOfEnvVars} env ${vars} with the server`);
      }
    } else {
      logger.log(
        "Skipping syncing env vars. The environment variables in your project have changed, but the --skip-sync-env-vars flag was provided."
      );
    }
  }

  const version = deployment.version;

  const deploymentLink = cliLink(
    "View deployment",
    `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/deployments/${deployment.shortCode}`
  );

  const testLink = cliLink(
    "Test tasks",
    `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/test?environment=${
      options.env === "prod" ? "prod" : "stg"
    }`
  );

  const $spinner = spinner();

  $spinner.start(`Deploying version ${version} ${deploymentLink}`);

  const selfHostedRegistryHost = deployment.registryHost ?? options.registry;
  const registryHost = selfHostedRegistryHost ?? "registry.trigger.dev";

  const buildResult = await buildImage({
    selfHosted: options.selfHosted,
    buildPlatform: options.buildPlatform,
    noCache: options.noCache,
    push: options.push,
    registryHost,
    registry: options.registry,
    deploymentId: deployment.id,
    deploymentVersion: deployment.version,
    imageTag: deployment.imageTag,
    loadImage: options.loadImage,
    contentHash: deployment.contentHash,
    externalBuildId: deployment.externalBuildData?.buildId,
    externalBuildToken: deployment.externalBuildData?.buildToken,
    externalBuildProjectId: deployment.externalBuildData?.projectId,
    projectId: projectClient.id,
    projectRef: resolvedConfig.project,
    apiUrl: projectClient.client.apiURL,
    apiKey: projectClient.client.accessToken!,
    authAccessToken: authorization.auth.accessToken,
    compilationPath: destination.path,
  });

  logger.debug("Build result", buildResult);

  const warnings = checkLogsForWarnings(buildResult.logs);

  if (!warnings.ok) {
    await failDeploy(
      projectClient.client,
      deployment,
      { name: "BuildError", message: warnings.summary },
      buildResult.logs,
      $spinner,
      warnings.warnings,
      warnings.errors
    );

    throw new SkipLoggingError("Failed to build image");
  }

  if (!buildResult.ok) {
    await failDeploy(
      projectClient.client,
      deployment,
      { name: "BuildError", message: buildResult.error },
      buildResult.logs,
      $spinner,
      warnings.warnings
    );

    throw new SkipLoggingError("Failed to build image");
  }

  const getDeploymentResponse = await projectClient.client.getDeployment(deployment.id);

  if (!getDeploymentResponse.success) {
    await failDeploy(
      projectClient.client,
      deployment,
      { name: "DeploymentError", message: getDeploymentResponse.error },
      buildResult.logs,
      $spinner
    );

    throw new SkipLoggingError("Failed to get deployment with worker");
  }

  const deploymentWithWorker = getDeploymentResponse.data;

  if (!deploymentWithWorker.worker) {
    await failDeploy(
      projectClient.client,
      deployment,
      { name: "DeploymentError", message: "Failed to get deployment with worker" },
      buildResult.logs,
      $spinner
    );

    throw new SkipLoggingError("Failed to get deployment with worker");
  }

  const imageReference = options.selfHosted
    ? `${selfHostedRegistryHost ? `${selfHostedRegistryHost}/` : ""}${buildResult.image}${
        buildResult.digest ? `@${buildResult.digest}` : ""
      }`
    : `${registryHost}/${buildResult.image}${buildResult.digest ? `@${buildResult.digest}` : ""}`;

  const finalizeResponse = await projectClient.client.finalizeDeployment(deployment.id, {
    imageReference,
    selfHosted: options.selfHosted,
  });

  if (!finalizeResponse.success) {
    await failDeploy(
      projectClient.client,
      deployment,
      { name: "FinalizeError", message: finalizeResponse.error },
      buildResult.logs,
      $spinner
    );

    throw new SkipLoggingError("Failed to finalize deployment");
  }

  $spinner.stop(`Successfully deployed version ${version}`);

  const taskCount = deploymentWithWorker.worker?.tasks.length ?? 0;

  outro(
    `Version ${version} deployed with ${taskCount} detected task${
      taskCount === 1 ? "" : "s"
    } | ${deploymentLink} | ${testLink}`
  );
}

function rewriteBuildManifestPaths(
  buildManifest: BuildManifest,
  destinationDir: string
): BuildManifest {
  return {
    ...buildManifest,
    files: buildManifest.files.map((file) => ({
      ...file,
      entry: cleanEntryPath(file.entry),
      out: rewriteOutputPath(destinationDir, file.out),
    })),
    outputPath: rewriteOutputPath(destinationDir, buildManifest.outputPath),
    configPath: rewriteOutputPath(destinationDir, buildManifest.configPath),
    workerEntryPoint: rewriteOutputPath(destinationDir, buildManifest.workerEntryPoint),
    indexerEntryPoint: rewriteOutputPath(destinationDir, buildManifest.indexerEntryPoint),
    loaderEntryPoint: buildManifest.loaderEntryPoint
      ? rewriteOutputPath(destinationDir, buildManifest.loaderEntryPoint)
      : undefined,
  };
}

async function writeProjectFiles(
  buildManifest: BuildManifest,
  resolvedConfig: ResolvedConfig,
  outputPath: string
) {
  // Step 1. Read the package.json file
  const packageJson = await readProjectPackageJson(resolvedConfig.packageJsonPath);

  if (!packageJson) {
    throw new Error("Could not read the package.json file");
  }

  const dependencies =
    buildManifest.externals?.reduce(
      (acc, external) => {
        acc[external.name] = external.version;

        return acc;
      },
      {} as Record<string, string>
    ) ?? {};

  // Step 3: Write the resolved dependencies to the package.json file
  await writePackageJSON(join(outputPath, "package.json"), {
    ...packageJson,
    name: packageJson.name ?? "trigger-project",
    dependencies: {
      ...dependencies,
    },
    devDependencies: {},
    peerDependencies: {},
    scripts: {},
  });

  await writeJSONFile(join(outputPath, "build.json"), buildManifestToJSON(buildManifest));
  await writeContainerfile(outputPath, buildManifest);
}

async function readProjectPackageJson(packageJsonPath: string) {
  const packageJson = await readPackageJSON(packageJsonPath);

  return packageJson;
}

// Remove any query parameters from the entry path
// For example, src/trigger/ai.ts?sentryProxyModule=true -> src/trigger/ai.ts
function cleanEntryPath(entry: string): string {
  return entry.split("?")[0]!;
}

function rewriteOutputPath(destinationDir: string, filePath: string) {
  return `/app/${relative(destinationDir, filePath)}`;
}

async function writeContainerfile(outputPath: string, buildManifest: BuildManifest) {
  const containerfile = await generateContainerfile(buildManifest);

  await writeFile(join(outputPath, "Containerfile"), containerfile);
}

export async function syncEnvVarsWithServer(
  apiClient: CliApiClient,
  projectRef: string,
  environmentSlug: string,
  envVars: Record<string, string>
) {
  const uploadResult = await apiClient.importEnvVars(projectRef, environmentSlug, {
    variables: envVars,
    override: true,
  });

  return uploadResult.success;
}

async function failDeploy(
  client: CliApiClient,
  deployment: Deployment,
  error: { name: string; message: string },
  logs: string,
  $spinner: ReturnType<typeof spinner>,
  warnings?: string[],
  errors?: string[]
) {
  $spinner.stop(`Failed to deploy project`);

  // If there are logs, let's write it out to a temporary file and include the path in the error message
  if (logs.trim() !== "") {
    const logPath = await saveLogs(deployment.shortCode, logs);

    printWarnings(warnings);
    printErrors(errors);

    checkLogsForErrors(logs);

    outro(
      `${chalkError("Error:")} ${error.message}. Full build logs have been saved to ${logPath}`
    );
  } else {
    outro(`${chalkError("Error:")} ${error.message}.`);
  }

  await client.failDeployment(deployment.id, {
    error,
  });

  throw new SkipLoggingError(`Failed to deploy: ${error.message}`);
}
