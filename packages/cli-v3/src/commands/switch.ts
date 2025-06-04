import { intro, isCancel, log, outro, select } from "@clack/prompts";
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
import { CLOUD_API_URL } from "../consts.js";
import { hasTTY, isCI } from "std-env";

const SwitchProfilesOptions = CommonCommandOptions.pick({
  logLevel: true,
  skipTelemetry: true,
});

type SwitchProfilesOptions = z.infer<typeof SwitchProfilesOptions>;

export function configureSwitchProfilesCommand(program: Command) {
  return program
    .command("switch")
    .description("Set your default CLI profile")
    .argument("[profile]", "The profile to switch to. Use interactive mode if not provided.")
    .option(
      "-l, --log-level <level>",
      "The CLI log level to use (debug, info, log, warn, error, none). This does not effect the log level of your trigger.dev tasks.",
      "log"
    )
    .option("--skip-telemetry", "Opt-out of sending telemetry")
    .action(async (profile, options) => {
      await handleTelemetry(async () => {
        await switchProfilesCommand(profile, options);
      });
    });
}

export async function switchProfilesCommand(profile: string | undefined, options: unknown) {
  return await wrapCommandAction("switch", SwitchProfilesOptions, options, async (opts) => {
    await printInitialBanner(false);
    return await switchProfiles(profile, opts);
  });
}

export async function switchProfiles(profile: string | undefined, options: SwitchProfilesOptions) {
  intro("Switch profiles");

  const authConfig = readAuthConfigFile();

  if (!authConfig) {
    outro("Failed to switch profiles");
    throw new Error("No profiles found. Run `login` to create a profile.");
  }

  const profileNames = Object.keys(authConfig.profiles).sort((a, b) => {
    // Default profile should always be first
    if (a === authConfig.currentProfile) return -1;
    if (b === authConfig.currentProfile) return 1;

    return a.localeCompare(b);
  });

  if (profile) {
    if (!authConfig.profiles[profile]) {
      if (isCI || !hasTTY) {
        outro("Failed to switch profiles");
        throw new Error(`Profile "${profile}" not found. Run \`login\` to create a profile.`);
      } else {
        log.message(`Profile "${profile}" not found, showing available profiles`);
      }
    } else {
      if (authConfig.currentProfile === profile) {
        outro(`Already using ${profile}`);
        return;
      }

      writeAuthConfigCurrentProfileName(profile);
      outro(`Switched to ${profile}`);
      return;
    }
  }

  const profileSelection = await select({
    message: "Select a new default profile",
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

  if (authConfig.currentProfile === profileSelection) {
    outro(`Already using ${profileSelection}`);
    return;
  }

  writeAuthConfigCurrentProfileName(profileSelection);

  if (profileSelection === authConfig.currentProfile) {
    outro(`No change made`);
  } else {
    outro(`Switched to ${profileSelection}`);
  }
}
