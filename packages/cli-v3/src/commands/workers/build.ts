import { intro, outro, log } from "@clack/prompts";
import { parseDockerImageReference, prepareDeploymentError } from "@trigger.dev/core/v3";
import { InitializeDeploymentResponseBody } from "@trigger.dev/core/v3/schemas";
import { Command, Option as CommandOption } from "commander";
import { resolve } from "node:path";
import { z } from "zod";
import { CliApiClient } from "../../apiClient.js";
import { buildWorker } from "../../build/buildWorker.js";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  SkipLoggingError,
  wrapCommandAction,
} from "../../cli/common.js";
import { loadConfig } from "../../config.js";
import { buildImage } from "../../deploy/buildImage.js";
import {
  checkLogsForErrors,
  checkLogsForWarnings,
  printErrors,
  printWarnings,
  saveLogs,
} from "../../deploy/logs.js";
import { chalkError, cliLink, isLinksSupported, prettyError } from "../../utilities/cliOutput.js";
import { loadDotEnvVars } from "../../utilities/dotEnv.js";
import { printStandloneInitialBanner } from "../../utilities/initialBanner.js";
import { logger } from "../../utilities/logger.js";
import { getProjectClient } from "../../utilities/session.js";
import { getTmpDir } from "../../utilities/tempDirectories.js";
import { spinner } from "../../utilities/windows.js";
import { login } from "../login.js";
import { updateTriggerPackages } from "../update.js";
import { resolveAlwaysExternal } from "../../build/externals.js";

const WorkersBuildCommandOptions = CommonCommandOptions.extend({
  // docker build options
  load: z.boolean().default(false),
  platform: z.enum(["linux/amd64", "linux/arm64"]).default("linux/amd64"),
  network: z.enum(["default", "none", "host"]).optional(),
  tag: z.string().optional(),
  push: z.boolean().default(false),
  noCache: z.boolean().default(false),
  // trigger options
  local: z.boolean().default(false), // TODO: default to true when webapp has no remote build support
  dryRun: z.boolean().default(false),
  skipSyncEnvVars: z.boolean().default(false),
  env: z.enum(["prod", "staging"]),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  apiUrl: z.string().optional(),
  saveLogs: z.boolean().default(false),
  skipUpdateCheck: z.boolean().default(false),
  envFile: z.string().optional(),
});

type WorkersBuildCommandOptions = z.infer<typeof WorkersBuildCommandOptions>;

type Deployment = InitializeDeploymentResponseBody;

export function configureWorkersBuildCommand(program: Command) {
  return commonOptions(
    program
      .command("build")
      .description("Build a self-hosted worker image")
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
        "--skip-sync-env-vars",
        "Skip syncing environment variables when using the syncEnvVars extension."
      )
      .option(
        "--env-file <env file>",
        "Path to the .env file to load into the CLI process. Defaults to .env in the project directory."
      )
  )
    .addOption(
      new CommandOption(
        "--dry-run",
        "This will only create the build context without actually building the image. This can be useful for debugging."
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--no-cache",
        "Do not use any build cache. This will significantly slow down the build process but can be useful to fix caching issues."
      ).hideHelp()
    )
    .option("--local", "Force building the image locally.")
    .option("--push", "Push the image to the configured registry.")
    .option(
      "-t, --tag <tag>",
      "Specify the full name of the resulting image with an optional tag. The tag will always be overridden for remote builds."
    )
    .option("--load", "Load the built image into your local docker")
    .option(
      "--network <mode>",
      "The networking mode for RUN instructions when using --local",
      "host"
    )
    .option(
      "--platform <platform>",
      "The platform to build the deployment image for",
      "linux/amd64"
    )
    .option("--save-logs", "If provided, will save logs even for successful builds")
    .action(async (path, options) => {
      await handleTelemetry(async () => {
        await printStandloneInitialBanner(true);
        await workersBuildCommand(path, options);
      });
    });
}

async function workersBuildCommand(dir: string, options: unknown) {
  return await wrapCommandAction(
    "workerBuildCommand",
    WorkersBuildCommandOptions,
    options,
    async (opts) => {
      return await _workerBuildCommand(dir, opts);
    }
  );
}

