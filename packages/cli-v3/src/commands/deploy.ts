import { intro, log, outro, taskLog } from "@clack/prompts";
import { getBranch, prepareDeploymentError, tryCatch } from "@trigger.dev/core/v3";
import {
  InitializeDeploymentRequestBody,
  InitializeDeploymentResponseBody,
  DeploymentEvent,
  GitMeta,
  DeploymentFinalizedEvent,
} from "@trigger.dev/core/v3/schemas";
import { Command, Option as CommandOption } from "commander";
import { join, resolve } from "node:path";
import { isCI } from "std-env";
import { x } from "tinyexec";
import { z } from "zod";
import chalk from "chalk";
import { CliApiClient } from "../apiClient.js";
import { buildWorker } from "../build/buildWorker.js";
import { resolveAlwaysExternal } from "../build/externals.js";
import { createContextArchive, getArchiveSize } from "../deploy/archiveContext.js";
import { S2 } from "@s2-dev/streamstore";
import { mkdir, readFile, unlink } from "node:fs/promises";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  OutroCommandError,
  SkipLoggingError,
  wrapCommandAction,
} from "../cli/common.js";
import { loadConfig } from "../config.js";
import { buildImage } from "../deploy/buildImage.js";
import {
  checkLogsForErrors,
  checkLogsForWarnings,
  printErrors,
  printWarnings,
  saveLogs,
} from "../deploy/logs.js";
import {
  chalkError,
  chalkGrey,
  chalkWarning,
  cliLink,
  isLinksSupported,
  prettyError,
  prettyWarning,
} from "../utilities/cliOutput.js";
import { loadDotEnvVars } from "../utilities/dotEnv.js";
import { isDirectory } from "../utilities/fileSystem.js";
import { setGithubActionsOutputAndEnvVars } from "../utilities/githubActions.js";
import { createGitMeta } from "../utilities/gitMeta.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { resolveLocalEnvVars } from "../utilities/localEnvVars.js";
import { logger } from "../utilities/logger.js";
import { getProjectClient, upsertBranch } from "../utilities/session.js";
import { getTmpDir } from "../utilities/tempDirectories.js";
import { spinner } from "../utilities/windows.js";
import { login } from "./login.js";
import { archivePreviewBranch } from "./preview.js";
import { updateTriggerPackages } from "./update.js";

const DeployCommandOptions = CommonCommandOptions.extend({
  dryRun: z.boolean().default(false),
  skipSyncEnvVars: z.boolean().default(false),
  env: z.enum(["prod", "staging", "preview", "production"]),
  branch: z.string().optional(),
  load: z.boolean().optional(),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  saveLogs: z.boolean().default(false),
  skipUpdateCheck: z.boolean().default(false),
  skipPromotion: z.boolean().default(false),
  noCache: z.boolean().default(false),
  envFile: z.string().optional(),
  // Local build options
  forceLocalBuild: z.boolean().optional(),
  useRegistryCache: z.boolean().default(false),
  network: z.enum(["default", "none", "host"]).optional(),
  push: z.boolean().optional(),
  builder: z.string().default("trigger"),
  nativeBuildServer: z.boolean().default(false),
  detach: z.boolean().default(false),
});

type DeployCommandOptions = z.infer<typeof DeployCommandOptions>;

type Deployment = InitializeDeploymentResponseBody;

