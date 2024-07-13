import { intro, log, outro } from "@clack/prompts";
import { depot } from "@depot/cli";
import { context, trace } from "@opentelemetry/api";
import {
  ResolvedConfig,
  TaskMetadataFailedToParseData,
  detectDependencyVersion,
  flattenAttributes,
} from "@trigger.dev/core/v3";
import { recordSpanException } from "@trigger.dev/core/v3/workers";
import { Command, Option as CommandOption } from "commander";
import { Metafile, build } from "esbuild";
import { execa } from "execa";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import invariant from "tiny-invariant";
import { z } from "zod";
import * as packageJson from "../../package.json";
import { CliApiClient } from "../apiClient";
import {
  CommonCommandOptions,
  SkipCommandError,
  SkipLoggingError,
  commonOptions,
  handleTelemetry,
  tracer,
  wrapCommandAction,
} from "../cli/common.js";
import { ReadConfigResult, readConfig } from "../utilities/configFiles.js";
import { createTempDir, writeJSONFile } from "../utilities/fileSystem";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import {
  detectPackageNameFromImportPath,
  parsePackageName,
  stripWorkspaceFromVersion,
} from "../utilities/installPackages";
import { logger } from "../utilities/logger.js";
import { createTaskFileImports, gatherTaskFiles } from "../utilities/taskFiles";
import { login } from "./login";

import { esbuildDecorators } from "@anatine/esbuild-decorators";
import { Glob, GlobOptions } from "glob";
import type { SetOptional } from "type-fest";
import {
  bundleDependenciesPlugin,
  mockServerOnlyPlugin,
  workerSetupImportConfigPlugin,
} from "../utilities/build";
import { chalkError, chalkPurple, chalkWarning, cliLink } from "../utilities/cliOutput";
import {
  logESMRequireError,
  logTaskMetadataParseError,
  parseBuildErrorStack,
  parseNpmInstallError,
} from "../utilities/deployErrors";
import { JavascriptProject } from "../utilities/javascriptProject";
import { docs, getInTouch } from "../utilities/links";
import { cliRootPath } from "../utilities/resolveInternalFilePath";
import { safeJsonParse } from "../utilities/safeJsonParse";
import { escapeImportPath, spinner } from "../utilities/windows";
import { updateTriggerPackages } from "./update";
import { callResolveEnvVars } from "../utilities/resolveEnvVars";

const DeployCommandOptions = CommonCommandOptions.extend({
  skipTypecheck: z.boolean().default(false),
  skipDeploy: z.boolean().default(false),
  env: z.enum(["prod", "staging"]),
  loadImage: z.boolean().default(false),
  buildPlatform: z.enum(["linux/amd64", "linux/arm64"]).default("linux/amd64"),
  selfHosted: z.boolean().default(false),
  registry: z.string().optional(),
  push: z.boolean().default(false),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  outputMetafile: z.string().optional(),
  apiUrl: z.string().optional(),
  saveLogs: z.boolean().default(false),
  skipUpdateCheck: z.boolean().default(false),
  noCache: z.boolean().default(false),
});

