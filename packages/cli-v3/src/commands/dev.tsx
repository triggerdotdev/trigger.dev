import { Command } from "commander";
import { z } from "zod";
import { CliApiClient } from "../apiClient.js";
import { CommonCommandOptions, commonOptions, wrapCommandAction } from "../cli/common.js";
import { chalkError } from "../utilities/cliOutput.js";
import { logger } from "../utilities/logger.js";
import { runtimeCheck } from "../utilities/runtimeCheck.js";
import { isLoggedIn } from "../utilities/session.js";

let apiClient: CliApiClient | undefined;

const DevCommandOptions = CommonCommandOptions.extend({
  debugger: z.boolean().default(false),
  debugOtel: z.boolean().default(false),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  skipUpdateCheck: z.boolean().default(false),
});

type DevCommandOptions = z.infer<typeof DevCommandOptions>;

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
      .option("--debugger", "Enable the debugger")
      .option("--debug-otel", "Enable OpenTelemetry debugging")
      .option("--skip-update-check", "Skip checking for @trigger.dev package updates")
  ).action(async (path, options) => {
    wrapCommandAction("dev", DevCommandOptions, options, async (opts) => {
      await devCommand(path, opts);
    });
  });
}

const MINIMUM_NODE_MAJOR = 18;
const MINIMUM_NODE_MINOR = 20;

export async function devCommand(dir: string, options: DevCommandOptions) {
  try {
    runtimeCheck(MINIMUM_NODE_MAJOR, MINIMUM_NODE_MINOR);
  } catch (e) {
    logger.log(`${chalkError("X Error:")} ${e}`);
    process.exitCode = 1;
    return;
  }

  const authorization = await isLoggedIn(options.profile);

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
}
