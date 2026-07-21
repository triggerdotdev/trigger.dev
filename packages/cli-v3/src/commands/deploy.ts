import { intro, log, outro } from "@clack/prompts";
import {
  EXTERNAL_DEPLOYMENT_ID_MAX_LENGTH,
  getBranch,
  prepareDeploymentError,
  tryCatch,
} from "@trigger.dev/core/v3";
import type {
  InitializeDeploymentRequestBody,
  InitializeDeploymentResponseBody,
  GitMeta,
  DeploymentFinalizedEvent,
  DeploymentTriggeredVia,
} from "@trigger.dev/core/v3/schemas";
import { BuildManifest, DeploymentEventFromString } from "@trigger.dev/core/v3/schemas";
import type { Command } from "commander";
import { Option as CommandOption } from "commander";
import { join, relative, resolve } from "node:path";
import { isCI } from "std-env";
import { x } from "tinyexec";
import { z } from "zod";
import chalk from "chalk";
import type { CliApiClient } from "../apiClient.js";
import { buildWorker } from "../build/buildWorker.js";
import { resolveAlwaysExternal } from "../build/externals.js";
import { createContextArchive, getArchiveSize } from "../deploy/archiveContext.js";
import { createBundleArchive } from "../deploy/bundleArchive.js";
import { S2 } from "@s2-dev/streamstore";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  OutroCommandError,
  SkipLoggingError,
  wrapCommandAction,
} from "../cli/common.js";
import { loadConfig } from "../config.js";
import { authenticateForDeploy, userIdForDeploy } from "../deploy/auth.js";
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
import { isDirectory, writeJSONFile } from "../utilities/fileSystem.js";
import { setGithubActionsOutputAndEnvVars } from "../utilities/githubActions.js";
import { createGitMeta, isGitHubActions } from "../utilities/gitMeta.js";
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
  externalId: z.string().optional(),
  force: z.boolean().default(false),
  cache: z.boolean().default(true),
  envFile: z.string().optional(),
  // Local build options
  forceLocalBuild: z.boolean().optional(),
  localBuild: z.boolean().optional(),
  useRegistryCache: z.boolean().default(false),
  network: z.enum(["default", "none", "host"]).optional(),
  push: z.boolean().optional(),
  builder: z.string().default("trigger"),
  nativeBuildServer: z.boolean().default(false),
  localBundle: z.boolean().default(false),
  fromBundle: z.string().optional(),
  detach: z.boolean().default(false),
  plain: z.boolean().default(false),
  compression: z.enum(["zstd", "gzip"]).default("zstd"),
  cacheCompression: z.enum(["zstd", "gzip"]).default("zstd"),
  compressionLevel: z.number().optional(),
  forceCompression: z.boolean().default(true),
});

type DeployCommandOptions = z.infer<typeof DeployCommandOptions>;

type Deployment = InitializeDeploymentResponseBody;

// Carries the build-arg VALUES for the `ARG` lines in the generated Containerfile.
// They only exist in the in-memory build manifest (build.json is deliberately scrubbed
// because it gets COPY'd into the image), so --local-bundle writes them to this file
// and --from-bundle reads them back. A .dockerignore entry keeps the file out of the
// image COPY context so the values never land in image layers.
const BUNDLE_BUILD_ARGS_FILE = "trigger-build-args.json";

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
        .option(
          "--external-id <externalId>",
          `An id of your choosing for this deploy, such as a commit SHA, CI run id or release tag (max ${EXTERNAL_DEPLOYMENT_ID_MAX_LENGTH} characters). Deploying the same id again returns the existing version instead of building it twice.`
        )
        .option(
          "--force",
          "Build again even if --external-id has already been deployed. Requires --external-id."
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
      .addOption(
        new CommandOption(
          "--compression <algorithm>",
          "Compression algorithm for image layers: zstd or gzip (default: zstd)"
        )
          .choices(["zstd", "gzip"])
          .hideHelp()
      )
      .addOption(
        new CommandOption(
          "--cache-compression <algorithm>",
          "Compression algorithm for build cache: zstd or gzip (default: zstd)"
        )
          .choices(["zstd", "gzip"])
          .hideHelp()
      )
      .addOption(
        new CommandOption(
          "--compression-level <level>",
          "The compression level to use when building the image."
        ).hideHelp()
      )
      .addOption(
        new CommandOption(
          "--force-compression",
          "Force recompression of all layers. Enabled by default when using zstd."
        ).hideHelp()
      )
      .addOption(
        new CommandOption(
          "--no-force-compression",
          "Disable forced recompression of layers."
        ).hideHelp()
      )
      // Local build options
      .addOption(
        new CommandOption("--force-local-build", "Deprecated alias for --local-build")
          .implies({
            localBuild: true,
          })
          .conflicts("nativeBuildServer")
          .hideHelp()
      )
      .addOption(
        new CommandOption("--local-build", "Build the deployment image locally").conflicts(
          "nativeBuildServer"
        )
      )
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
          "--local-bundle",
          "Experimental: bundle the project locally and upload only the build output; the build server runs the container build. Useful when the remote install/bundle step doesn't work for your project setup. Implies using the native build server."
        )
          .implies({ nativeBuildServer: true })
          .conflicts(["localBuild", "forceLocalBuild"])
      )
      .addOption(
        new CommandOption(
          "--from-bundle <dir>",
          "Internal: build the deployment image from a pre-built bundle directory, skipping the bundling step. Implies a local build."
        )
          .implies({ localBuild: true })
          .conflicts(["nativeBuildServer", "localBundle"])
          .hideHelp()
      )
      .addOption(
        new CommandOption(
          "--detach",
          "Return immediately after the deployment is queued, do not wait for the build to complete. Implies using the native build server."
        ).implies({ nativeBuildServer: true })
      )
      .addOption(new CommandOption("--plain", "Plain output").hideHelp())
      .action(async (path, options) => {
        await handleTelemetry(async () => {
          await printStandloneInitialBanner(true, options.profile);
          await deployCommand(path, options);
        });
      })
  );
}

