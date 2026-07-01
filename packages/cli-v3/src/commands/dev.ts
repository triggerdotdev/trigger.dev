import { confirm,intro,isCancel,log } from "@clack/prompts";
import { VERSION } from "@trigger.dev/core";
import { tryCatch } from "@trigger.dev/core/utils";
import { getDevBranch } from "@trigger.dev/core/v3";
import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { Command,Option as CommandOption } from "commander";
import { resolve } from "node:path";
import { z } from "zod";
import { CliApiClient } from "../apiClient.js";
import {
CommonCommandOptions,
commonOptions,
handleTelemetry,
wrapCommandAction,
} from "../cli/common.js";
import { loadConfig,watchConfig } from "../config.js";
import { DevSessionInstance,startDevSession } from "../dev/devSession.js";
import { createLockFile } from "../dev/lock.js";
import { chalkError } from "../utilities/cliOutput.js";
import {
readConfigHasSeenMCPInstallPrompt,
writeConfigHasSeenMCPInstallPrompt,
} from "../utilities/configFiles.js";
import { printDevBanner,printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { resolveLocalEnvVars } from "../utilities/localEnvVars.js";
import { logger } from "../utilities/logger.js";
import {
awaitAndDisplayPlatformNotification,
fetchPlatformNotification,
} from "../utilities/platformNotifications.js";
import { runtimeChecks } from "../utilities/runtimeCheck.js";
import { getProjectClient,LoginResultOk } from "../utilities/session.js";
import { spinner } from "../utilities/windows.js";
import { verifyDirectory } from "./deploy.js";
import { installMcpServer } from "./install-mcp.js";
import { login } from "./login.js";
import { initiateSkillsInstallWizard } from "./skills.js";
import { updateTriggerPackages } from "./update.js";

const DevArchiveCommandOptions = CommonCommandOptions.extend({
  branch: z.string().optional(),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  skipUpdateCheck: z.boolean().default(false),
});

type DevArchiveCommandOptions = z.infer<typeof DevArchiveCommandOptions>;

const DevCommandOptions = CommonCommandOptions.extend({
  debugOtel: z.boolean().default(false),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  branch: z.string().optional(),
  skipUpdateCheck: z.boolean().default(false),
  skipPlatformNotifications: z.boolean().default(false),
  envFile: z.string().optional(),
  keepTmpFiles: z.boolean().default(false),
  maxConcurrentRuns: z.coerce.number().optional(),
  mcp: z.boolean().default(false),
  mcpPort: z.coerce.number().optional().default(3333),
  analyze: z.boolean().default(false),
  disableWarnings: z.boolean().default(false),
  skipMCPInstall: z.boolean().default(false),
  skipRulesInstall: z.boolean().default(false),
});

export type DevCommandOptions = z.infer<typeof DevCommandOptions>;

export function configureDevCommand(program: Command) {
  // `dev` is the root command that defaults to the `start` subcommand,
  // maintains existing behaviour for `trigger dev` but `trigger dev --help` a bit different
  const devBase = program.command("dev").description("Run your Trigger.dev tasks locally");

  commonOptions(
    devBase
      .command("start", { isDefault: true })
      .description("Run your Trigger.dev tasks locally")
      .option("-c, --config <config file>", "The name of the config file")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file."
      )
      .option(
        "-b, --branch <branch>",
        "The dev branch to use. If not provided, we'll use the default branch."
      )
      .option(
        "--env-file <env file>",
        "Path to the .env file to use for the dev session. Defaults to .env in the project directory."
      )
      .option(
        "--max-concurrent-runs <max concurrent runs>",
        "The maximum number of concurrent runs to allow in the dev session"
      )
      .option("--debug-otel", "Enable OpenTelemetry debugging")
      .option("--skip-update-check", "Skip checking for @trigger.dev package updates")
      .option(
        "--keep-tmp-files",
        "Keep temporary files after the dev session ends, helpful for debugging"
      )
      .option("--mcp", "Start the MCP server")
      .option("--mcp-port", "The port to run the MCP server on", "3333")
      .addOption(
        new CommandOption("--analyze", "Analyze the build output and import timings").hideHelp()
      )
      .addOption(
        new CommandOption(
          "--skip-mcp-install",
          "Skip the Trigger.dev MCP server install wizard"
        ).hideHelp()
      )
      .addOption(
        new CommandOption(
          "--skip-rules-install",
          "Skip the Trigger.dev agent skills install wizard"
        ).hideHelp()
      )
      .addOption(new CommandOption("--disable-warnings", "Suppress warnings output").hideHelp())
      .addOption(
        new CommandOption(
          "--skip-platform-notifications",
          "Skip showing platform notifications"
        ).hideHelp()
      )
  ).action(async (options) => {
    wrapCommandAction("dev", DevCommandOptions, options, async (opts) => {
      await devCommand(opts);
    });
  });

  commonOptions(
    devBase
      .command("archive")
      .description("Archive a dev branch")
      .argument("[path]", "The path to the project", ".")
      .option(
        "-b, --branch <branch>",
        "The dev branch to archive. Defaults to the TRIGGER_DEV_BRANCH environment variable if set."
      )
      .option("--skip-update-check", "Skip checking for @trigger.dev package updates")
      .option("-c, --config <config file>", "The name of the config file, found at [path]")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file. This will override the project specified in the config file."
      )
      .option(
        "--env-file <env file>",
        "Path to the .env file to load into the CLI process. Defaults to .env in the project directory."
      )
  ).action(async (path, options) => {
    await handleTelemetry(async () => {
      await printStandloneInitialBanner(true, options.profile);
      await devArchiveCommand(path, options);
    });
  });
}