export function configureDeployCommand(program: Command) {
  return (
    commonOptions(
      program
        .command("deploy")
        .description("Deploy your Trigger.dev project to the cloud.")
        .argument("[path]", "The path to the project", ".")
        .option(
          "-e, --env <env>",
          "Deploy to a specific environment (currently only prod and staging are supported)",
          "prod"
        )
        .option(
          "-b, --branch <branch>",
          "The preview branch to deploy to when passing --env preview. If not provided, we'll detect your git branch."
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
        .option(
          "--env-file <env file>",
          "Path to the .env file to load into the CLI process. Defaults to .env in the project directory."
        )
        .option(
          "--skip-promotion",
          "Skip promoting the deployment to the current deployment for the environment."
        )
    )
      .addOption(
        new CommandOption(
          "--use-registry-cache",
          "Use the registry cache when building the image. The registry must be supported as a cache storage backend."
        ).hideHelp()
      )
      .addOption(
        new CommandOption(
          "--no-cache",
          "Do not use the cache when building the image. This will slow down the build process but can be useful if you are experiencing issues with the cache."
        )
          .conflicts("useRegistryCache")
          .hideHelp()
      )
      .addOption(
        new CommandOption("--load", "Load the built image into your local docker").hideHelp()
      )
      .addOption(
        new CommandOption(
          "--no-load",
          "Do not load the built image into your local docker"
        ).hideHelp()
      )
      .addOption(
        new CommandOption(
          "--save-logs",
          "If provided, will save logs even for successful builds"
        ).hideHelp()
      )
      // Local build options
      .addOption(new CommandOption("--force-local-build", "Force a local build of the image"))
      .addOption(new CommandOption("--push", "Push the image after local builds").hideHelp())
      .addOption(
        new CommandOption("--no-push", "Do not push the image after local builds").hideHelp()
      )
      .addOption(
        new CommandOption(
          "--network <mode>",
          "The networking mode for RUN instructions when building locally"
        ).hideHelp()
      )
      .addOption(
        new CommandOption(
          "--builder <builder>",
          "The builder to use when building locally"
        ).hideHelp()
      )
      .addOption(
        new CommandOption(
          "--native-build-server",
          "Use the native build server for building the image"
        )
      )
      .addOption(
        new CommandOption(
          "--detach",
          "Return immediately after the deployment is queued, do not wait for the build to complete. Implies using the native build server."
        ).implies({ nativeBuildServer: true })
      )
      .action(async (path, options) => {
        await handleTelemetry(async () => {
          await printStandloneInitialBanner(true);
          await deployCommand(path, options);
        });
      })
  );
}

export async function deployCommand(dir: string, options: unknown) {
  return await wrapCommandAction("deployCommand", DeployCommandOptions, options, async (opts) => {
    return await _deployCommand(dir, opts);
  });
}

async function _deployCommand(dir: string, options: DeployCommandOptions) {
  intro(`Deploying project${options.skipPromotion ? " (without promotion)" : ""}`);

  if (!options.skipUpdateCheck) {
    await updateTriggerPackages(dir, { ...options }, true, true);
  }

  const cwd = process.cwd();
  const projectPath = resolve(cwd, dir);

  verifyDirectory(dir, projectPath);

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

  //coerce env from production to prod
  if (options.env === "production") {
    options.env = "prod";
  }

  const envVars = resolveLocalEnvVars(options.envFile);

  if (envVars.TRIGGER_PROJECT_REF) {
    logger.debug("Using project ref from env", { ref: envVars.TRIGGER_PROJECT_REF });
  }

  const resolvedConfig = await loadConfig({
    cwd: projectPath,
    overrides: { project: options.projectRef ?? envVars.TRIGGER_PROJECT_REF },
    configFile: options.config,
  });

  logger.debug("Resolved config", resolvedConfig);

  const gitMeta = await createGitMeta(resolvedConfig.workspaceDir);
  logger.debug("gitMeta", gitMeta);

  const branch =
    options.env === "preview" ? getBranch({ specified: options.branch, gitMeta }) : undefined;

  if (options.env === "preview" && !branch) {
    throw new Error(
      "Didn't auto-detect preview branch, so you need to specify one. Pass --branch <branch>."
    );
  }

  if (options.env === "preview" && branch) {
    //auto-archive a branch if the PR is merged or closed
    if (gitMeta?.pullRequestState === "merged" || gitMeta?.pullRequestState === "closed") {
      log.message(`Pull request ${gitMeta?.pullRequestNumber} is ${gitMeta?.pullRequestState}.`);
      const $buildSpinner = spinner();
      $buildSpinner.start(`Archiving preview branch: "${branch}"`);
      const result = await archivePreviewBranch(authorization, branch, resolvedConfig.project);
      $buildSpinner.stop(
        result ? `Successfully archived "${branch}"` : `Failed to archive "${branch}".`
      );
      return;
    }

    logger.debug("Upserting branch", { env: options.env, branch });
    const branchEnv = await upsertBranch({
      accessToken: authorization.auth.accessToken,
      apiUrl: authorization.auth.apiUrl,
      projectRef: resolvedConfig.project,
      branch,
      gitMeta,
    });

    logger.debug("Upserted branch env", branchEnv);

    log.success(`Using preview branch "${branch}"`);

    if (!branchEnv) {
      throw new Error(`Failed to create branch "${branch}"`);
    }
  }

  const projectClient = await getProjectClient({
    accessToken: authorization.auth.accessToken,
    apiUrl: authorization.auth.apiUrl,
    projectRef: resolvedConfig.project,
    env: options.env,
    branch,
    profile: options.profile,
  });

  if (!projectClient) {
    throw new Error("Failed to get project client");
  }

  if (options.nativeBuildServer) {
    await handleNativeBuildServerDeploy({
      apiClient: projectClient.client,
      config: resolvedConfig,
      dashboardUrl: authorization.dashboardUrl,
      options,
      userId: authorization.auth.tokenType === "personal" ? authorization.userId : undefined,
      gitMeta,
    });
    return;
  }

  const serverEnvVars = await projectClient.client.getEnvironmentVariables(resolvedConfig.project);
  loadDotEnvVars(resolvedConfig.workingDir, options.envFile);

  const destination = getTmpDir(resolvedConfig.workingDir, "build", options.dryRun);

  const $buildSpinner = spinner();

  const forcedExternals = await resolveAlwaysExternal(projectClient.client);

  const { features } = resolvedConfig;

  const [error, buildManifest] = await tryCatch(
    buildWorker({
      target: "deploy",
      environment: options.env,
      branch,
      destination: destination.path,
      resolvedConfig,
      rewritePaths: true,
      envVars: serverEnvVars.success ? serverEnvVars.data.variables : {},
      forcedExternals,
      listener: {
        onBundleStart() {
          $buildSpinner.start("Building trigger code");
        },
        onBundleComplete(result) {
          $buildSpinner.stop("Successfully built code");

          logger.debug("Bundle result", result);
        },
      },
    })
  );

  if (error) {
    $buildSpinner.stop("Failed to build code");
    throw error;
  }

  logger.debug("Successfully built project to", destination.path);

  if (options.dryRun) {
    logger.info(`Dry run complete. View the built project at ${destination.path}`);
    return;
  }

  const deployment = await initializeOrAttachDeployment(
    projectClient.client,
    {
      contentHash: buildManifest.contentHash,
      userId: authorization.auth.tokenType === "personal" ? authorization.userId : undefined,
      gitMeta,
      type: features.run_engine_v2 ? "MANAGED" : "V1",
      runtime: buildManifest.runtime,
      isNativeBuild: false,
    },
    envVars.TRIGGER_EXISTING_DEPLOYMENT_ID
  );
  const isLocalBuild = options.forceLocalBuild || !deployment.externalBuildData;
  // Would be best to actually store this separately in the deployment object. This is an okay proxy for now.
  const remoteBuildExplicitlySkipped = options.forceLocalBuild && !!deployment.externalBuildData;

  // Fail fast if we know local builds will fail
  if (isLocalBuild) {
    const result = await x("docker", ["buildx", "version"]);

    if (result.exitCode !== 0) {
      logger.debug(`"docker buildx version" failed (${result.exitCode}):`, result);
      throw new Error(
        "Failed to find docker buildx. Please install it: https://github.com/docker/buildx#installing."
      );
    }
  }

  const hasVarsToSync =
    Object.keys(buildManifest.deploy.sync?.env || {}).length > 0 ||
    // Only sync parent variables if this is a branch environment
    (branch && Object.keys(buildManifest.deploy.sync?.parentEnv || {}).length > 0);

  if (hasVarsToSync) {
    const childVars = buildManifest.deploy.sync?.env ?? {};
    const parentVars = buildManifest.deploy.sync?.parentEnv ?? {};

    const numberOfEnvVars = Object.keys(childVars).length + Object.keys(parentVars).length;
    const vars = numberOfEnvVars === 1 ? "var" : "vars";

    if (!options.skipSyncEnvVars) {
      const $spinner = spinner();
      $spinner.start(`Syncing ${numberOfEnvVars} env ${vars} with the server`);

      const uploadResult = await syncEnvVarsWithServer(
        projectClient.client,
        resolvedConfig.project,
        options.env,
        childVars,
        parentVars
      );

      if (!uploadResult.success) {
        await failDeploy(
          projectClient.client,
          deployment,
          {
            name: "SyncEnvVarsError",
            message: `Failed to sync ${numberOfEnvVars} env ${vars} with the server: ${uploadResult.error}`,
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

  const rawDeploymentLink = `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/deployments/${deployment.shortCode}`;
  const rawTestLink = `${authorization.dashboardUrl}/projects/v3/${
    resolvedConfig.project
  }/test?environment=${options.env === "prod" ? "prod" : "stg"}`;

  const deploymentLink = cliLink("View deployment", rawDeploymentLink);
  const testLink = cliLink("Test tasks", rawTestLink);

  const $spinner = spinner();

  const buildSuffix =
    isLocalBuild && !process.env.TRIGGER_LOCAL_BUILD_LABEL_DISABLED ? " (local)" : "";
  const deploySuffix =
    isLocalBuild && !process.env.TRIGGER_LOCAL_BUILD_LABEL_DISABLED ? " (local build)" : "";

  if (isCI) {
    log.step(`Building version ${version}\n`);
  } else {
    if (isLinksSupported) {
      $spinner.start(`Building version ${version}${buildSuffix} ${deploymentLink}`);
    } else {
      $spinner.start(`Building version ${version}${buildSuffix}`);
    }
  }

  const buildResult = await buildImage({
    isLocalBuild,
    useRegistryCache: options.useRegistryCache,
    noCache: options.noCache,
    deploymentId: deployment.id,
    deploymentVersion: deployment.version,
    imageTag: deployment.imageTag,
    imagePlatform: deployment.imagePlatform,
    load: options.load,
    contentHash: deployment.contentHash,
    externalBuildId: deployment.externalBuildData?.buildId,
    externalBuildToken: deployment.externalBuildData?.buildToken,
    externalBuildProjectId: deployment.externalBuildData?.projectId,
    projectId: projectClient.id,
    projectRef: resolvedConfig.project,
    apiUrl: projectClient.client.apiURL,
    apiKey: projectClient.client.accessToken!,
    apiClient: projectClient.client,
    branchName: branch,
    authAccessToken: authorization.auth.accessToken,
    compilationPath: destination.path,
    buildEnvVars: buildManifest.build.env,
    onLog: (logMessage) => {
      if (isCI) {
        console.log(logMessage);
        return;
      }

      if (isLinksSupported) {
        $spinner.message(
          `Building version ${version}${buildSuffix} ${deploymentLink}: ${logMessage}`
        );
      } else {
        $spinner.message(`Building version ${version}${buildSuffix}: ${logMessage}`);
      }
    },
    // Local build options
    network: options.network,
    builder: options.builder,
    push: options.push,
    authenticateToRegistry: remoteBuildExplicitlySkipped,
  });

  logger.debug("Build result", buildResult);

  const warnings = checkLogsForWarnings(buildResult.logs);

  const canShowLocalBuildHint = !isLocalBuild && !process.env.TRIGGER_LOCAL_BUILD_HINT_DISABLED;
  const buildFailed = !warnings.ok || !buildResult.ok;

  if (buildFailed && canShowLocalBuildHint) {
    const providerStatus = await projectClient.client.getRemoteBuildProviderStatus();

    if (providerStatus.success && providerStatus.data.status === "degraded") {
      prettyWarning(providerStatus.data.message + "\n");
    }
  }

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

    throw new SkipLoggingError(getDeploymentResponse.error);
  }

  const deploymentWithWorker = getDeploymentResponse.data;

  if (!deploymentWithWorker.worker) {
    const errorData = deploymentWithWorker.errorData
      ? prepareDeploymentError(deploymentWithWorker.errorData)
      : undefined;

    await failDeploy(
      projectClient.client,
      deployment,
      {
        name: "DeploymentError",
        message: errorData?.message ?? "Failed to get deployment with worker",
      },
      buildResult.logs,
      $spinner
    );

    throw new SkipLoggingError(errorData?.message ?? "Failed to get deployment with worker");
  }

  if (isCI) {
    log.step(`Deploying version ${version}${deploySuffix}\n`);
  } else {
    if (isLinksSupported) {
      $spinner.message(`Deploying version ${version}${deploySuffix} ${deploymentLink}`);
    } else {
      $spinner.message(`Deploying version ${version}${deploySuffix}`);
    }
  }

  const finalizeResponse = await projectClient.client.finalizeDeployment(
    deployment.id,
    {
      imageDigest: buildResult.digest,
      skipPromotion: options.skipPromotion,
      skipPushToRegistry: remoteBuildExplicitlySkipped,
    },
    (logMessage) => {
      if (isCI) {
        console.log(logMessage);
        return;
      }

      if (isLinksSupported) {
        $spinner.message(
          `Deploying version ${version}${deploySuffix} ${deploymentLink}: ${logMessage}`
        );
      } else {
        $spinner.message(`Deploying version ${version}${deploySuffix}: ${logMessage}`);
      }
    }
  );

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

  if (isCI) {
    log.step(`Successfully deployed version ${version}${deploySuffix}`);
  } else {
    $spinner.stop(`Successfully deployed version ${version}${deploySuffix}`);
  }

  const taskCount = deploymentWithWorker.worker?.tasks.length ?? 0;

  outro(
    `Version ${version} deployed with ${taskCount} detected task${taskCount === 1 ? "" : "s"} ${
      isLinksSupported ? `| ${deploymentLink} | ${testLink}` : ""
    }`
  );

  if (!isLinksSupported) {
    console.log("View deployment");
    console.log(rawDeploymentLink);
    console.log(); // new line
    console.log("Test tasks");
    console.log(rawTestLink);
  }

  if (options.saveLogs) {
    const logPath = await saveLogs(deployment.shortCode, buildResult.logs);
    console.log(`Full build logs have been saved to ${logPath}`);
  }

  setGithubActionsOutputAndEnvVars({
    envVars: {
      TRIGGER_DEPLOYMENT_VERSION: version,
      TRIGGER_VERSION: version,
      TRIGGER_DEPLOYMENT_SHORT_CODE: deployment.shortCode,
      TRIGGER_DEPLOYMENT_URL: `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/deployments/${deployment.shortCode}`,
      TRIGGER_TEST_URL: `${authorization.dashboardUrl}/projects/v3/${
        resolvedConfig.project
      }/test?environment=${options.env === "prod" ? "prod" : "stg"}`,
    },
    outputs: {
      deploymentVersion: version,
      workerVersion: version,
      deploymentShortCode: deployment.shortCode,
      deploymentUrl: `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/deployments/${deployment.shortCode}`,
      testUrl: `${authorization.dashboardUrl}/projects/v3/${
        resolvedConfig.project
      }/test?environment=${options.env === "prod" ? "prod" : "stg"}`,
      needsPromotion: options.skipPromotion ? "true" : "false",
    },
  });
}

export async function syncEnvVarsWithServer(
  apiClient: CliApiClient,
  projectRef: string,
  environmentSlug: string,
  envVars: Record<string, string>,
  parentEnvVars?: Record<string, string>
) {
  return await apiClient.importEnvVars(projectRef, environmentSlug, {
    variables: envVars,
    parentVariables: parentEnvVars,
    override: true,
  });
}

async function failDeploy(
  client: CliApiClient,
  deployment: Pick<Deployment, "id" | "shortCode">,
  error: { name: string; message: string },
  logs: string,
  $spinner: ReturnType<typeof spinner>,
  warnings?: string[],
  errors?: string[]
) {
  logger.debug("failDeploy", { error, logs, warnings, errors });

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

      // Display the last few lines of the logs, remove #-prefixed ones
      const lastFewLines = logs
        .split("\n")
        .filter((line) => !line.startsWith("#"))
        .filter((line) => line.trim() !== "")
        .slice(-5)
        .join("\n");

      if (lastFewLines.trim() !== "") {
        console.log("Last few lines of logs:\n");
        console.log(lastFewLines);
      }
    } else {
      outro(`${chalkError(`${prefix}:`)} ${error.message}`);
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
      case "INSTALLING":
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
          prettyError(errorData.message, errorData.stack, errorData.stderr);

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

async function initializeOrAttachDeployment(
  apiClient: CliApiClient,
  data: InitializeDeploymentRequestBody,
  existingDeploymentId?: string
): Promise<InitializeDeploymentResponseBody> {
  if (existingDeploymentId) {
    // In the build server we initialize the deployment before installing the project dependencies,
    // so that the status is correctly reflected in the dashboard. In this case, we need to attach
    // to the existing deployment and continue with the remote build process.
    // This is a workaround to avoid major changes in the deploy command and workflow. In the future,
    // we'll likely make the build server the entry point of the flow for building and deploying and also
    // adapt the related deployment API endpoints.

    const existingDeploymentOrError = await apiClient.getDeployment(existingDeploymentId);

    if (!existingDeploymentOrError.success) {
      throw new Error(
        `Failed to attach to existing deployment: ${existingDeploymentOrError.error}`
      );
    }

    const { imageReference, status } = existingDeploymentOrError.data;
    if (!imageReference) {
      // this is just an artifact of our current DB schema
      // `imageReference` is stored as nullable, but it should always exist
      throw new Error("Existing deployment does not have an image reference");
    }

    if (
      status === "CANCELED" ||
      status === "FAILED" ||
      status === "TIMED_OUT" ||
      status === "DEPLOYED"
    ) {
      throw new Error(`Existing deployment is in an unexpected state: ${status}`);
    }

    return {
      ...existingDeploymentOrError.data,
      imageTag: imageReference,
    };
  }

  const newDeploymentOrError = await apiClient.initializeDeployment({
    ...data,
  });

  if (!newDeploymentOrError.success) {
    throw new Error(`Failed to start deployment: ${newDeploymentOrError.error}`);
  }

  return newDeploymentOrError.data;
}

async function handleNativeBuildServerDeploy({
  apiClient,
  options,
  config,
  dashboardUrl,
  userId,
  gitMeta,
}: {
  apiClient: CliApiClient;
  config: Awaited<ReturnType<typeof loadConfig>>;
  dashboardUrl: string;
  options: DeployCommandOptions;
  userId?: string;
  gitMeta?: GitMeta;
}) {
  const tmpDir = join(config.workingDir, ".trigger", "tmp");
  await mkdir(tmpDir, { recursive: true });

  const archivePath = join(tmpDir, `deploy-${Date.now()}.tar.gz`);

  const $deploymentSpinner = spinner();
  $deploymentSpinner.start("Preparing deployment files");

  await createContextArchive(config.workspaceDir, archivePath);

  const archiveSize = await getArchiveSize(archivePath);
  const sizeMB = (archiveSize / 1024 / 1024).toFixed(2);
  $deploymentSpinner.message(`Deployment files ready (${sizeMB} MB)`);

  const artifactResult = await apiClient.createArtifact({
    type: "deployment_context",
    contentType: "application/gzip",
    contentLength: archiveSize,
  });

  if (!artifactResult.success) {
    $deploymentSpinner.stop("Failed to upload deployment files");
    throw new Error(`Failed to create deployment artifact: ${artifactResult.error}`);
  }

  const { artifactKey, uploadUrl, uploadFields } = artifactResult.data;

  logger.debug("Artifact created", { artifactKey });

  $deploymentSpinner.message("Uploading deployment files");

  const [readError, fileBuffer] = await tryCatch(readFile(archivePath));

  if (readError) {
    $deploymentSpinner.stop("Failed to read deployment archive");
    throw new Error(`Failed to read archive: ${readError.message}`);
  }

  const formData = new FormData();

  for (const [key, value] of Object.entries(uploadFields)) {
    formData.append(key, value);
  }

  const blob = new Blob([new Uint8Array(fileBuffer)], { type: "application/gzip" });
  formData.append("file", blob, "deployment.tar.gz");

  const [uploadError, uploadResponse] = await tryCatch(
    fetch(uploadUrl, {
      method: "POST",
      body: formData,
    })
  );

  if (uploadError || !uploadResponse?.ok) {
    $deploymentSpinner.stop("Failed to upload deployment files");
    throw new Error(
      `Failed to upload archive: ${uploadError?.message} ${uploadResponse?.status} ${uploadResponse?.statusText}`
    );
  }

  const [unlinkError] = await tryCatch(unlink(archivePath));
  if (unlinkError) {
    logger.debug("Failed to delete deployment artifact file", { archivePath, error: unlinkError });
  }

  $deploymentSpinner.message("Deployment files uploaded");

  const initializeDeploymentResult = await apiClient.initializeDeployment({
    contentHash: "-",
    userId,
    gitMeta,
    type: config.features.run_engine_v2 ? "MANAGED" : "V1",
    runtime: config.runtime,
    isNativeBuild: true,
    artifactKey,
    skipPromotion: options.skipPromotion,
  });

  if (!initializeDeploymentResult.success) {
    $deploymentSpinner.stop("Failed to initialize deployment");
    log.error(chalk.bold(chalkError(initializeDeploymentResult.error)));
    throw new OutroCommandError(`Deployment failed`);
  }

  const deployment = initializeDeploymentResult.data;

  const rawDeploymentLink = `${dashboardUrl}/projects/v3/${config.project}/deployments/${deployment.shortCode}`;
  const rawTestLink = `${dashboardUrl}/projects/v3/${config.project}/test?environment=${
    options.env === "prod" ? "prod" : "stg"
  }`;

  const exposedDeploymentLink = isLinksSupported
    ? cliLink(chalk.bold(rawDeploymentLink), rawDeploymentLink)
    : chalk.bold(rawDeploymentLink);
  $deploymentSpinner.stop("Deployment initialized");
  log.info(`View deployment: ${exposedDeploymentLink}`);

  setGithubActionsOutputAndEnvVars({
    envVars: {
      TRIGGER_DEPLOYMENT_VERSION: deployment.version,
      TRIGGER_VERSION: deployment.version,
      TRIGGER_DEPLOYMENT_SHORT_CODE: deployment.shortCode,
      TRIGGER_DEPLOYMENT_URL: rawDeploymentLink,
      TRIGGER_TEST_URL: rawTestLink,
    },
    outputs: {
      deploymentVersion: deployment.version,
      workerVersion: deployment.version,
      deploymentShortCode: deployment.shortCode,
      deploymentUrl: rawDeploymentLink,
      testUrl: rawTestLink,
      needsPromotion: options.skipPromotion ? "true" : "false",
    },
  });

  if (options.detach) {
    outro(`Version ${deployment.version} is being deployed`);
    return;
  }

  const { eventStream } = deployment;

  if (!eventStream) {
    log.warn(`Failed streaming build logs, open the deployment in the dashboard to view the logs`);

    outro(`Version ${deployment.version} is being deployed`);

    return process.exit(0);
  }

  const $queuedSpinner = spinner({
    cancelMessage:
      "Disconnecting from the build server log stream. If you intended to cancel the deployment instead, you can do that in the dashboard.",
  });
  $queuedSpinner.start("Build queued");

  const abortController = new AbortController();

  const s2 = new S2({ accessToken: eventStream.s2.accessToken });
  const basin = s2.basin(eventStream.s2.basin);
  const stream = basin.stream(eventStream.s2.stream);

  const [readSessionError, readSession] = await tryCatch(
    stream.readSession(
      {
        seq_num: 0,
        wait: 60 * 20, // 20 minutes
        as: "bytes",
      },
      { signal: abortController.signal }
    )
  );

  if (readSessionError) {
    $queuedSpinner.stop("Failed to query build progress");
    log.warn(`Failed streaming build logs, open the deployment in the dashboard to view the logs`);

    outro(
      `Version ${deployment.version} is being deployed ${
        isLinksSupported ? `| ${cliLink("View deployment", rawDeploymentLink)}` : ""
      }`
    );

    return process.exit(0);
  }

  const decoder = new TextDecoder();
  let finalDeploymentEvent: DeploymentFinalizedEvent["data"] | undefined;
  let queuedSpinnerStopped = false;

  for await (const record of readSession) {
    const decoded = decoder.decode(record.body);
    const result = DeploymentEventFromString.safeParse(decoded);
    if (!result.success) {
      logger.debug("Failed to parse deployment event, skipping", {
        error: result.error,
        record: decoded,
      });
      continue;
    }

    const event = result.data;

    switch (event.type) {
      case "log": {
        if (record.seq_num === 0) {
          $queuedSpinner.stop("Build started");
          log.message("", { symbol: undefined, spacing: 0 });
          queuedSpinnerStopped = true;
        }

        const formattedTimestamp = chalkGrey(
          new Date(record.timestamp).toLocaleTimeString("en-US", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            fractionalSecondDigits: 3,
          })
        );

        const { level, message } = event.data;
        const formattedMessage =
          level === "error"
            ? chalk.bold(chalkError(message))
            : level === "warn"
            ? chalkWarning(message)
            : level === "debug"
            ? chalkGrey(message)
            : message;

        log.message(`${formattedTimestamp} ${formattedMessage}`, { symbol: undefined, spacing: 0 });
        break;
      }
      case "finalized": {
        finalDeploymentEvent = event.data;
        abortController.abort(); // stop the stream
        break;
      }
      default: {
        event satisfies never;
        logger.debug("Unknown deployment event, skipping", { event });
        continue;
      }
    }
  }

  if (!queuedSpinnerStopped && !finalDeploymentEvent) {
    // unlikely that it happens in practice, only in rare corner cases
    // the timeout would kick in earlier if the build server fails to dequeue the build

    $queuedSpinner.stop("Log stream stopped");

    log.error("Failed dequeueing build, please try again shortly");

    throw new OutroCommandError(
      `Version ${deployment.version} ${
        isLinksSupported ? `| ${cliLink("View deployment", rawDeploymentLink)}` : ""
      }`
    );
  }

  if (!finalDeploymentEvent) {
    log.error(
      "Stopped receiving updates from the build server, please check the deployment status in the dashboard"
    );

    if (!isLinksSupported) {
      log.info(`View deployment: ${rawDeploymentLink}`);
    }

    throw new OutroCommandError(
      `Version ${deployment.version} ${
        isLinksSupported ? `| ${cliLink("View deployment", rawDeploymentLink)}` : ""
      }`
    );
  }

  switch (finalDeploymentEvent.result) {
    case "succeeded": {
      queuedSpinnerStopped
        ? log.success("Deployment completed successfully")
        : $queuedSpinner.stop("Deployment completed successfully");

      if (finalDeploymentEvent.message) {
        log.success(finalDeploymentEvent.message);
      }

      if (!isLinksSupported) {
        log.info(`Test tasks: ${rawTestLink}`);
      }

      outro(
        `Version ${deployment.version} was deployed ${
          isLinksSupported
            ? `| ${cliLink("Test tasks", rawTestLink)} | ${cliLink(
                "View deployment",
                rawDeploymentLink
              )}`
            : ""
        }`
      );
      return process.exit(0);
    }
    case "failed": {
      queuedSpinnerStopped
        ? log.error("Deployment failed")
        : $queuedSpinner.stop("Deployment failed");

      if (finalDeploymentEvent.message) {
        log.error(chalk.bold(chalkError(finalDeploymentEvent.message)));
      }
      throw new OutroCommandError(
        `Version ${deployment.version} deployment failed ${
          isLinksSupported ? `| ${cliLink("View deployment", rawDeploymentLink)}` : ""
        }`
      );
    }
    case "timed_out": {
      queuedSpinnerStopped
        ? log.error("Deployment timed out")
        : $queuedSpinner.stop("Deployment timed out");

      if (finalDeploymentEvent.message) {
        log.error(chalk.bold(chalkError(finalDeploymentEvent.message)));
      }
      throw new OutroCommandError(
        `Version ${deployment.version} deployment timed out ${
          isLinksSupported ? `| ${cliLink("View deployment", rawDeploymentLink)}` : ""
        }`
      );
    }
    case "canceled": {
      queuedSpinnerStopped
        ? log.error("Deployment was canceled")
        : $queuedSpinner.stop("Deployment was canceled");

      if (finalDeploymentEvent.message) {
        log.error(chalk.bold(chalkError(finalDeploymentEvent.message)));
      }
      throw new OutroCommandError(
        `Version ${deployment.version} deployment canceled ${
          isLinksSupported ? `| ${cliLink("View deployment", rawDeploymentLink)}` : ""
        }`
      );
    }
    default: {
      // This case is only relevant in case we extend the enum in the future.
      // New enum values will not be treated as errors in older cli versions.
      queuedSpinnerStopped
        ? log.success("Log stream finished")
        : $queuedSpinner.stop("Log stream finished");
      if (finalDeploymentEvent.message) {
        log.message(finalDeploymentEvent.message);
      }

      if (!isLinksSupported) {
        log.info(`Test tasks: ${rawTestLink}`);
      }

      outro(
        `Version ${deployment.version} ${
          isLinksSupported
            ? `| ${cliLink("Test tasks", rawTestLink)} | ${cliLink(
                "View deployment",
                rawDeploymentLink
              )}`
            : ""
        }`
      );
      return process.exit(0);
    }
  }
}

export function verifyDirectory(dir: string, projectPath: string) {
  if (dir !== "." && !isDirectory(projectPath)) {
    if (dir === "staging" || dir === "prod" || dir === "preview") {
      throw new Error(`To deploy to ${dir}, you need to pass "--env ${dir}", not just "${dir}".`);
    }

    if (dir === "production") {
      throw new Error(`To deploy to production, you need to pass "--env prod", not "production".`);
    }

    if (dir === "stg") {
      throw new Error(`To deploy to staging, you need to pass "--env staging", not "stg".`);
    }

    throw new Error(`Directory "${dir}" not found at ${projectPath}`);
  }
}

const DeploymentEventFromString = z
  .string()
  .transform((s, ctx) => {
    try {
      return JSON.parse(s);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid JSON" });
      return z.NEVER;
    }
  })
  .pipe(DeploymentEvent);