type DeployCommandOptions = z.infer<typeof DeployCommandOptions>;

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
      .option("--skip-typecheck", "Whether to skip the pre-build typecheck")
      .option("--skip-update-check", "Skip checking for @trigger.dev package updates")
      .option("-c, --config <config file>", "The name of the config file, found at [path]")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file. This will override the project specified in the config file."
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
      new CommandOption(
        "--ignore-env-var-check",
        "(deprecated) Detected missing environment variables won't block deployment"
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
    .addOption(
      new CommandOption(
        "--output-metafile <path>",
        "If provided, will save the esbuild metafile for the build to the specified path"
      ).hideHelp()
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
  const span = trace.getSpan(context.active());

  intro("Deploying project");

  if (!options.skipUpdateCheck) {
    await updateTriggerPackages(dir, { ...options }, true, true);
  }

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

  span?.setAttributes({
    "cli.userId": authorization.userId,
    "cli.email": authorization.email,
    "cli.config.apiUrl": authorization.auth.apiUrl,
  });

  const resolvedConfig = await readConfig(dir, {
    configFile: options.config,
    projectRef: options.projectRef,
  });

  if (resolvedConfig.status === "error") {
    logger.error("Failed to read config:", resolvedConfig.error);
    span && recordSpanException(span, resolvedConfig.error);

    throw new SkipLoggingError("Failed to read config");
  }

  logger.debug("Resolved config", { resolvedConfig });

  span?.setAttributes({
    "resolvedConfig.status": resolvedConfig.status,
    "resolvedConfig.path": resolvedConfig.status === "file" ? resolvedConfig.path : undefined,
    "resolvedConfig.config.project": resolvedConfig.config.project,
    "resolvedConfig.config.projectDir": resolvedConfig.config.projectDir,
    "resolvedConfig.config.triggerUrl": resolvedConfig.config.triggerUrl,
    "resolvedConfig.config.triggerDirectories": resolvedConfig.config.triggerDirectories,
    ...flattenAttributes(resolvedConfig.config.retries, "resolvedConfig.config.retries"),
  });

  const apiClient = new CliApiClient(authorization.auth.apiUrl, authorization.auth.accessToken);

  const deploymentEnv = await apiClient.getProjectEnv({
    projectRef: resolvedConfig.config.project,
    env: options.env,
  });

  if (!deploymentEnv.success) {
    throw new Error(deploymentEnv.error);
  }

  const environmentClient = new CliApiClient(authorization.auth.apiUrl, deploymentEnv.data.apiKey);

  log.step(
    `Preparing to deploy "${deploymentEnv.data.name}" (${resolvedConfig.config.project}) to ${options.env}`
  );

  // Step 1: Build the project into a temporary directory
  const compilation = await compileProject(
    resolvedConfig.config,
    options,
    resolvedConfig.status === "file" ? resolvedConfig.path : undefined
  );

  logger.debug("Compilation result", { compilation });

  // Optional Step 1.1: resolve environment variables
  await resolveEnvironmentVariables(resolvedConfig, environmentClient, options);

  // Step 2: Initialize a deployment on the server (response will have everything we need to build an image)
  const deploymentResponse = await environmentClient.initializeDeployment({
    contentHash: compilation.contentHash,
    userId: authorization.userId,
  });

  if (!deploymentResponse.success) {
    throw new Error(`Failed to start deployment: ${deploymentResponse.error}`);
  }

  // If the deployment doesn't have any externalBuildData, then we can't use the remote image builder
  // TODO: handle this and allow the user to the build and push the image themselves
  if (!deploymentResponse.data.externalBuildData && !options.selfHosted) {
    throw new Error(
      `Failed to start deployment, as your instance of trigger.dev does not support hosting. To deploy this project, you must use the --self-hosted flag to build and push the image yourself.`
    );
  }

  const version = deploymentResponse.data.version;

  const deploymentSpinner = spinner();

  deploymentSpinner.start(`Deploying version ${version}`);
  const selfHostedRegistryHost = deploymentResponse.data.registryHost ?? options.registry;
  const registryHost = selfHostedRegistryHost ?? "registry.trigger.dev";

  const buildImage = async () => {
    if (options.selfHosted) {
      return buildAndPushSelfHostedImage({
        registryHost: selfHostedRegistryHost,
        imageTag: deploymentResponse.data.imageTag,
        cwd: compilation.path,
        projectId: resolvedConfig.config.project,
        deploymentId: deploymentResponse.data.id,
        deploymentVersion: version,
        contentHash: deploymentResponse.data.contentHash,
        projectRef: resolvedConfig.config.project,
        buildPlatform: options.buildPlatform,
        pushImage: options.push,
        selfHostedRegistry: !!options.registry,
        noCache: options.noCache,
        extraCACerts: resolvedConfig.config.extraCACerts?.replace(/^\./,"/app") ?? "",
      });
    }

    if (!deploymentResponse.data.externalBuildData) {
      throw new Error(
        "Failed to initialize deployment. The deployment does not have any external build data. To deploy this project, you must use the --self-hosted flag to build and push the image yourself."
      );
    }

    return buildAndPushImage(
      {
        registryHost,
        auth: authorization.auth.accessToken,
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
        loadImage: options.loadImage,
        buildPlatform: options.buildPlatform,
        noCache: options.noCache,
        extraCACerts: resolvedConfig.config.extraCACerts?.replace(/^\./,"/app") ?? "",
      },
      deploymentSpinner
    );
  };

  const image = await buildImage();

  const warnings = checkLogsForWarnings(image.logs);

  if (!warnings.ok) {
    await failDeploy(
      deploymentResponse.data.shortCode,
      warnings.summary,
      image.logs,
      deploymentSpinner,
      warnings.warnings,
      warnings.errors
    );

    throw new SkipLoggingError(`Failed to build project image: ${warnings.summary}`);
  }

  if (!image.ok) {
    await failDeploy(
      deploymentResponse.data.shortCode,
      image.error,
      image.logs,
      deploymentSpinner,
      warnings.warnings
    );

    throw new SkipLoggingError(`Failed to build project image: ${image.error}`);
  }

  const preExitTasks = async () => {
    printWarnings(warnings.warnings);

    if (options.saveLogs) {
      const logPath = await saveLogs(deploymentResponse.data.shortCode, image.logs);
      log.info(`Build logs have been saved to ${logPath}`);
    }
  };

  const imageReference = options.selfHosted
    ? `${selfHostedRegistryHost ? `${selfHostedRegistryHost}/` : ""}${image.image}${
        image.digest ? `@${image.digest}` : ""
      }`
    : `${registryHost}/${image.image}${image.digest ? `@${image.digest}` : ""}`;

  span?.setAttributes({
    "image.reference": imageReference,
  });

  if (options.skipDeploy) {
    deploymentSpinner.stop(
      `Project image built: ${imageReference}. Skipping deployment as requested`
    );

    await preExitTasks();

    throw new SkipCommandError("Skipping deployment as requested");
  }

  deploymentSpinner.message(
    `${deploymentResponse.data.version} image built, detecting deployed tasks`
  );

  logger.debug(`Start indexing image ${imageReference}`);

  const startIndexingResponse = await environmentClient.startDeploymentIndexing(
    deploymentResponse.data.id,
    {
      imageReference,
      selfHosted: options.selfHosted,
    }
  );

  if (!startIndexingResponse.success) {
    deploymentSpinner.stop(`Failed to start indexing: ${startIndexingResponse.error}`);

    await preExitTasks();

    throw new SkipLoggingError(`Failed to start indexing: ${startIndexingResponse.error}`);
  }

  const finishedDeployment = await waitForDeploymentToFinish(
    deploymentResponse.data.id,
    environmentClient
  );

  if (!finishedDeployment) {
    deploymentSpinner.stop(`Deployment failed to complete`);

    await preExitTasks();

    throw new SkipLoggingError("Deployment failed to complete: unknown issue");
  }

  if (typeof finishedDeployment === "string") {
    deploymentSpinner.stop(`Deployment failed to complete: ${finishedDeployment}`);

    await preExitTasks();

    throw new SkipLoggingError(`Deployment failed to complete: ${finishedDeployment}`);
  }

  const deploymentLink = cliLink(
    "View deployment",
    `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.config.project}/deployments/${finishedDeployment.shortCode}`
  );

  const testLink = cliLink(
    "Test tasks",
    `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.config.project}/test?environment=${
      options.env === "prod" ? "prod" : "stg"
    }`
  );

  switch (finishedDeployment.status) {
    case "DEPLOYED": {
      if (warnings.warnings.length > 0) {
        deploymentSpinner.stop("Deployment completed with warnings");
      } else {
        deploymentSpinner.stop("Deployment completed");
      }

      await preExitTasks();

      const taskCount = finishedDeployment.worker?.tasks.length ?? 0;

      if (taskCount === 0) {
        outro(
          `Version ${version} deployed with no detected tasks. Please make sure you are exporting tasks in your project. ${deploymentLink}`
        );
      } else {
        outro(
          `Version ${version} deployed with ${taskCount} detected task${
            taskCount === 1 ? "" : "s"
          } | ${deploymentLink} | ${testLink}`
        );
      }

      break;
    }
    case "FAILED": {
      if (finishedDeployment.errorData) {
        if (finishedDeployment.errorData.name === "TaskMetadataParseError") {
          const errorJson = safeJsonParse(finishedDeployment.errorData.stack);

          if (errorJson) {
            const parsedError = TaskMetadataFailedToParseData.safeParse(errorJson);

            if (parsedError.success) {
              deploymentSpinner.stop(`Deployment encountered an error. ${deploymentLink}`);

              logTaskMetadataParseError(parsedError.data.zodIssues, parsedError.data.tasks);

              await preExitTasks();

              throw new SkipLoggingError(
                `Deployment encountered an error: ${finishedDeployment.errorData.name}`
              );
            }
          }
        }

        const parsedError = finishedDeployment.errorData.stack
          ? parseBuildErrorStack(finishedDeployment.errorData) ??
            finishedDeployment.errorData.message
          : finishedDeployment.errorData.message;

        if (typeof parsedError === "string") {
          deploymentSpinner.stop(`Deployment encountered an error. ${deploymentLink}`);

          logger.log(`${chalkError("X Error:")} ${parsedError}`);
        } else {
          deploymentSpinner.stop(`Deployment encountered an error. ${deploymentLink}`);

          logESMRequireError(parsedError, resolvedConfig);
        }

        await preExitTasks();

        if (finishedDeployment.errorData.stderr) {
          log.error(`Error logs:\n${finishedDeployment.errorData.stderr}`);
        }

        throw new SkipLoggingError(
          `Deployment encountered an error: ${finishedDeployment.errorData.name}`
        );
      } else {
        deploymentSpinner.stop(
          `Deployment failed with an unknown error. Please contact eric@trigger.dev for help. ${deploymentLink}`
        );

        await preExitTasks();

        throw new SkipLoggingError("Deployment failed with an unknown error");
      }
    }
    case "CANCELED": {
      deploymentSpinner.stop(`Deployment was canceled. ${deploymentLink}`);

      await preExitTasks();

      throw new SkipLoggingError("Deployment was canceled");
    }
    case "TIMED_OUT": {
      deploymentSpinner.stop(`Deployment timed out. ${deploymentLink}`);

      await preExitTasks();

      throw new SkipLoggingError("Deployment timed out");
    }
  }
}

function printErrors(errors?: string[]) {
  for (const error of errors ?? []) {
    log.error(`${chalkError("Error:")} ${error}`);
  }
}

function printWarnings(warnings?: string[]) {
  for (const warning of warnings ?? []) {
    log.warn(`${chalkWarning("Warning:")} ${warning}`);
  }
}

type WarningsCheckReturn =
  | {
      ok: true;
      warnings: string[];
    }
  | {
      ok: false;
      summary: string;
      errors: string[];
      warnings: string[];
    };

type LogParserOptions = Array<{
  regex: RegExp;
  message: string;
  shouldFail?: boolean;
}>;

// Try to extract useful warnings from logs. Sometimes we may even want to fail the build. This won't work if the step is cached.
function checkLogsForWarnings(logs: string): WarningsCheckReturn {
  const warnings: LogParserOptions = [
    {
      regex: /prisma:warn We could not find your Prisma schema/,
      message: `Prisma generate failed to find the default schema. Did you include it in config.additionalFiles? ${cliLink(
        "Config docs",
        docs.config.prisma
      )}\nCustom schema paths require a postinstall script like this: \`prisma generate --schema=./custom/path/to/schema.prisma\``,
      shouldFail: true,
    },
  ];

  const errorMessages: string[] = [];
  const warningMessages: string[] = [];

  let shouldFail = false;

  for (const warning of warnings) {
    const matches = logs.match(warning.regex);

    if (!matches) {
      continue;
    }

    const message = getMessageFromTemplate(warning.message, matches.groups);

    if (warning.shouldFail) {
      shouldFail = true;
      errorMessages.push(message);
    } else {
      warningMessages.push(message);
    }
  }

  if (shouldFail) {
    return {
      ok: false,
      summary: "Build succeeded with critical warnings. Will not proceed",
      warnings: warningMessages,
      errors: errorMessages,
    };
  }

  return {
    ok: true,
    warnings: warningMessages,
  };
}

// Try to extract useful error messages from the logs
function checkLogsForErrors(logs: string) {
  const errors: LogParserOptions = [
    {
      regex: /Error: Provided --schema at (?<schema>.*) doesn't exist/,
      message: `Prisma generate failed to find the specified schema at "$schema".\nDid you include it in config.additionalFiles? ${cliLink(
        "Config docs",
        docs.config.prisma
      )}`,
    },
    {
      regex: /sh: 1: (?<packageOrBinary>.*): not found/,
      message: `$packageOrBinary not found\n\nIf it's a package: Include it in ${cliLink(
        "config.additionalPackages",
        docs.config.prisma
      )}\nIf it's a binary:  Please ${cliLink(
        "get in touch",
        getInTouch
      )} and we'll see what we can do!`,
    },
  ];

  for (const error of errors) {
    const matches = logs.match(error.regex);

    if (!matches) {
      continue;
    }

    const message = getMessageFromTemplate(error.message, matches.groups);

    log.error(`${chalkError("Error:")} ${message}`);
    break;
  }
}

function getMessageFromTemplate(template: string, replacer: RegExpMatchArray["groups"]) {
  let message = template;

  if (replacer) {
    for (const [key, value] of Object.entries(replacer)) {
      message = message.replaceAll(`$${key}`, value);
    }
  }

  return message;
}

async function saveLogs(shortCode: string, logs: string) {
  const logPath = join(await createTempDir(), `build-${shortCode}.log`);
  await writeFile(logPath, logs);
  return logPath;
}

async function failDeploy(
  shortCode: string,
  errorSummary: string,
  logs: string,
  deploymentSpinner: ReturnType<typeof spinner>,
  warnings?: string[],
  errors?: string[]
) {
  deploymentSpinner.stop(`Failed to deploy project`);

  // If there are logs, let's write it out to a temporary file and include the path in the error message
  if (logs.trim() !== "") {
    const logPath = await saveLogs(shortCode, logs);

    printWarnings(warnings);
    printErrors(errors);

    checkLogsForErrors(logs);

    outro(`${chalkError("Error:")} ${errorSummary}. Full build logs have been saved to ${logPath}`);
  } else {
    outro(`${chalkError("Error:")} ${errorSummary}.`);
  }

  // TODO: Let platform know so it can fail the deploy with an appropriate error
}

// Poll every 1 second for the deployment to finish
async function waitForDeploymentToFinish(
  deploymentId: string,
  client: CliApiClient,
  timeoutInSeconds: number = 180
) {
  return tracer.startActiveSpan("waitForDeploymentToFinish", async (span) => {
    try {
      const start = Date.now();
      let attempts = 0;

      while (true) {
        if (Date.now() - start > timeoutInSeconds * 1000) {
          span.recordException(new Error("Deployment timed out"));
          span.end();
          return;
        }

        const deployment = await client.getDeployment(deploymentId);

        attempts++;

        if (!deployment.success) {
          throw new Error(deployment.error);
        }

        logger.debug(`Deployment status: ${deployment.data.status}`);

        if (
          deployment.data.status === "DEPLOYED" ||
          deployment.data.status === "FAILED" ||
          deployment.data.status === "CANCELED" ||
          deployment.data.status === "TIMED_OUT"
        ) {
          span.setAttributes({
            "deployment.status": deployment.data.status,
            "deployment.attempts": attempts,
          });

          span.end();

          return deployment.data;
        }

        await setTimeout(1000);
      }
    } catch (error) {
      recordSpanException(span, error);
      span.end();

      return error instanceof Error ? error.message : JSON.stringify(error);
    }
  });
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
  noCache: boolean;
  extraCACerts: string;
};

type BuildAndPushImageResults =
  | {
      ok: true;
      image: string;
      logs: string;
      digest?: string;
    }
  | {
      ok: false;
      error: string;
      logs: string;
    };

async function buildAndPushImage(
  options: BuildAndPushImageOptions,
  updater: ReturnType<typeof spinner>
): Promise<BuildAndPushImageResults> {
  return tracer.startActiveSpan("buildAndPushImage", async (span) => {
    span.setAttributes({
      "options.registryHost": options.registryHost,
      "options.imageTag": options.imageTag,
      "options.buildPlatform": options.buildPlatform,
      "options.projectId": options.projectId,
      "options.deploymentId": options.deploymentId,
      "options.deploymentVersion": options.deploymentVersion,
      "options.contentHash": options.contentHash,
      "options.projectRef": options.projectRef,
      "options.loadImage": options.loadImage,
    });

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
      options.noCache ? "--no-cache" : undefined,
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
      "--build-arg",
      `NODE_EXTRA_CA_CERTS=${options.extraCACerts}`,
      "-t",
      `${options.registryHost}/${options.imageTag}`,
      ".",
      "--push",
      options.loadImage ? "--load" : undefined,
    ].filter(Boolean) as string[];

    logger.debug(`depot ${args.join(" ")}`);

    span.setAttribute("depot.command", `depot ${args.join(" ")}`);

    // Step 4: Build and push the image
    const childProcess = depot(args, {
      cwd: options.cwd,
      env: {
        DEPOT_BUILD_ID: options.buildId,
        DEPOT_TOKEN: options.buildToken,
        DEPOT_PROJECT_ID: options.buildProjectId,
        DEPOT_NO_SUMMARY_LINK: "1",
        DEPOT_NO_UPDATE_NOTIFIER: "1",
        DOCKER_CONFIG: dockerConfigDir,
      },
    });

    const errors: string[] = [];

    try {
      const processCode = await new Promise<number | null>((res, rej) => {
        // For some reason everything is output on stderr, not stdout
        childProcess.stderr?.on("data", (data: Buffer) => {
          const text = data.toString();

          // Emitted data chunks can contain multiple lines. Remove empty lines.
          const lines = text.split("\n").filter(Boolean);

          errors.push(...lines);
          logger.debug(text);
        });

        childProcess.on("error", (e) => rej(e));
        childProcess.on("close", (code) => res(code));
      });

      const logs = extractLogs(errors);

      if (processCode !== 0) {
        return {
          ok: false as const,
          error: `Error building image`,
          logs,
        };
      }

      const digest = extractImageDigest(errors);

      span.setAttributes({
        "image.digest": digest,
      });

      span.end();

      return {
        ok: true as const,
        image: options.imageTag,
        logs,
        digest,
      };
    } catch (e) {
      recordSpanException(span, e);
      span.end();

      return {
        ok: false as const,
        error: e instanceof Error ? e.message : JSON.stringify(e),
        logs: extractLogs(errors),
      };
    }
  });
}