export async function devCommand(options: DevCommandOptions) {
  runtimeChecks();

  // Only show these install prompts if the user is in a terminal (not in a Coding Agent)
  if (process.stdout.isTTY) {
    const skipMCPInstall = typeof options.skipMCPInstall === "boolean" && options.skipMCPInstall;

    if (!skipMCPInstall) {
      const hasSeenMCPInstallPrompt = readConfigHasSeenMCPInstallPrompt();

      if (!hasSeenMCPInstallPrompt) {
        const installChoice = await confirm({
          message: "Would you like to install the Trigger.dev MCP server?",
          initialValue: true,
        });

        writeConfigHasSeenMCPInstallPrompt(true);

        const skipInstall = isCancel(installChoice) || !installChoice;

        if (!skipInstall) {
          log.step("Welcome to the Trigger.dev MCP server install wizard 🧙");

          const [installError] = await tryCatch(
            installMcpServer({
              yolo: false,
              tag: VERSION as string,
              logLevel: options.logLevel,
            })
          );

          if (installError) {
            log.error(`Failed to install MCP server: ${installError.message}`);
          }
        }
      }
    }

    const skipRulesInstall =
      typeof options.skipRulesInstall === "boolean" && options.skipRulesInstall;

    if (!skipRulesInstall) {
      await tryCatch(initiateSkillsInstallWizard({}));
    }
  }

  const authorization = await login({
    embedded: true,
    silent: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
  });

  if (!authorization.ok) {
    if (authorization.error === "fetch failed") {
      logger.log(
        `${chalkError(
          "X Error:"
        )} Connecting to the server failed. Please check your internet connection or contact eric@trigger.dev for help.`
      );
    } else {
      logger.log(
        `${chalkError("X Error:")} You must login first. Use the \`login\` CLI command.\n\n${
          authorization.error
        }`
      );
    }
    process.exitCode = 1;
    return;
  }

  let watcher;
  try {
    const devInstance = await startDev({ ...options, cwd: process.cwd(), login: authorization });
    watcher = devInstance.watcher;
    await devInstance.waitUntilExit();
  } finally {
    await watcher?.stop();
  }
}

type StartDevOptions = DevCommandOptions & {
  login: LoginResultOk;
  cwd: string;
};

