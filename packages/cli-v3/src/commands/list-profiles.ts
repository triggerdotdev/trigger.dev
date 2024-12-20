import { log, outro } from "@clack/prompts";
import { Command } from "commander";
import { z } from "zod";
import { CommonCommandOptions, handleTelemetry, wrapCommandAction } from "../cli/common.js";
import { chalkGrey } from "../utilities/cliOutput.js";
import { readAuthConfigFile } from "../utilities/configFiles.js";
import { printInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";

const ListProfilesOptions = CommonCommandOptions.pick({
  logLevel: true,
  skipTelemetry: true,
});

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
        await listProfilesCommand(options);
      });
    });
}

export async function listProfilesCommand(options: unknown) {
  return await wrapCommandAction("listProfiles", ListProfilesOptions, options, async (opts) => {
    await printInitialBanner(false);
    return await listProfiles(opts);
  });
}

export async function listProfiles(options: ListProfilesOptions) {
  const authConfig = readAuthConfigFile();

  if (!authConfig) {
    logger.info("No profiles found");
    return;
  }

  const profileNames = Object.keys(authConfig.profiles);

  log.message("Profiles:");

  for (const profile of profileNames) {
    const profileConfig = authConfig.profiles[profile];

    log.info(`${profile}${profileConfig?.apiUrl ? ` - ${chalkGrey(profileConfig.apiUrl)}` : ""}`);
  }

  outro("Retrieve account info by running whoami --profile <profile>");
}