type BuildAndPushSelfHostedImageOptions = SetOptional<
  Omit<
    BuildAndPushImageOptions,
    "buildId" | "buildToken" | "buildProjectId" | "auth" | "loadImage"
  >,
  "registryHost"
> & {
  pushImage: boolean;
  selfHostedRegistry: boolean;
};

async function buildAndPushSelfHostedImage(
  options: BuildAndPushSelfHostedImageOptions
): Promise<BuildAndPushImageResults> {
  return await tracer.startActiveSpan("buildAndPushSelfHostedImage", async (span) => {
    span.setAttributes({
      "options.imageTag": options.imageTag,
      "options.buildPlatform": options.buildPlatform,
      "options.projectId": options.projectId,
      "options.deploymentId": options.deploymentId,
      "options.deploymentVersion": options.deploymentVersion,
      "options.contentHash": options.contentHash,
      "options.projectRef": options.projectRef,
    });

    const imageRef = `${options.registryHost ? `${options.registryHost}/` : ""}${options.imageTag}`;

    const buildArgs = [
      "build",
      "-f",
      "Containerfile",
      options.noCache ? "--no-cache" : undefined,
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
      "--build-arg",
      `NODE_EXTRA_CA_CERTS=${options.extraCACerts}`,
      "-t",
      imageRef,
      ".", // The build context
    ].filter(Boolean) as string[];

    logger.debug(`docker ${buildArgs.join(" ")}`, {
      cwd: options.cwd,
    });

    span.setAttribute("docker.command.build", `docker ${buildArgs.join(" ")}`);

    // Build the image
    const buildProcess = execa("docker", buildArgs, {
      cwd: options.cwd,
    });

    const errors: string[] = [];
    let digest: string | undefined;

    try {
      const processCode = await new Promise<number | null>((res, rej) => {
        // For some reason everything is output on stderr, not stdout
        buildProcess.stderr?.on("data", (data: Buffer) => {
          const text = data.toString();

          errors.push(text);
          logger.debug(text);
        });

        buildProcess.on("error", (e) => rej(e));
        buildProcess.on("close", (code) => res(code));
      });

      if (processCode !== 0) {
        return {
          ok: false as const,
          error: "Error building image",
          logs: extractLogs(errors),
        };
      }

      digest = extractImageDigest(errors);

      span.setAttributes({
        "image.digest": digest,
      });
    } catch (e) {
      recordSpanException(span, e);

      span.end();

      return {
        ok: false as const,
        error: e instanceof Error ? e.message : JSON.stringify(e),
        logs: extractLogs(errors),
      };
    }

    const pushArgs = ["push", imageRef].filter(Boolean) as string[];

    logger.debug(`docker ${pushArgs.join(" ")}`);

    span.setAttribute("docker.command.push", `docker ${pushArgs.join(" ")}`);

    if (options.selfHostedRegistry || options.pushImage) {
      // Push the image
      const pushProcess = execa("docker", pushArgs, {
        cwd: options.cwd,
      });

      try {
        const processCode = await new Promise<number | null>((res, rej) => {
          pushProcess.stdout?.on("data", (data: Buffer) => {
            const text = data.toString();

            logger.debug(text);
          });

          pushProcess.stderr?.on("data", (data: Buffer) => {
            const text = data.toString();

            logger.debug(text);
          });

          pushProcess.on("error", (e) => rej(e));
          pushProcess.on("close", (code) => res(code));
        });

        if (processCode !== 0) {
          return {
            ok: false as const,
            error: "Error pushing image",
            logs: extractLogs(errors),
          };
        }

        span.end();
      } catch (e) {
        recordSpanException(span, e);

        span.end();

        return {
          ok: false as const,
          error: e instanceof Error ? e.message : JSON.stringify(e),
          logs: extractLogs(errors),
        };
      }
    }

    span.end();

    return {
      ok: true as const,
      image: options.imageTag,
      digest,
      logs: extractLogs(errors),
    };
  });
}