async function startDev(options: StartDevOptions) {
  logger.debug("Starting dev CLI", { options });

  let watcher: Awaited<ReturnType<typeof watchConfig>> | undefined;
  let removeLockFile: (() => void) | undefined;

  try {
    if (options.logLevel) {
      logger.loggerLevel = options.logLevel;
    }

    const apiClient = new CliApiClient(options.login.auth.apiUrl, options.login.auth.accessToken);

    const notificationPromise = options.skipPlatformNotifications
      ? undefined
      : fetchPlatformNotification({
          apiClient,
          projectRef: options.projectRef,
        });

    await printStandloneInitialBanner(true, options.profile);

    await awaitAndDisplayPlatformNotification(notificationPromise);

    let displayedUpdateMessage = false;

    if (!options.skipUpdateCheck) {
      displayedUpdateMessage = await updateTriggerPackages(options.cwd, { ...options }, true, true);
    }

    const envVars = resolveLocalEnvVars(options.envFile);
    const branch = getDevBranch({ specified: options.branch ?? envVars.TRIGGER_DEV_BRANCH });

    removeLockFile = await createLockFile(options.cwd, branch);

    let devInstance: DevSessionInstance | undefined;

    printDevBanner(displayedUpdateMessage);

    if (envVars.TRIGGER_PROJECT_REF) {
      logger.debug("Using project ref from env", { ref: envVars.TRIGGER_PROJECT_REF });
    }

    watcher = await watchConfig({
      cwd: options.cwd,
      async onUpdate(config) {
        logger.debug("Updated config, rerendering", { config });

        if (devInstance) {
          devInstance.stop();
        }

        devInstance = await bootDevSession(config);
      },
      overrides: {
        project: options.projectRef ?? envVars.TRIGGER_PROJECT_REF,
      },
      configFile: options.config,
    });

    logger.debug("Initial config", watcher.config);

    if (branch) {
      const upsertResult = await apiClient.upsertBranch(watcher.config.project, {
        branch,
        env: "development",
      });

      if (!upsertResult.success) {
        logger.error(`Failed to use branch "${branch}": ${upsertResult.error}`);
        process.exit(1);
      }
    }

    // eslint-disable-next-line no-inner-declarations
    async function bootDevSession(configParam: ResolvedConfig) {
      const projectClient = await getProjectClient({
        accessToken: options.login.auth.accessToken,
        apiUrl: options.login.auth.apiUrl,
        projectRef: configParam.project,
        env: "dev",
        branch,
        profile: options.profile,
      });

      if (!projectClient) {
        process.exit(1);
      }

      return startDevSession({
        name: projectClient.name,
        branch,
        rawArgs: options,
        rawConfig: configParam,
        client: projectClient.client,
        initialMode: "local",
        dashboardUrl: options.login.dashboardUrl,
        showInteractiveDevSession: true,
        keepTmpFiles: options.keepTmpFiles,
      });
    }

    devInstance = await bootDevSession(watcher.config);

    const waitUntilExit = async () => {};

    return {
      watcher,
      stop: async () => {
        devInstance?.stop();
        await watcher?.stop();
        removeLockFile?.();
      },
      waitUntilExit,
    };
  } catch (error) {
    removeLockFile?.();
    await watcher?.stop();
    throw error;
  }
}

async function devArchiveCommand(dir: string, options: unknown) {
  return await wrapCommandAction(
    "devArchiveCommand",
    DevArchiveCommandOptions,
    options,
    async (opts) => {
      return await archiveDevBranchCommand(dir, opts);
    }
  );
}

async function archiveDevBranchCommand(dir: string, options: DevArchiveCommandOptions) {
  intro(`Archiving dev branch`);

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

  const resolvedConfig = await loadConfig({
    cwd: projectPath,
    overrides: { project: options.projectRef },
    configFile: options.config,
  });

  logger.debug("Resolved config", resolvedConfig);

  const branch = getDevBranch({ specified: options.branch });

  // getDevBranch returns undefined for the default branch (the root dev env),
  // which can't be archived. Require the user to name a real branch instead.
  if (!branch) {
    throw new Error(
      "You need to specify which dev branch to archive (the default branch can't be archived). Use --branch <branch>."
    );
  }

  const $buildSpinner = spinner();
  $buildSpinner.start(`Archiving "${branch}"`);
  const result = await archiveDevBranch(authorization, branch, resolvedConfig.project);
  $buildSpinner.stop(
    result ? `Successfully archived "${branch}"` : `Failed to archive "${branch}".`
  );
  return result;
}

async function archiveDevBranch(authorization: LoginResultOk, branch: string, project: string) {
  const apiClient = new CliApiClient(authorization.auth.apiUrl, authorization.auth.accessToken);

  const result = await apiClient.archiveBranch(project, "development", branch);

  if (result.success) {
    return true;
  } else {
    logger.error(result.error);
    return false;
  }
}
