import { Command } from "commander";
import { z } from "zod";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../cli/common.js";
import { deleteAuthConfigProfile, readAuthConfigProfile } from "../utilities/configFiles.js";
import { printInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";

const LogoutCommandOptions = CommonCommandOptions;

type LogoutCommandOptions = z.infer<typeof LogoutCommandOptions>;

export function configureLogoutCommand(program: Command) {
  return commonOptions(program.command("logout").description("Logout of Trigger.dev")).action(
    async (options) => {
      await handleTelemetry(async () => {
        await printInitialBanner(false, options.profile);
        await logoutCommand(options);
      });
    }
  );
}

export async function logoutCommand(options: unknown) {
  return await wrapCommandAction("logoutCommand", LogoutCommandOptions, options, async (opts) => {
    return await logout(opts);
  });
}

export async function logout(options: LogoutCommandOptions) {
  const config = readAuthConfigProfile(options.profile);

  if (!config?.accessToken) {
    logger.info(`You are already logged out [${options.profile}]`);
    return;
  }

  deleteAuthConfigProfile(options.profile);

  logger.info(`Logged out of Trigger.dev [${options.profile}]`);
}