function extractImageDigest(outputs: string[]) {
  const imageDigestRegex = /pushing manifest for .+(?<digest>sha256:[a-f0-9]{64})/;

  for (const line of outputs) {
    const imageDigestMatch = line.match(imageDigestRegex);

    const digest = imageDigestMatch?.groups?.digest;

    if (digest) {
      return digest;
    }
  }
}

function extractLogs(outputs: string[]) {
  // Remove empty lines
  const cleanedOutputs = outputs.map((line) => line.trim()).filter((line) => line !== "");

  return cleanedOutputs.map((line) => line.trim()).join("\n");
}

async function compileProject(
  config: ResolvedConfig,
  options: DeployCommandOptions,
  configPath?: string
) {
  return await tracer.startActiveSpan("compileProject", async (span) => {
    try {
      if (!options.skipTypecheck) {
        const typecheck = await typecheckProject(config);

        if (!typecheck) {
          throw new Error("Typecheck failed, aborting deployment");
        }
      }

      const compileSpinner = spinner();
      compileSpinner.start(`Building project in ${config.projectDir}`);

      const taskFiles = await gatherTaskFiles(config);
      const workerFacade = readFileSync(
        join(cliRootPath(), "workers", "prod", "worker-facade.js"),
        "utf-8"
      );

      const workerSetupPath = join(cliRootPath(), "workers", "prod", "worker-setup.js");

      let workerContents = workerFacade
        .replace("__TASKS__", createTaskFileImports(taskFiles))
        .replace(
          "__WORKER_SETUP__",
          `import { tracingSDK, otelTracer, otelLogger } from "${escapeImportPath(
            workerSetupPath
          )}";`
        );

      if (configPath) {
        logger.debug("Importing project config from", { configPath });

        workerContents = workerContents.replace(
          "__IMPORTED_PROJECT_CONFIG__",
          `import * as importedConfigExports from "${escapeImportPath(
            configPath
          )}"; const importedConfig = importedConfigExports.config; const handleError = importedConfigExports.handleError;`
        );
      } else {
        workerContents = workerContents.replace(
          "__IMPORTED_PROJECT_CONFIG__",
          `const importedConfig = undefined; const handleError = undefined;`
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
        logLevel: "error",
        platform: "node",
        format: "cjs", // This is needed to support opentelemetry instrumentation that uses module patching
        target: ["node18", "es2020"],
        outdir: "out",
        banner: {
          js: `process.on("uncaughtException", function(error, origin) { if (error instanceof Error) { process.send && process.send({ type: "EVENT", message: { type: "UNCAUGHT_EXCEPTION", payload: { error: { name: error.name, message: error.message, stack: error.stack }, origin }, version: "v1" } }); } else { process.send && process.send({ type: "EVENT", message: { type: "UNCAUGHT_EXCEPTION", payload: { error: { name: "Error", message: typeof error === "string" ? error : JSON.stringify(error) }, origin }, version: "v1" } }); } });`,
        },
        define: {
          TRIGGER_API_URL: `"${config.triggerUrl}"`,
          __PROJECT_CONFIG__: JSON.stringify(config),
        },
        plugins: [
          mockServerOnlyPlugin(),
          bundleDependenciesPlugin(
            "workerFacade",
            config.dependenciesToBundle,
            config.tsconfigPath
          ),
          workerSetupImportConfigPlugin(configPath),
          esbuildDecorators({
            tsconfig: config.tsconfigPath,
            tsx: true,
            force: false,
          }),
        ],
      });

      if (result.errors.length > 0) {
        compileSpinner.stop("Build failed, aborting deployment");

        span.setAttributes({
          "build.workerErrors": result.errors.map(
            (error) => `Error: ${error.text} at ${error.location?.file}`
          ),
        });

        throw new Error("Build failed, aborting deployment");
      }

      if (options.outputMetafile) {
        await writeJSONFile(join(options.outputMetafile, "worker.json"), result.metafile);
      }

      const entryPointContents = readFileSync(
        join(cliRootPath(), "workers", "prod", "entry-point.js"),
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
        logLevel: "error",
        platform: "node",
        packages: "external",
        format: "cjs", // This is needed to support opentelemetry instrumentation that uses module patching
        target: ["node18", "es2020"],
        outdir: "out",
        define: {
          __PROJECT_CONFIG__: JSON.stringify(config),
        },
        plugins: [
          bundleDependenciesPlugin(
            "entryPoint.ts",
            config.dependenciesToBundle,
            config.tsconfigPath
          ),
        ],
      });

      if (entryPointResult.errors.length > 0) {
        compileSpinner.stop("Build failed, aborting deployment");

        span.setAttributes({
          "build.entryPointErrors": entryPointResult.errors.map(
            (error) => `Error: ${error.text} at ${error.location?.file}`
          ),
        });

        throw new Error("Build failed, aborting deployment");
      }

      if (options.outputMetafile) {
        await writeJSONFile(
          join(options.outputMetafile, "entry-point.json"),
          entryPointResult.metafile
        );
      }

      // Create a tmp directory to store the build
      const tempDir = await createTempDir();

      logger.debug(`Writing compiled files to ${tempDir}`);

      // Get the metaOutput for the result build
      const metaOutput = result.metafile!.outputs[posix.join("out", "stdin.js")];

      invariant(metaOutput, "Meta output for the result build is missing");

      // Get the metaOutput for the entryPoint build
      const entryPointMetaOutput =
        entryPointResult.metafile!.outputs[posix.join("out", "stdin.js")];

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

      logger.debug("Getting the imports for the worker and entryPoint builds", {
        workerImports: metaOutput.imports,
        entryPointImports: entryPointMetaOutput.imports,
      });

      // Get all the required dependencies from the metaOutputs and save them to /tmp/dir/package.json
      const allImports = [...metaOutput.imports, ...entryPointMetaOutput.imports];

      const javascriptProject = new JavascriptProject(config.projectDir);

      const dependencies = await resolveRequiredDependencies(allImports, config, javascriptProject);

      logger.debug("gatherRequiredDependencies()", { dependencies });

      const packageJsonContents = {
        ...javascriptProject.allowedPackageJson,
        dependencies,
        scripts: {
          ...javascriptProject.scripts,
          ...(typeof config.postInstall === "string" ? { postinstall: config.postInstall } : {}),
        },
      };

      span.setAttributes({
        ...flattenAttributes(packageJsonContents, "packageJson.contents"),
      });

      await writeJSONFile(join(tempDir, "package.json"), packageJsonContents);

      const copyResult = await copyAdditionalFiles(config, tempDir);

      if (!copyResult.ok) {
        compileSpinner.stop("Project built with warnings");

        log.warn(
          `No additionalFiles matches for:\n\n${copyResult.noMatches
            .map((glob) => `- "${glob}"`)
            .join("\n")}\n\nIf this is unexpected you should check your ${cliLink(
            "glob patterns",
            "https://github.com/isaacs/node-glob?tab=readme-ov-file#glob-primer"
          )} are valid.`
        );
      } else {
        compileSpinner.stop("Project built successfully");
      }

      const resolvingDependenciesResult = await resolveDependencies(
        tempDir,
        packageJsonContents,
        config
      );

      if (!resolvingDependenciesResult) {
        throw new SkipLoggingError("Failed to resolve dependencies");
      }

      // Write the Containerfile to /tmp/dir/Containerfile
      const containerFilePath = join(cliRootPath(), "Containerfile.prod");

      let containerFileContents = readFileSync(containerFilePath, "utf-8");

      await writeFile(join(tempDir, "Containerfile"), containerFileContents);

      const contentHasher = createHash("sha256");
      contentHasher.update(Buffer.from(entryPointOutputFile.text));
      contentHasher.update(Buffer.from(workerOutputFile.text));
      contentHasher.update(Buffer.from(JSON.stringify(dependencies)));

      const contentHash = contentHasher.digest("hex");

      span.setAttributes({
        contentHash: contentHash,
      });

      span.end();

      return { path: tempDir, contentHash };
    } catch (e) {
      recordSpanException(span, e);

      span.end();

      throw e;
    }
  });
}