async function deployCommand(dir: string, options: unknown) {
  return await wrapCommandAction("deployCommand", DeployCommandOptions, options, async (opts) => {
    return await _deployCommand(dir, opts);
  });
}

async function _deployCommand(dir: string, options: DeployCommandOptions) {
  if (options.externalId !== undefined) {
    options.externalId = options.externalId.trim();

    if (options.externalId.length === 0) {
      throw new Error("--external-id must not be empty.");
    }

    if (options.externalId.length > EXTERNAL_DEPLOYMENT_ID_MAX_LENGTH) {
      throw new Error(
        `--external-id must be at most ${EXTERNAL_DEPLOYMENT_ID_MAX_LENGTH} characters.`
      );
    }
  }

  if (options.force && !options.externalId) {
    throw new Error(
      "--force requires --external-id. Without an id there is no previous deployment for --force to build over."
    );
  }

  if (!options.plain) {
    intro(`Deploying project${options.skipPromotion ? " (without promotion)" : ""}`);
  }

  if (!options.skipUpdateCheck) {
    await updateTriggerPackages(dir, { ...options }, true, true);
  }

  const cwd = process.cwd();
  const projectPath = resolve(cwd, dir);

  verifyDirectory(dir, projectPath);

  const authorization = await authenticateForDeploy({
    accessToken: process.env.TRIGGER_ACCESS_TOKEN,
    apiUrl: process.env.TRIGGER_API_URL ?? options.apiUrl,
    profile: options.profile,
    silent: options.plain,
    login,
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

  if (options.fromBundle) {
    // Builds the image from a pre-built bundle directory. The bundle carries no
    // trigger.config.ts source, so this path skips config loading entirely and
    // drives off the bundle's build.json + the deployment record.
    await handleFromBundleDeploy({
      bundleDir: options.fromBundle,
      options,
      dashboardUrl: authorization.dashboardUrl,
      auth: authorization.auth,
      existingDeploymentId: envVars.TRIGGER_EXISTING_DEPLOYMENT_ID,
      projectRefOverride: options.projectRef ?? envVars.TRIGGER_PROJECT_REF,
    });
    return;
  }

  let resolvedConfig = await loadConfig({
    cwd: projectPath,
    overrides: { project: options.projectRef ?? envVars.TRIGGER_PROJECT_REF },
    configFile: options.config,
  });

  logger.debug("Resolved config", resolvedConfig);

  const gitMeta = await createGitMeta(resolvedConfig.workspaceDir);
  logger.debug("gitMeta", gitMeta);

  const isAttachingToExistingDeployment =
    Boolean(envVars.TRIGGER_EXISTING_DEPLOYMENT_ID) ||
    Boolean(gitMeta?.commitSha?.startsWith("deployment_"));

  if (isAttachingToExistingDeployment && (options.externalId || options.force)) {
    throw new Error(
      "--external-id and --force are not supported when attaching to an existing deployment. Remove the flags, or start a new deployment instead."
    );
  }

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

  if (!resolvedConfig.runtimeWasExplicit && projectClient.defaultRuntime) {
    resolvedConfig.runtime = projectClient.defaultRuntime;
  }

  if (options.nativeBuildServer) {
    await handleNativeBuildServerDeploy({
      apiClient: projectClient.client,
      config: resolvedConfig,
      dashboardUrl: authorization.dashboardUrl,
      options,
      userId: userIdForDeploy(authorization),
      gitMeta,
      branch,
    });
    return;
  }

  const serverEnvVars = await projectClient.client.getEnvironmentVariables(resolvedConfig.project);
  loadDotEnvVars(resolvedConfig.workingDir, options.envFile);

  const destination = getTmpDir(resolvedConfig.workingDir, "build", options.dryRun);

  const $buildSpinner = spinner({ plain: options.plain });

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
      plain: options.plain,
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
      userId: userIdForDeploy(authorization),
      gitMeta,
      type: features.run_engine_v2 ? "MANAGED" : "V1",
      runtime: buildManifest.runtime,
      isLocalBuild: options.localBuild,
      isNativeBuild: false,
      triggeredVia: getTriggeredVia(),
      externalId: options.externalId,
      force: options.force,
    },
    envVars.TRIGGER_EXISTING_DEPLOYMENT_ID
  );

  if (deployment.outcome === "existing") {
    const { rawDeploymentLink, rawTestLink } = buildDeploymentLinks({
      dashboardUrl: authorization.dashboardUrl,
      projectRef: resolvedConfig.project,
      env: options.env,
      shortCode: deployment.shortCode,
    });

    setDeploymentGithubActionsOutput({
      version: deployment.version,
      shortCode: deployment.shortCode,
      rawDeploymentLink,
      rawTestLink,
      needsPromotion: !deployment.isPromoted,
    });

    warnAboutSkippedBuild(options.externalId, deployment.isPromoted);

    const message = `Version ${deployment.version} was already deployed for --external-id ${options.externalId} — nothing to build`;

    if (options.plain) {
      console.log(message);

      if (process.env.TRIGGER_DEPLOYMENT_LINK_OUTPUT_DISABLED !== "1") {
        console.log(`Deployment: ${rawDeploymentLink}`);
        console.log(`Test: ${rawTestLink}`);
      }
    } else {
      outro(
        `${message} ${isLinksSupported ? `| ${cliLink("View deployment", rawDeploymentLink)}` : ""}`
      );

      if (!isLinksSupported) {
        console.log("View deployment");
        console.log(rawDeploymentLink);
      }
    }

    return;
  }

  warnAboutCanceledDeployments(deployment.canceledDeployments, options.externalId);

  // When `externalBuildData` is not present the deployment implicitly goes into the local build path
  // which is used in self-hosted setups. There are a few subtle differences between local builds for the cloud
  // and local builds for self-hosted setups. We need to make the separation of the two paths clearer to avoid confusion.
  const isLocalBuild = options.localBuild || !deployment.externalBuildData;

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

  const childVars = buildManifest.deploy.sync?.env ?? {};
  const parentVars = buildManifest.deploy.sync?.parentEnv ?? {};
  const secretChildVars = buildManifest.deploy.sync?.secretEnv ?? {};
  const secretParentVars = buildManifest.deploy.sync?.secretParentEnv ?? {};

  const hasVarsToSync =
    Object.keys(childVars).length > 0 ||
    Object.keys(secretChildVars).length > 0 ||
    // Only sync parent variables if this is a branch environment
    (branch && (Object.keys(parentVars).length > 0 || Object.keys(secretParentVars).length > 0));

  if (hasVarsToSync) {
    const numberOfEnvVars =
      Object.keys(childVars).length +
      Object.keys(parentVars).length +
      Object.keys(secretChildVars).length +
      Object.keys(secretParentVars).length;
    const vars = numberOfEnvVars === 1 ? "var" : "vars";

    if (!options.skipSyncEnvVars) {
      const $spinner = spinner({ plain: options.plain });
      $spinner.start(`Syncing ${numberOfEnvVars} env ${vars} with the server`);

      const uploadResult = await syncEnvVarsWithServer(
        projectClient.client,
        resolvedConfig.project,
        options.env,
        childVars,
        parentVars,
        secretChildVars,
        secretParentVars
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

  await buildAndFinalizeDeployment({
    apiClient: projectClient.client,
    projectId: projectClient.id,
    projectRef: resolvedConfig.project,
    deployment,
    options,
    dashboardUrl: authorization.dashboardUrl,
    authAccessToken: authorization.auth.accessToken,
    compilationPath: destination.path,
    buildEnvVars: buildManifest.build.env,
    branch,
    isLocalBuild,
  });
}

// The shared "build the image and finalize the deployment" tail, used by the standard
// deploy path (after bundling) and by --from-bundle (building from a pre-built bundle).
async function buildAndFinalizeDeployment({
  apiClient,
  projectId,
  projectRef,
  deployment,
  options,
  dashboardUrl,
  authAccessToken,
  compilationPath,
  buildEnvVars,
  branch,
  isLocalBuild,
}: {
  apiClient: CliApiClient;
  projectId: string;
  projectRef: string;
  deployment: Deployment;
  options: DeployCommandOptions;
  dashboardUrl: string;
  authAccessToken: string;
  compilationPath: string;
  buildEnvVars: Record<string, string | undefined> | undefined;
  branch: string | undefined;
  isLocalBuild: boolean;
}) {
  const authenticateToTriggerRegistry = options.localBuild;
  const skipServerSideRegistryPush = options.localBuild;

  const version = deployment.version;

  const { rawDeploymentLink, rawTestLink } = buildDeploymentLinks({
    dashboardUrl,
    projectRef,
    env: options.env,
    shortCode: deployment.shortCode,
  });

  const deploymentLink = cliLink("View deployment", rawDeploymentLink);
  const testLink = cliLink("Test tasks", rawTestLink);

  const $spinner = spinner({ plain: options.plain });

  const buildSuffix =
    isLocalBuild && process.env.TRIGGER_LOCAL_BUILD_LABEL_DISABLED !== "1" ? " (local)" : "";
  const deploySuffix =
    isLocalBuild && process.env.TRIGGER_LOCAL_BUILD_LABEL_DISABLED !== "1" ? " (local build)" : "";

  if (options.plain) {
    $spinner.start(`Building version ${version}${buildSuffix}`);
  } else if (isCI) {
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
    noCache: !options.cache,
    deploymentId: deployment.id,
    deploymentVersion: deployment.version,
    imageTag: deployment.imageTag,
    imagePlatform: deployment.imagePlatform,
    load: options.load,
    contentHash: deployment.contentHash,
    externalBuildId: deployment.externalBuildData?.buildId,
    externalBuildToken: deployment.externalBuildData?.buildToken,
    externalBuildProjectId: deployment.externalBuildData?.projectId,
    projectId,
    projectRef,
    apiUrl: apiClient.apiURL,
    apiKey: apiClient.accessToken!,
    apiClient,
    branchName: branch,
    authAccessToken,
    compilationPath,
    buildEnvVars,
    compression: options.compression,
    cacheCompression: options.cacheCompression,
    compressionLevel: options.compressionLevel,
    forceCompression: options.forceCompression,
    onLog: (logMessage) => {
      if (options.plain || isCI) {
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
    authenticateToRegistry: authenticateToTriggerRegistry,
  });

  logger.debug("Build result", buildResult);

  const warnings = checkLogsForWarnings(buildResult.logs);

  const canShowLocalBuildHint =
    !isLocalBuild && process.env.TRIGGER_LOCAL_BUILD_HINT_DISABLED !== "1";
  const buildFailed = !warnings.ok || !buildResult.ok;

  if (buildFailed && canShowLocalBuildHint) {
    const providerStatus = await apiClient.getRemoteBuildProviderStatus();

    if (providerStatus.success && providerStatus.data.status === "degraded") {
      prettyWarning(providerStatus.data.message + "\n");
    }
  }

  if (!warnings.ok) {
    await failDeploy(
      apiClient,
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
      apiClient,
      deployment,
      { name: "BuildError", message: buildResult.error },
      buildResult.logs,
      $spinner,
      warnings.warnings
    );

    throw new SkipLoggingError("Failed to build image");
  }

  const getDeploymentResponse = await apiClient.getDeployment(deployment.id);

  if (!getDeploymentResponse.success) {
    await failDeploy(
      apiClient,
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
      apiClient,
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

  if (options.plain) {
    $spinner.message(`Deploying version ${version}${deploySuffix}`);
  } else if (isCI) {
    log.step(`Deploying version ${version}${deploySuffix}\n`);
  } else {
    if (isLinksSupported) {
      $spinner.message(`Deploying version ${version}${deploySuffix} ${deploymentLink}`);
    } else {
      $spinner.message(`Deploying version ${version}${deploySuffix}`);
    }
  }

  const finalizeResponse = await apiClient.finalizeDeployment(
    deployment.id,
    {
      imageDigest: buildResult.digest,
      skipPromotion: options.skipPromotion,
      skipPushToRegistry: skipServerSideRegistryPush,
    },
    (logMessage) => {
      if (options.plain || isCI) {
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
      apiClient,
      deployment,
      { name: "FinalizeError", message: finalizeResponse.error },
      buildResult.logs,
      $spinner
    );

    throw new SkipLoggingError("Failed to finalize deployment");
  }

  if (options.plain) {
    console.log(`Successfully deployed version ${version}${deploySuffix}`);
  } else if (isCI) {
    log.step(`Successfully deployed version ${version}${deploySuffix}`);
  } else {
    $spinner.stop(`Successfully deployed version ${version}${deploySuffix}`);
  }

  const taskCount = deploymentWithWorker.worker?.tasks.length ?? 0;

  if (options.plain) {
    console.log(
      `Version ${version} deployed with ${taskCount} detected task${taskCount === 1 ? "" : "s"}`
    );

    if (process.env.TRIGGER_DEPLOYMENT_LINK_OUTPUT_DISABLED !== "1") {
      console.log(`Deployment: ${rawDeploymentLink}`);
      console.log(`Test: ${rawTestLink}`);
    }
  } else {
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
  }

  if (options.saveLogs) {
    const logPath = await saveLogs(deployment.shortCode, buildResult.logs);
    console.log(`Full build logs have been saved to ${logPath}`);
  }

  setDeploymentGithubActionsOutput({
    version,
    shortCode: deployment.shortCode,
    rawDeploymentLink,
    rawTestLink,
    needsPromotion: options.skipPromotion,
  });
}

async function syncEnvVarsWithServer(
  apiClient: CliApiClient,
  projectRef: string,
  environmentSlug: string,
  envVars: Record<string, string>,
  parentEnvVars?: Record<string, string>,
  secretEnvVars?: Record<string, string>,
  secretParentEnvVars?: Record<string, string>
) {
  const hasNonSecret =
    Object.keys(envVars).length > 0 || Object.keys(parentEnvVars ?? {}).length > 0;
  const hasSecret =
    Object.keys(secretEnvVars ?? {}).length > 0 ||
    Object.keys(secretParentEnvVars ?? {}).length > 0;

  // The import API applies isSecret per call, so secret and non-secret vars go in separate calls.
  // Default to success so an all-empty call (no vars to sync) is a no-op, not undefined.
  let result: Awaited<ReturnType<typeof apiClient.importEnvVars>> = {
    success: true,
    data: { success: true },
  };

  if (hasNonSecret) {
    result = await apiClient.importEnvVars(projectRef, environmentSlug, {
      variables: envVars,
      parentVariables: parentEnvVars,
      override: true,
    });
  }

  if (hasSecret && result.success) {
    result = await apiClient.importEnvVars(projectRef, environmentSlug, {
      variables: secretEnvVars ?? {},
      parentVariables: secretParentEnvVars,
      override: true,
      isSecret: true,
    });
  }

  return result;
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
        await doOutputLogs(serverDeployment.canceledReason ?? "Canceled");

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
      outcome: "created" as const,
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

function buildDeploymentLinks({
  dashboardUrl,
  projectRef,
  env,
  shortCode,
}: {
  dashboardUrl: string;
  projectRef: string;
  env: DeployCommandOptions["env"];
  shortCode: string;
}) {
  return {
    rawDeploymentLink: `${dashboardUrl}/projects/v3/${projectRef}/deployments/${shortCode}`,
    rawTestLink: `${dashboardUrl}/projects/v3/${projectRef}/test?environment=${
      env === "prod" ? "prod" : "stg"
    }`,
  };
}

function warnAboutSkippedBuild(externalId: string | undefined, isPromoted: boolean | undefined) {
  prettyWarning(
    "Environment variables were not synced because nothing was built.",
    `If your environment variables have changed, deploy again with --force --external-id ${externalId} to rebuild this id and sync them.`
  );

  if (isPromoted === false) {
    prettyWarning(
      "This version is not the current deployment.",
      "Promote it from the dashboard, or deploy again with --force to build a new version."
    );
  }
}

function warnAboutCanceledDeployments(
  canceledDeployments: Array<{ version: string }> | undefined,
  externalId: string | undefined
) {
  if (!canceledDeployments?.length || !externalId) {
    return;
  }

  const versions = canceledDeployments.map((deployment) => deployment.version);

  const header =
    versions.length === 1
      ? `--force canceled version ${versions[0]}, which was still building for --external-id ${externalId}`
      : `--force canceled ${versions.length} in-progress deployments for --external-id ${externalId}: ${versions.join(", ")}`;

  prettyWarning(
    header,
    "A canceled deployment can never be deployed. The build is signalled to stop, but a build running on another machine can keep going for a few minutes before it notices."
  );
}

function setDeploymentGithubActionsOutput({
  version,
  shortCode,
  rawDeploymentLink,
  rawTestLink,
  needsPromotion,
}: {
  version: string;
  shortCode: string;
  rawDeploymentLink: string;
  rawTestLink: string;
  needsPromotion: boolean;
}) {
  setGithubActionsOutputAndEnvVars({
    envVars: {
      TRIGGER_DEPLOYMENT_VERSION: version,
      TRIGGER_VERSION: version,
      TRIGGER_DEPLOYMENT_SHORT_CODE: shortCode,
      TRIGGER_DEPLOYMENT_URL: rawDeploymentLink,
      TRIGGER_TEST_URL: rawTestLink,
    },
    outputs: {
      deploymentVersion: version,
      workerVersion: version,
      deploymentShortCode: shortCode,
      deploymentUrl: rawDeploymentLink,
      testUrl: rawTestLink,
      needsPromotion: needsPromotion ? "true" : "false",
    },
  });
}

function getTriggeredVia(): DeploymentTriggeredVia {
  // Check specific CI providers first (most specific to least specific)
  if (isGitHubActions()) {
    return "cli:github_actions";
  }
  if (process.env.GITLAB_CI === "true") {
    return "cli:gitlab_ci";
  }
  if (process.env.CIRCLECI === "true") {
    return "cli:circleci";
  }
  if (process.env.JENKINS_URL) {
    return "cli:jenkins";
  }
  if (process.env.TF_BUILD === "True") {
    return "cli:azure_pipelines";
  }
  if (process.env.BITBUCKET_BUILD_NUMBER) {
    return "cli:bitbucket_pipelines";
  }
  if (process.env.TRAVIS === "true") {
    return "cli:travis_ci";
  }
  if (process.env.BUILDKITE === "true") {
    return "cli:buildkite";
  }
  // Fallback for other/unknown CI environments
  if (isCI) {
    return "cli:ci_other";
  }

  return "cli:manual";
}

async function handleNativeBuildServerDeploy({
  apiClient,
  options,
  config,
  dashboardUrl,
  userId,
  gitMeta,
  branch,
}: {
  apiClient: CliApiClient;
  config: Awaited<ReturnType<typeof loadConfig>>;
  dashboardUrl: string;
  options: DeployCommandOptions;
  userId?: string;
  gitMeta?: GitMeta;
  branch?: string;
}) {
  const tmpDir = join(config.workingDir, ".trigger", "tmp");
  await mkdir(tmpDir, { recursive: true });

  const archivePath = join(tmpDir, `deploy-${Date.now()}.tar.gz`);

  // In --local-bundle mode, install + bundling happen locally (same as the classic
  // non-native path) and only the resulting build context is uploaded; the build
  // server then runs just the container build from it.
  let bundleManifest: BuildManifest | undefined;
  let bundleOutputPath: string | undefined;

  if (options.localBundle) {
    const serverEnvVars = await apiClient.getEnvironmentVariables(config.project);
    loadDotEnvVars(config.workingDir, options.envFile);

    // Keep the bundle dir around on dry runs so the printed path is inspectable
    const destination = getTmpDir(config.workingDir, "build", options.dryRun);
    const forcedExternals = await resolveAlwaysExternal(apiClient);

    const $buildSpinner = spinner({ plain: options.plain });

    const [buildError, buildManifest] = await tryCatch(
      buildWorker({
        target: "deploy",
        environment: options.env,
        branch,
        destination: destination.path,
        resolvedConfig: config,
        rewritePaths: true,
        envVars: serverEnvVars.success ? serverEnvVars.data.variables : {},
        forcedExternals,
        plain: options.plain,
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

    if (buildError) {
      $buildSpinner.stop("Failed to build code");
      throw buildError;
    }

    bundleManifest = buildManifest;
    bundleOutputPath = destination.path;

    // Persist the build-arg values (scrubbed from build.json) for the build server's
    // --from-bundle step, and keep them out of the image via .dockerignore.
    await writeJSONFile(join(destination.path, BUNDLE_BUILD_ARGS_FILE), {
      env: buildManifest.build.env ?? {},
    });

    // Append to a .dockerignore a build extension may have produced, never clobber it.
    // Our exclusions always go LAST so a pre-existing negation (!file) can't re-include
    // the build-args file into the image context.
    const dockerignorePath = join(destination.path, ".dockerignore");
    const [, existingDockerignore] = await tryCatch(readFile(dockerignorePath, "utf-8"));
    await writeFile(
      dockerignorePath,
      `${
        existingDockerignore ? existingDockerignore.trimEnd() + "\n" : ""
      }${BUNDLE_BUILD_ARGS_FILE}\n.dockerignore\n`
    );

    if (options.dryRun) {
      logger.info(`Dry run complete. View the built bundle at ${destination.path}`);
      return;
    }

    // Sync env vars BEFORE initializing the deployment: initialization enqueues the
    // remote build synchronously, so syncing afterwards would race a fast build —
    // a run triggered right after promotion could execute without the synced vars.
    // Syncing is environment-scoped and needs no deployment, so pre-init is safe.
    if (!options.skipSyncEnvVars) {
      const childVars = buildManifest.deploy.sync?.env ?? {};
      const parentVars = buildManifest.deploy.sync?.parentEnv ?? {};
      const secretChildVars = buildManifest.deploy.sync?.secretEnv ?? {};
      const secretParentVars = buildManifest.deploy.sync?.secretParentEnv ?? {};

      const hasVarsToSync =
        Object.keys(childVars).length > 0 ||
        Object.keys(secretChildVars).length > 0 ||
        // Only sync parent variables if this is a branch environment
        (branch &&
          (Object.keys(parentVars).length > 0 || Object.keys(secretParentVars).length > 0));

      if (hasVarsToSync) {
        const uploadResult = await syncEnvVarsWithServer(
          apiClient,
          config.project,
          options.env,
          childVars,
          parentVars,
          secretChildVars,
          secretParentVars
        );

        if (!uploadResult.success) {
          throw new Error(`Failed to sync env vars with the server: ${uploadResult.error}`);
        }

        logger.debug("Synced env vars with the server");
      }
    }
  }

  const $deploymentSpinner = spinner();
  $deploymentSpinner.start("Preparing deployment files");

  if (bundleOutputPath) {
    await createBundleArchive(bundleOutputPath, archivePath);
  } else {
    await createContextArchive(config.workspaceDir, archivePath);
  }

  const archiveSize = await getArchiveSize(archivePath);
  const sizeMB = (archiveSize / 1024 / 1024).toFixed(2);
  $deploymentSpinner.message(`Deployment files ready (${sizeMB} MB)`);

  const artifactResult = await apiClient.createArtifact({
    type: options.localBundle ? "deployment_bundle" : "deployment_context",
    contentType: "application/gzip",
    contentLength: archiveSize,
  });

  if (!artifactResult.success) {
    $deploymentSpinner.stop("Failed creating deployment artifact");
    log.error(chalk.bold(chalkError(artifactResult.error)));
    throw new OutroCommandError(`Deployment failed`);
  }

  const { artifactKey, uploadUrl, uploadFields } = artifactResult.data;

  logger.debug("Artifact created", { artifactKey });

  $deploymentSpinner.message("Uploading deployment files");

  const [readError, fileBuffer] = await tryCatch(readFile(archivePath));

  if (readError) {
    $deploymentSpinner.stop("Failed reading deployment archive");
    log.error(chalk.bold(chalkError(readError.message)));
    throw new OutroCommandError(`Deployment failed`);
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
    log.error(
      chalk.bold(
        chalkError(
          `${uploadError?.message} (${uploadResponse?.statusText} ${uploadResponse?.status})`
        )
      )
    );
    throw new OutroCommandError(`Deployment failed`);
  }

  const [unlinkError] = await tryCatch(unlink(archivePath));
  if (unlinkError) {
    logger.debug("Failed to delete deployment artifact file", { archivePath, error: unlinkError });
  }

  $deploymentSpinner.message("Deployment files uploaded");

  const configFilePath =
    config.configFile !== undefined
      ? relative(config.workspaceDir, config.configFile).replace(/\\/g, "/")
      : undefined;

  const initializeDeploymentResult = await apiClient.initializeDeployment({
    contentHash: bundleManifest?.contentHash ?? "-",
    userId,
    gitMeta,
    type: config.features.run_engine_v2 ? "MANAGED" : "V1",
    // Deliberately config.runtime (not the resolved manifest runtime) so the persisted
    // value is identical to classic native deploys.
    runtime: config.runtime,
    isNativeBuild: true,
    artifactKey,
    skipPromotion: options.skipPromotion,
    configFilePath,
    triggeredVia: getTriggeredVia(),
    externalId: options.externalId,
    force: options.force,
    fromBundle: options.localBundle ? true : undefined,
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

  if (deployment.outcome === "existing") {
    $deploymentSpinner.stop(`Version ${deployment.version} was already deployed`);

    setDeploymentGithubActionsOutput({
      version: deployment.version,
      shortCode: deployment.shortCode,
      rawDeploymentLink,
      rawTestLink,
      needsPromotion: !deployment.isPromoted,
    });

    warnAboutSkippedBuild(options.externalId, deployment.isPromoted);

    outro(
      `Version ${deployment.version} was already deployed for --external-id ${options.externalId} — nothing to build ${
        isLinksSupported ? `| ${cliLink("View deployment", rawDeploymentLink)}` : rawDeploymentLink
      }`
    );

    return;
  }

  const exposedDeploymentLink = isLinksSupported
    ? cliLink(chalk.bold(rawDeploymentLink), rawDeploymentLink)
    : chalk.bold(rawDeploymentLink);
  $deploymentSpinner.stop("Deployment initialized");
  log.info(`View deployment: ${exposedDeploymentLink}`);

  warnAboutCanceledDeployments(deployment.canceledDeployments, options.externalId);

  setDeploymentGithubActionsOutput({
    version: deployment.version,
    shortCode: deployment.shortCode,
    rawDeploymentLink,
    rawTestLink,
    needsPromotion: options.skipPromotion,
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

  const $queuedSpinner = spinner();
  $queuedSpinner.start("Build queued");

  const abortController = new AbortController();

  const s2 = new S2({ accessToken: eventStream.s2.accessToken });
  const basin = s2.basin(eventStream.s2.basin);
  const stream = basin.stream(eventStream.s2.stream);

  const [readSessionError, readSession] = await tryCatch(
    stream.readSession(
      {
        start: { from: { seqNum: 0 }, clamp: true },
        stop: { waitSecs: 60 * 20 }, // 20 minutes
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

  let finalDeploymentEvent: DeploymentFinalizedEvent["data"] | undefined;
  let queuedSpinnerStopped = false;

  for await (const record of readSession) {
    const decoded = record.body;
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
        if (record.seqNum === 0) {
          $queuedSpinner.stop("Build started");
          console.log("│");
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

        // We use console.log here instead of clack's logger as the current version does not support changing the line spacing.
        // And the logs look verbose with the default spacing.
        // We cannot upgrade because the newer versions introduced some weird issues with the spinner.
        // Ideally, we'd use clack's `taskLog` to only show the recent n lines of logs as they are streamed, but that also seems brittle
        // and has some issues with cursor movements/clearing lines that it shouldn't clear.
        // We can revisit this on future versions of `@clack/prompts`.
        console.log(`│  ${formattedTimestamp}  ${formattedMessage}`);
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

      if (options.skipPromotion) {
        log.info(
          `This deployment was not automatically promoted. You can promote in the dashboard or via the promote command, e.g, \`npx trigger.dev promote ${deployment.version}\`.`
        );
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
      if (!queuedSpinnerStopped) {
        $queuedSpinner.stop("Deployment failed");
      }

      log.error(
        chalk.bold(
          chalkError(
            "Deployment failed" +
              (finalDeploymentEvent.message ? `: ${finalDeploymentEvent.message}` : "")
          )
        )
      );

      throw new OutroCommandError(
        `Version ${deployment.version} deployment failed ${
          isLinksSupported ? `| ${cliLink("View deployment", rawDeploymentLink)}` : ""
        }`
      );
    }
    case "timed_out": {
      if (!queuedSpinnerStopped) {
        $queuedSpinner.stop("Deployment timed out");
      }

      log.error(
        chalk.bold(
          chalkError(
            "Deployment timed out" +
              (finalDeploymentEvent.message ? `: ${finalDeploymentEvent.message}` : "")
          )
        )
      );

      throw new OutroCommandError(
        `Version ${deployment.version} deployment timed out ${
          isLinksSupported ? `| ${cliLink("View deployment", rawDeploymentLink)}` : ""
        }`
      );
    }
    case "canceled": {
      if (!queuedSpinnerStopped) {
        $queuedSpinner.stop("Deployment was canceled");
      }

      log.error(
        chalk.bold(
          chalkError(
            "Deployment was canceled" +
              (finalDeploymentEvent.message ? `: ${finalDeploymentEvent.message}` : "")
          )
        )
      );

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

// Builds and finalizes a deployment from a pre-built bundle directory (the output of
// the bundling step, as produced by --local-bundle / a dry-run build). Used primarily
// by the build server to run ONLY the container build for pre-bundled artifacts, but
// also works standalone for local testing. Skips config loading entirely — the bundle
// has no trigger.config.ts source; everything needed comes from the bundle's build.json,
// the build-args file, and the deployment record.
async function handleFromBundleDeploy({
  bundleDir,
  options,
  dashboardUrl,
  auth,
  existingDeploymentId,
  projectRefOverride,
}: {
  bundleDir: string;
  options: DeployCommandOptions;
  dashboardUrl: string;
  auth: { accessToken: string; apiUrl: string };
  existingDeploymentId?: string;
  projectRefOverride?: string;
}) {
  const bundlePath = resolve(process.cwd(), bundleDir);

  if (!isDirectory(bundlePath)) {
    throw new Error(`Bundle directory not found at ${bundlePath}`);
  }

  const [manifestReadError, manifestRaw] = await tryCatch(
    readFile(join(bundlePath, "build.json"), "utf-8")
  );

  if (manifestReadError) {
    throw new Error(
      `Failed to read build.json in the bundle directory: ${manifestReadError.message}`
    );
  }

  const manifestResult = BuildManifest.safeParse(JSON.parse(manifestRaw));

  if (!manifestResult.success) {
    throw new Error(`Invalid build.json in the bundle directory: ${manifestResult.error.message}`);
  }

  const bundleManifest = manifestResult.data;

  // Recover the build-arg values scrubbed from build.json (written by --local-bundle).
  // Optional: bundles without build-time env vars may not carry the file.
  let buildEnvVars: Record<string, string> | undefined;
  const [buildArgsError, buildArgsRaw] = await tryCatch(
    readFile(join(bundlePath, BUNDLE_BUILD_ARGS_FILE), "utf-8")
  );

  if (!buildArgsError) {
    const [parseError, parsed] = await tryCatch(Promise.resolve(JSON.parse(buildArgsRaw)));
    if (parseError) {
      throw new Error(`Invalid ${BUNDLE_BUILD_ARGS_FILE} in the bundle directory`);
    }
    buildEnvVars = parsed.env ?? {};
  } else if (bundleManifest.build.env && Object.keys(bundleManifest.build.env).length > 0) {
    // The scrubbed manifest can't carry values, but if a manifest somehow has them, use them.
    buildEnvVars = bundleManifest.build.env;
  }

  const projectRef = projectRefOverride ?? bundleManifest.config.project;

  const branch = options.env === "preview" ? getBranch({ specified: options.branch }) : undefined;

  if (options.env === "preview" && !branch) {
    throw new Error(
      "Preview deploys from a bundle require an explicit branch. Pass --branch <branch>."
    );
  }

  const projectClient = await getProjectClient({
    accessToken: auth.accessToken,
    apiUrl: auth.apiUrl,
    projectRef,
    env: options.env,
    branch,
    profile: options.profile,
  });

  if (!projectClient) {
    throw new Error("Failed to get project client");
  }

  if (!existingDeploymentId) {
    // The supported flow is attach mode (the build server sets
    // TRIGGER_EXISTING_DEPLOYMENT_ID). Fresh-init from a bundle is equivalent to a
    // plain local build and mainly useful for local testing — warn so nobody relies
    // on it against cloud by accident.
    logger.warn(
      "No existing deployment to attach to — initializing a fresh local-build deployment from the bundle. This path is intended for testing."
    );
  }

  const deployment = await initializeOrAttachDeployment(
    projectClient.client,
    {
      contentHash: bundleManifest.contentHash,
      type: "MANAGED",
      runtime: bundleManifest.runtime,
      isLocalBuild: true,
      isNativeBuild: false,
      triggeredVia: getTriggeredVia(),
    },
    existingDeploymentId
  );

  // Fail fast if we know local builds will fail
  const buildxResult = await x("docker", ["buildx", "version"]);

  if (buildxResult.exitCode !== 0) {
    logger.debug(`"docker buildx version" failed (${buildxResult.exitCode}):`, buildxResult);
    throw new Error(
      "Failed to find docker buildx. Please install it: https://github.com/docker/buildx#installing."
    );
  }

  await buildAndFinalizeDeployment({
    apiClient: projectClient.client,
    projectId: projectClient.id,
    projectRef,
    deployment,
    options,
    dashboardUrl,
    authAccessToken: auth.accessToken,
    compilationPath: bundlePath,
    buildEnvVars,
    branch,
    isLocalBuild: true,
  });
}
