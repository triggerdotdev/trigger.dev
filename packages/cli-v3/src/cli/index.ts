import { Command } from "commander";
import { devCommand } from "../commands/dev";
import { updateCommand } from "../commands/update";
import { whoamiCommand } from "../commands/whoami.js";
import { COMMAND_NAME } from "../consts";
import { getVersion } from "../utilities/getVersion";
import { printInitialBanner } from "../utilities/initialBanner";
import { login, loginCommand } from "../commands/login";
import { z } from "zod";

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

//todo update for the new version
//todo add usage instructions to the README
program
  .command("dev")
  .description("Run your Trigger.dev tasks locally")
  .argument("[path]", "The path to the project", ".")
  .option("-p, --port <port>", "Override the local port your server is on")
  .option("-H, --hostname <hostname>", "Override the hostname on which the application is served")
  .option("-e, --env-file <name>", "Override the name of the env file to load")
  .option(
    "-i, --client-id <name>",
    "The ID of the client to use for this project. Will use the value from the package.json file if not provided."
  )
  .version(getVersion(), "-v, --version", "Display the version number")
  .action(async (path, options) => {
    try {
      await printInitialBanner();
      await devCommand(path, options);
    } catch (e) {
      //todo error reporting
      throw e;
    }
  });

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
  .option(
    "-a, --api-url <value>",
    "Override the API URL, defaults to https://cloud.trigger.dev",
    "https://cloud.trigger.dev"
  )
  .version(getVersion(), "-v, --version", "Display the version number")
  .action(async (options) => {
    try {
      await printInitialBanner();
      await whoamiCommand(options);
    } catch (e) {
      throw e;
    }
  });