async function resolveEnvironmentVariables(
  config: ReadConfigResult,
  apiClient: CliApiClient,
  options: DeployCommandOptions
) {
  if (config.status !== "file") {
    return;
  }

  if (!config.module || typeof config.module.resolveEnvVars !== "function") {
    return;
  }

  const projectConfig = config.config;

  return await tracer.startActiveSpan("resolveEnvironmentVariables", async (span) => {
    const $spinner = spinner();
    $spinner.start("Resolving environment variables");

    try {
      let processEnv: Record<string, string | undefined> = {
        ...process.env,
      };

      // Step 1: Get existing env vars from the apiClient
      const environmentVariables = await apiClient.getEnvironmentVariables(projectConfig.project);

      if (environmentVariables.success) {
        processEnv = {
          ...processEnv,
          ...environmentVariables.data.variables,
        };
      }

      logger.debug("Existing environment variables", {
        keys: Object.keys(processEnv),
      });

      // Step 2: Call the resolveEnvVars function with the existing env vars (and process.env)
      const resolvedEnvVars = await callResolveEnvVars(
        config.module,
        processEnv,
        options.env,
        projectConfig.project
      );

      // Step 3: Upload the new env vars via the apiClient
      if (resolvedEnvVars) {
        const total = Object.keys(resolvedEnvVars.variables).length;

        logger.debug("Resolved env vars", {
          keys: Object.keys(resolvedEnvVars.variables),
        });

        if (total > 0) {
          $spinner.message(
            `Syncing ${total} environment variable${total > 1 ? "s" : ""} with the server`
          );

          const uploadResult = await apiClient.importEnvVars(projectConfig.project, options.env, {
            variables: resolvedEnvVars.variables,
            override:
              typeof resolvedEnvVars.override === "boolean" ? resolvedEnvVars.override : true,
          });

          if (uploadResult.success) {
            $spinner.stop(`${total} environment variable${total > 1 ? "s" : ""} synced`);
            return;
          } else {
            $spinner.stop("Failed to sync environment variables");

            throw new Error(uploadResult.error);
          }
        } else {
          $spinner.stop("No environment variables to sync");
          return;
        }
      } else {
        $spinner.stop("No environment variables to sync");
      }

      $spinner.stop("Environment variables resolved");
    } catch (e) {
      $spinner.stop("Failed to resolve environment variables");

      recordSpanException(span, e);

      throw e;
    } finally {
      span.end();
    }
  });
}

