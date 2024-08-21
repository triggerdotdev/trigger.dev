import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { Command } from "commander";
import { z } from "zod";
import { CommonCommandOptions, commonOptions, wrapCommandAction } from "../cli/common.js";
import { watchConfig } from "../config.js";
import { startDevSession } from "../dev/devSession.js";
import { chalkError } from "../utilities/cliOutput.js";
import { printDevBanner, printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { runtimeChecks } from "../utilities/runtimeCheck.js";
import { getProjectClient, LoginResultOk } from "../utilities/session.js";
import { login } from "./login.js";
import { updateTriggerPackages } from "./update.js";

const DevCommandOptions = CommonCommandOptions.extend({
  debugOtel: z.boolean().default(false),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  skipUpdateCheck: z.boolean().default(false),
});

export type DevCommandOptions = z.infer<typeof DevCommandOptions>;

export function configureDevCommand(program: Command) {
  return commonOptions(
    program
      .command("dev")
      .description("Run your Trigger.dev tasks locally")
      .argument("[path]", "The path to the project", ".")
      .option("-c, --config <config file>", "The name of the config file, found at [path].")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file."
      )
      .option("--debug-otel", "Enable OpenTelemetry debugging")
      .option("--skip-update-check", "Skip checking for @trigger.dev package updates")
  ).action(async (_, options) => {
    wrapCommandAction("dev", DevCommandOptions, options, async (opts) => {
      await devCommand(opts);
    });
  });
}

export async function devCommand(options: DevCommandOptions) {
  runtimeChecks();

  const authorization = await login({
    embedded: true,
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

    printDevBanner(displayedUpdateMessage);

    watcher = await watchConfig({
      cwd: options.cwd,
      async onUpdate(config) {
        logger.debug("Updated config, rerendering", { config });
        // rerender(await getDevReactElement(config));
      },
      overrides: {
        project: options.projectRef,
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
      });
    }

    const devSession = await bootDevSession(watcher.config);

    const waitUntilExit = async () => {};

    return {
      watcher,
      stop: async () => {
        devSession.stop();
        await watcher?.stop();
      },
      waitUntilExit,
    };
  } catch (error) {
    await watcher?.stop();
    throw error;
  }
}
