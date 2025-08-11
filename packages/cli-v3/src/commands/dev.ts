import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { Command, Option as CommandOption } from "commander";
import { z } from "zod";
import { CommonCommandOptions, commonOptions, wrapCommandAction } from "../cli/common.js";
import { watchConfig } from "../config.js";
import { DevSessionInstance, startDevSession } from "../dev/devSession.js";
import { createLockFile } from "../dev/lock.js";
import { chalkError } from "../utilities/cliOutput.js";
import { resolveLocalEnvVars } from "../utilities/localEnvVars.js";
import { printDevBanner, printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { runtimeChecks } from "../utilities/runtimeCheck.js";
import { getProjectClient, LoginResultOk } from "../utilities/session.js";
import { login } from "./login.js";
import { updateTriggerPackages } from "./update.js";
import {
  readConfigHasSeenMCPInstallPrompt,
  writeConfigHasSeenMCPInstallPrompt,
} from "../utilities/configFiles.js";
import { confirm, isCancel, log } from "@clack/prompts";
import { installMcpServer } from "./install-mcp.js";
import { tryCatch } from "@trigger.dev/core/utils";
import { VERSION } from "@trigger.dev/core";

const DevCommandOptions = CommonCommandOptions.extend({
  debugOtel: z.boolean().default(false),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  skipUpdateCheck: z.boolean().default(false),
  envFile: z.string().optional(),
  keepTmpFiles: z.boolean().default(false),
  maxConcurrentRuns: z.coerce.number().optional(),
  mcp: z.boolean().default(false),
  mcpPort: z.coerce.number().optional().default(3333),
  analyze: z.boolean().default(false),
  disableWarnings: z.boolean().default(false),
});

export type DevCommandOptions = z.infer<typeof DevCommandOptions>;

export function configureDevCommand(program: Command) {
  return commonOptions(
    program
      .command("dev")
      .description("Run your Trigger.dev tasks locally")
      .option("-c, --config <config file>", "The name of the config file")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file."
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
      .addOption(new CommandOption("--disable-warnings", "Suppress warnings output").hideHelp())
  ).action(async (options) => {
    wrapCommandAction("dev", DevCommandOptions, options, async (opts) => {
      await devCommand(opts);
    });
  });
}

export async function devCommand(options: DevCommandOptions) {
  runtimeChecks();

  const hasSeenMCPInstallPrompt = readConfigHasSeenMCPInstallPrompt();

  if (!hasSeenMCPInstallPrompt) {
    const installChoice = await confirm({
      message: "Would you like to install the Trigger.dev MCP server?",
      initialValue: true,
    });

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

  try {
    if (options.logLevel) {
      logger.loggerLevel = options.logLevel;
    }

    await printStandloneInitialBanner(true);

    let displayedUpdateMessage = false;

    if (!options.skipUpdateCheck) {
      displayedUpdateMessage = await updateTriggerPackages(options.cwd, { ...options }, true, true);
    }

    const removeLockFile = await createLockFile(options.cwd);

    let devInstance: DevSessionInstance | undefined;

    printDevBanner(displayedUpdateMessage);

    const envVars = resolveLocalEnvVars(options.envFile);

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

    // eslint-disable-next-line no-inner-declarations
    async function bootDevSession(configParam: ResolvedConfig) {
      const projectClient = await getProjectClient({
        accessToken: options.login.auth.accessToken,
        apiUrl: options.login.auth.apiUrl,
        projectRef: configParam.project,
        env: "dev",
        profile: options.profile,
      });

      if (!projectClient) {
        process.exit(1);
      }

      return startDevSession({
        name: projectClient.name,
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
        removeLockFile();
      },
      waitUntilExit,
    };
  } catch (error) {
    await watcher?.stop();
    throw error;
  }
}