// Let's first create a digest from the package.json, and then use that digest to lookup a cached package-lock.json
// in the `.trigger/cache` directory. If the package-lock.json is found, we'll write it to the project directory
// If the package-lock.json is not found, we will run `npm install --package-lock-only` and then write the package-lock.json
// to the project directory, and finally we'll write the digest to the `.trigger/cache` directory with the contents of the package-lock.json
export async function resolveDependencies(
  projectDir: string,
  packageJsonContents: any,
  config: ResolvedConfig
) {
  return await tracer.startActiveSpan("resolveDependencies", async (span) => {
    const resolvingDepsSpinner = spinner();
    resolvingDepsSpinner.start("Resolving dependencies");

    const hasher = createHash("sha256");
    hasher.update(JSON.stringify(packageJsonContents));
    const digest = hasher.digest("hex").slice(0, 16);

    const cacheDir = join(config.projectDir, ".trigger", "cache");
    const cachePath = join(cacheDir, `${digest}.json`);

    span.setAttributes({
      "packageJson.digest": digest,
      "cache.path": cachePath,
      ...flattenAttributes(packageJsonContents, "packageJson.contents"),
    });

    try {
      const cachedPackageLock = await readFile(cachePath, "utf-8");

      logger.debug(`Using cached package-lock.json for ${digest}`);

      await writeFile(join(projectDir, "package-lock.json"), cachedPackageLock);

      span.setAttributes({
        "cache.hit": true,
      });

      span.end();

      resolvingDepsSpinner.stop("Dependencies resolved");

      return true;
    } catch (e) {
      // If the file doesn't exist, we'll continue to the next step
      if (e instanceof Error && "code" in e && e.code !== "ENOENT") {
        span.recordException(e as Error);
        span.end();

        resolvingDepsSpinner.stop(`Failed to resolve dependencies: ${e.message}`);

        return false;
      }

      span.setAttributes({
        "cache.hit": false,
      });

      logger.debug(`No cached package-lock.json found for ${digest}`);

      try {
        if (logger.loggerLevel === "debug") {
          const childProcess = await execa("npm", ["config", "list"], {
            cwd: projectDir,
            stdio: "inherit",
          });

          logger.debug("npm config list");
          console.log(childProcess.stdout);
        }

        await execa(
          "npm",
          [
            "install",
            "--package-lock-only",
            "--ignore-scripts",
            "--no-audit",
            "--legacy-peer-deps=false",
            "--strict-peer-deps=false",
          ],
          {
            cwd: projectDir,
            stdio: logger.loggerLevel === "debug" ? "inherit" : "pipe",
          }
        );

        const packageLockContents = await readFile(join(projectDir, "package-lock.json"), "utf-8");

        logger.debug(`Writing package-lock.json to cache for ${digest}`);

        // Make sure the cache directory exists
        await mkdir(cacheDir, { recursive: true });

        // Save the package-lock.json to the cache
        await writeFile(cachePath, packageLockContents);

        // Write the package-lock.json to the project directory
        await writeFile(join(projectDir, "package-lock.json"), packageLockContents);

        span.end();

        resolvingDepsSpinner.stop("Dependencies resolved");

        return true;
      } catch (installError) {
        recordSpanException(span, installError);
        span.end();

        const parsedError = parseNpmInstallError(installError);

        if (typeof parsedError === "string") {
          resolvingDepsSpinner.stop(`Failed to resolve dependencies: ${parsedError}`);
        } else {
          switch (parsedError.type) {
            case "package-not-found-error": {
              resolvingDepsSpinner.stop(`Failed to resolve dependencies`);

              logger.log(
                `\n${chalkError("X Error:")} The package ${chalkPurple(
                  parsedError.packageName
                )} could not be found in the npm registry.`
              );

              break;
            }
            case "no-matching-version-error": {
              resolvingDepsSpinner.stop(`Failed to resolve dependencies`);

              logger.log(
                `\n${chalkError("X Error:")} The package ${chalkPurple(
                  parsedError.packageName
                )} could not resolve because the version doesn't exist`
              );

              break;
            }
          }
        }

        return false;
      }
    }
  });
}

