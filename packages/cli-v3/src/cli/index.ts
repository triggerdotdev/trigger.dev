import { Command } from "commander";
import { configureDevCommand, devCommand } from "../commands/dev";
import { updateCommand } from "../commands/update";
import { whoamiCommand } from "../commands/whoami.js";
import { COMMAND_NAME } from "../consts";
import { getVersion } from "../utilities/getVersion";
import { printInitialBanner } from "../utilities/initialBanner";
import { login, loginCommand } from "../commands/login";
import { z } from "zod";
import { logoutCommand } from "../commands/logout";

export const program = new Command();

export const ApiUrlOptionsSchema = z.object({
  apiUrl: z.string(),
});

program
  .name(COMMAND_NAME)
  .description("Create, run locally and deploy Trigger.dev background tasks.")
  .version(getVersion(), "-v, --version", "Display the version number");

program
  .command("login")
  .description("Login with Trigger.dev so you can perform authenticated actions")
  .option(
    "-a, --api-url <value>",
    "Override the API URL, defaults to https://api.trigger.dev",
    "https://api.trigger.dev"
  )
  .version(getVersion(), "-v, --version", "Display the version number")
  .action(async (options) => {
    try {
      await printInitialBanner(false);
      await loginCommand(options);
      //todo login command
    } catch (e) {
      //todo error reporting
      throw e;
    }
  });

program
  .command("logout")
  .description("Logout of Trigger.dev")
  .version(getVersion(), "-v, --version", "Display the version number")
  .action(async (options) => {
    try {
      await printInitialBanner(false);
      await logoutCommand(options);
      //todo login command
    } catch (e) {
      //todo error reporting
      throw e;
    }
  });

configureDevCommand(program);

program
  .command("update")
  .description(
    "Updates all @trigger.dev/* packages to their latest compatible versions or the specified version"
  )
  .argument("[path]", "The path to the directory that contains the package.json file", ".")
  .option("-t, --to <version tag>", "The version to update to (ex: 2.1.4)", "latest")
  .action(async (path, options) => {
    await printInitialBanner(false);
    await updateCommand(path, options);
  });

program
  .command("whoami")
  .description("display the current logged in user and project details")
  .version(getVersion(), "-v, --version", "Display the version number")
  .action(async (options) => {
    try {
      await printInitialBanner();
      await whoamiCommand();
    } catch (e) {
      throw e;
    }
  });
