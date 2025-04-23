import { intro, isCancel, outro, select } from "@clack/prompts";
import { Command } from "commander";
import { z } from "zod";
import {
  CommonCommandOptions,
  handleTelemetry,
  OutroCommandError,
  wrapCommandAction,
} from "../cli/common.js";
import { chalkGrey } from "../utilities/cliOutput.js";
import { readAuthConfigFile, writeAuthConfigCurrentProfileName } from "../utilities/configFiles.js";
import { printInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { CLOUD_API_URL } from "../consts.js";

const SwitchProfilesOptions = CommonCommandOptions.pick({
  logLevel: true,
  skipTelemetry: true,
});

type SwitchProfilesOptions = z.infer<typeof SwitchProfilesOptions>;

export function configureSwitchProfilesCommand(program: Command) {
  return program
    .command("switch")
    .description("Set your default CLI profile")
    .option(
      "-l, --log-level <level>",
      "The CLI log level to use (debug, info, log, warn, error, none). This does not effect the log level of your trigger.dev tasks.",
      "log"
    )
    .option("--skip-telemetry", "Opt-out of sending telemetry")
    .action(async (options) => {
      await handleTelemetry(async () => {
        await switchProfilesCommand(options);
      });
    });
}

export async function switchProfilesCommand(options: unknown) {
  return await wrapCommandAction("switch", SwitchProfilesOptions, options, async (opts) => {
    await printInitialBanner(false);
    return await switchProfiles(opts);
  });
}

export async function switchProfiles(options: SwitchProfilesOptions) {
  intro("Switch profiles");

  const authConfig = readAuthConfigFile();

  if (!authConfig) {
    logger.info("No profiles found");
    return;
  }

  const profileNames = Object.keys(authConfig.profiles).sort((a, b) => {
    // Default profile should always be first
    if (a === authConfig.currentProfile) return -1;
    if (b === authConfig.currentProfile) return 1;

    return a.localeCompare(b);
  });

  const profileSelection = await select({
    message: "Please select a new profile",
    initialValue: authConfig.currentProfile,
    options: profileNames.map((profile) => ({
      value: profile,
      hint: authConfig.profiles[profile]?.apiUrl
        ? authConfig.profiles[profile].apiUrl === CLOUD_API_URL
          ? undefined
          : chalkGrey(authConfig.profiles[profile].apiUrl)
        : undefined,
    })),
  });

  if (isCancel(profileSelection)) {
    throw new OutroCommandError();
  }

  writeAuthConfigCurrentProfileName(profileSelection);

  if (profileSelection === authConfig.currentProfile) {
    outro(`No change made`);
  } else {
    outro(`Switched to ${profileSelection}`);
  }
}