async function _workerBuildCommand(dir: string, options: WorkersBuildCommandOptions) {
  intro("Building worker image");

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
    configFile: options.config,
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
  loadDotEnvVars(resolvedConfig.workingDir, options.envFile);

  const destination = getTmpDir(resolvedConfig.workingDir, "build", options.dryRun);

  const $buildSpinner = spinner();

  const forcedExternals = await resolveAlwaysExternal(projectClient.client);

  const buildManifest = await buildWorker({
    target: "unmanaged",
    environment: options.env,
    destination: destination.path,
    resolvedConfig,
    rewritePaths: true,
    envVars: serverEnvVars.success ? serverEnvVars.data.variables : {},
    forcedExternals,
    listener: {
      onBundleStart() {
        $buildSpinner.start("Building project");
      },
      onBundleComplete(result) {
        $buildSpinner.stop("Successfully built project");

        logger.debug("Bundle result", result);
      },
    },
  });

  logger.debug("Successfully built project to", destination.path);

  if (options.dryRun) {
    logger.info(`Dry run complete. View the built project at ${destination.path}`);
    return;
  }

  const tagParts = parseDockerImageReference(options.tag ?? "");

  // Account for empty strings to preserve existing behavior
  const registry = tagParts.registry ? tagParts.registry : undefined;
  const namespace = tagParts.repo ? tagParts.repo : undefined;

  const deploymentResponse = await projectClient.client.initializeDeployment({
    contentHash: buildManifest.contentHash,
    userId: authorization.userId,
    selfHosted: options.local,
    registryHost: registry,
    namespace: namespace,
    type: "UNMANAGED",
  });

  if (!deploymentResponse.success) {
    throw new Error(`Failed to start deployment: ${deploymentResponse.error}`);
  }

  const deployment = deploymentResponse.data;

  let local = options.local;

  // If the deployment doesn't have any externalBuildData, then we can't use the remote image builder
  if (!deployment.externalBuildData && !options.local) {
    log.warn(
      "This webapp instance does not support remote builds, falling back to local build. Please use the `--local` flag to skip this warning."
    );
    local = true;
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

  if (isLinksSupported) {
    $spinner.start(`Building worker version ${version} ${deploymentLink}`);
  } else {
    $spinner.start(`Building worker version ${version}`);
  }

  const buildResult = await buildImage({
    selfHosted: local,
    buildPlatform: options.platform,
    noCache: options.noCache,
    push: options.push,
    registryHost: registry,
    registry: registry,
    deploymentId: deployment.id,
    deploymentVersion: deployment.version,
    imageTag: deployment.imageTag,
    loadImage: options.load,
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
    buildEnvVars: buildManifest.build.env,
    network: options.network,
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

  // Index the deployment
  // const runtime = new UnmanagedWorkerRuntime({
  //   name: projectClient.name,
  //   config: resolvedConfig,
  //   args: {
  //     ...options,
  //     debugOtel: false,
  //   },
  //   client: projectClient.client,
  //   dashboardUrl: authorization.dashboardUrl,
  // });
  // await runtime.init();

  // console.log("buildManifest", buildManifest);

  // await runtime.initializeWorker(buildManifest);

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

  $spinner.stop(`Successfully built worker version ${version}`);

  const taskCount = deploymentWithWorker.worker?.tasks.length ?? 0;

  log.message(`Detected ${taskCount} task${taskCount === 1 ? "" : "s"}`);

  if (taskCount > 0) {
    logger.table(
      deploymentWithWorker.worker.tasks.map((task) => ({
        id: task.slug,
        export: task.exportName ?? "@deprecated",
        path: task.filePath,
      }))
    );
  }

  outro(
    `Version ${version} built and ready to deploy: ${buildResult.image} ${
      isLinksSupported ? `| ${deploymentLink} | ${testLink}` : ""
    }`
  );
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

  const doOutputLogs = async (prefix: string = "Error") => {
    if (logs.trim() !== "") {
      const logPath = await saveLogs(deployment.shortCode, logs);

      printWarnings(warnings);
      printErrors(errors);

      checkLogsForErrors(logs);

      outro(
        `${chalkError(`${prefix}:`)} ${
          error.message
        }. Full build logs have been saved to ${logPath}`
      );
    } else {
      outro(`${chalkError(`${prefix}:`)} ${error.message}.`);
    }
  };

  const exitCommand = (message: string) => {
    throw new SkipLoggingError(message);
  };

  const deploymentResponse = await client.getDeployment(deployment.id);

  if (!deploymentResponse.success) {
    logger.debug(`Failed to get deployment with worker: ${deploymentResponse.error}`);
  } else {
    const serverDeployment = deploymentResponse.data;

    switch (serverDeployment.status) {
      case "PENDING":
      case "DEPLOYING":
      case "BUILDING": {
        await doOutputLogs();

        await client.failDeployment(deployment.id, {
          error,
        });

        exitCommand("Failed to deploy project");

        break;
      }
      case "CANCELED": {
        await doOutputLogs("Canceled");

        exitCommand("Failed to deploy project");

        break;
      }
      case "FAILED": {
        const errorData = serverDeployment.errorData
          ? prepareDeploymentError(serverDeployment.errorData)
          : undefined;

        if (errorData) {
          prettyError(errorData.name, errorData.stack, errorData.stderr);

          if (logs.trim() !== "") {
            const logPath = await saveLogs(deployment.shortCode, logs);

            outro(`Aborting deployment. Full build logs have been saved to ${logPath}`);
          } else {
            outro(`Aborting deployment`);
          }
        } else {
          await doOutputLogs("Failed");
        }

        exitCommand("Failed to deploy project");

        break;
      }
      case "DEPLOYED": {
        await doOutputLogs("Deployed with errors");

        exitCommand("Deployed with errors");

        break;
      }
      case "TIMED_OUT": {
        await doOutputLogs("TimedOut");

        exitCommand("Timed out");

        break;
      }
    }
  }
}
