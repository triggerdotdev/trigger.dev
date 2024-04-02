import { Command } from "commander";
import {
  deleteAuthConfigProfile,
  readAuthConfigFile,
  readAuthConfigProfile,
  writeAuthConfigProfile,
} from "../utilities/configFiles.js";
import { logger } from "../utilities/logger.js";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../cli/common.js";
import { printInitialBanner } from "../utilities/initialBanner.js";
import { z } from "zod";
import { chalkGrey } from "../utilities/cliOutput.js";
import { log, outro, text } from "@clack/prompts";

const ListProfilesOptions = CommonCommandOptions;

type ListProfilesOptions = z.infer<typeof ListProfilesOptions>;

export function configureListProfilesCommand(program: Command) {
  return program
    .command("list-profiles")
    .description("List all of your CLI profiles")
    .option(
      "-l, --log-level <level>",
      "The CLI log level to use (debug, info, log, warn, error, none). This does not effect the log level of your trigger.dev tasks.",
      "log"
    )
    .option("--skip-telemetry", "Opt-out of sending telemetry")
    .action(async (options) => {
      await handleTelemetry(async () => {
        await printInitialBanner(true);
        await listProfilesCommand(options);
      });
    });
}

export async function listProfilesCommand(options: unknown) {
  return await wrapCommandAction("listProfiles", ListProfilesOptions, options, async (opts) => {
    return await listProfiles(opts);
  });
}

export async function listProfiles(options: ListProfilesOptions) {
  const authConfig = readAuthConfigFile();

  if (!authConfig) {
    logger.info("No profiles found");
    return;
  }

  const profiles = Object.keys(authConfig);

  log.message("Profiles:");

  for (const profile of profiles) {
    const profileConfig = authConfig[profile];

    log.info(`${profile}${profileConfig?.apiUrl ? ` - ${chalkGrey(profileConfig.apiUrl)}` : ""}`);
  }

  outro("Retrieve account info by running whoami --profile <profile>");
}