export async function typecheckProject(config: ResolvedConfig) {
  return await tracer.startActiveSpan("typecheckProject", async (span) => {
    try {
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

        span.recordException(new Error(stdouts.join("\n")));
        span.end();

        return false;
      }

      typecheckSpinner.stop(`Typechecking passed with 0 errors`);

      span.end();
      return true;
    } catch (e) {
      recordSpanException(span, e);

      span.end();

      return false;
    }
  });
}

// Returns the dependencies that are required by the output that are found in output and the CLI package dependencies
// Returns the dependency names and the version to use (taken from the CLI deps package.json)
export async function resolveRequiredDependencies(
  imports: Metafile["outputs"][string]["imports"],
  config: ResolvedConfig,
  project: JavascriptProject
) {
  return await tracer.startActiveSpan("resolveRequiredDependencies", async (span) => {
    const resolvablePackageNames = new Set<string>();

    for (const file of imports) {
      if ((file.kind !== "require-call" && file.kind !== "dynamic-import") || !file.external) {
        continue;
      }

      const packageName = detectPackageNameFromImportPath(file.path);

      if (!packageName) {
        continue;
      }

      resolvablePackageNames.add(packageName);
    }

    span.setAttribute("resolvablePackageNames", Array.from(resolvablePackageNames));

    const resolvedPackageVersions = await project.resolveAll(Array.from(resolvablePackageNames));
    const missingPackages = Array.from(resolvablePackageNames).filter(
      (packageName) => !resolvedPackageVersions[packageName]
    );

    span.setAttributes({
      ...flattenAttributes(resolvedPackageVersions, "resolvedPackageVersions"),
    });
    span.setAttribute("missingPackages", missingPackages);

    const dependencies: Record<string, string> = {};

    for (const missingPackage of missingPackages) {
      const internalDependencyVersion =
        (packageJson.dependencies as Record<string, string>)[missingPackage] ??
        detectDependencyVersion(missingPackage);

      if (internalDependencyVersion) {
        dependencies[missingPackage] = stripWorkspaceFromVersion(internalDependencyVersion);
      }
    }

    for (const [packageName, version] of Object.entries(resolvedPackageVersions)) {
      dependencies[packageName] = version;
    }

    if (config.additionalPackages) {
      span.setAttribute("additionalPackages", config.additionalPackages);

      for (const packageName of config.additionalPackages) {
        if (dependencies[packageName]) {
          continue;
        }

        const packageParts = parsePackageName(packageName);

        if (packageParts.version) {
          dependencies[packageParts.name] = packageParts.version;
          continue;
        } else {
          const externalDependencyVersion = await project.resolve(packageParts.name, {
            allowDev: true,
          });

          if (externalDependencyVersion) {
            dependencies[packageParts.name] = externalDependencyVersion;
            continue;
          } else {
            logger.log(
              `${chalkWarning("X Warning:")} Could not find version for package ${chalkPurple(
                packageName
              )}, add a version specifier to the package name (e.g. ${
                packageParts.name
              }@latest) or add it to your project's package.json`
            );
          }
        }
      }
    }

    if (!dependencies["@trigger.dev/sdk"]) {
      logger.debug("Adding missing @trigger.dev/sdk dependency", {
        version: packageJson.version,
      });

      span.setAttribute("addingMissingSDK", packageJson.version);

      dependencies["@trigger.dev/sdk"] = packageJson.version;
    }

    if (!dependencies["@trigger.dev/core"]) {
      logger.debug("Adding missing @trigger.dev/core dependency", {
        version: packageJson.version,
      });

      span.setAttribute("addingMissingCore", packageJson.version);

      dependencies["@trigger.dev/core"] = packageJson.version;
    }

    // Make sure we sort the dependencies by key to ensure consistent hashing
    const result = Object.fromEntries(
      Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))
    );

    span.setAttributes({
      ...flattenAttributes(result, "dependencies"),
    });

    span.end();

    return result;
  });
}

type AdditionalFilesReturn =
  | {
      ok: true;
    }
  | {
      ok: false;
      noMatches: string[];
    };

export async function copyAdditionalFiles(
  config: ResolvedConfig,
  tempDir: string
): Promise<AdditionalFilesReturn> {
  const additionalFiles = config.additionalFiles ?? [];
  const extraCACerts = config.extraCACerts ?? '';
  if (extraCACerts) {
    additionalFiles.push(extraCACerts);
  }
  const noMatches: string[] = [];

  if (additionalFiles.length === 0) {
    return { ok: true };
  }

  return await tracer.startActiveSpan(
    "copyAdditionalFiles",
    {
      attributes: {
        "config.additionalFiles": additionalFiles,
      },
    },
    async (span) => {
      try {
        logger.debug(`Copying files to ${tempDir}`, {
          additionalFiles,
        });

        const globOptions = {
          withFileTypes: true,
          ignore: ["node_modules"],
          cwd: config.projectDir,
          nodir: true,
        } satisfies GlobOptions;

        const globs: Array<GlobOptions> = [];
        let i = 0;

        for (const additionalFile of additionalFiles) {
          let glob: GlobOptions | Glob<typeof globOptions>;

          if (i === 0) {
            glob = new Glob(additionalFile, globOptions);
          } else {
            const previousGlob = globs[i - 1];
            if (!previousGlob) {
              logger.error("No previous glob, this shouldn't happen", { i, additionalFiles });
              continue;
            }

            // Use the previous glob's options and cache
            glob = new Glob(additionalFile, previousGlob);
          }

          if (!(Symbol.asyncIterator in glob)) {
            logger.error("Glob should be an async iterator", { glob });
            throw new Error("Unrecoverable error while copying additional files");
          }

          let matches = 0;
          for await (const file of glob) {
            matches++;

            // Any additional files that aren't a child of projectDir will be moved inside tempDir, so they can be part of the build context
            // The file "../foo/bar" will be written to "tempDir/foo/bar"
            // The file "../../bar/baz" will be written to "tempDir/bar/baz"
            const pathInsideTempDir = relative(config.projectDir, file.fullpath())
              .split(posix.sep)
              .filter((p) => p !== "..")
              .join(posix.sep);

            const relativeDestinationPath = join(tempDir, pathInsideTempDir);

            logger.debug(`Copying file ${file.fullpath()} to ${relativeDestinationPath}`);

            await mkdir(dirname(relativeDestinationPath), { recursive: true });
            await copyFile(file.fullpath(), relativeDestinationPath);
          }

          if (matches === 0) {
            noMatches.push(additionalFile);
          }

          globs[i] = glob;
          i++;
        }

        span.end();

        if (noMatches.length > 0) {
          return {
            ok: false,
            noMatches,
          } as const;
        }

        return {
          ok: true,
        } as const;
      } catch (error) {
        recordSpanException(span, error);

        span.end();

        throw error;
      }
    }
  );
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
