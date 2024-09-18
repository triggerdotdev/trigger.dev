import { Command } from "commander";
import { configureDevCommand } from "../commands/dev.js";
import { configureInitCommand } from "../commands/init.js";
import { configureLoginCommand } from "../commands/login.js";
import { configureLogoutCommand } from "../commands/logout.js";
import { configureWhoamiCommand } from "../commands/whoami.js";
import { COMMAND_NAME } from "../consts.js";
import { configureListProfilesCommand } from "../commands/list-profiles.js";
import { configureUpdateCommand } from "../commands/update.js";
import { VERSION } from "../version.js";
import { configureDeployCommand } from "../commands/deploy.js";
import { installExitHandler } from "./common.js";

export const program = new Command();

program
  .name(COMMAND_NAME)
  .description("Create, run locally and deploy Trigger.dev background tasks.")
  .version(VERSION, "-v, --version", "Display the version number");

configureLoginCommand(program);
configureInitCommand(program);
configureDevCommand(program);
configureDeployCommand(program);
configureWhoamiCommand(program);
configureLogoutCommand(program);
configureListProfilesCommand(program);
configureUpdateCommand(program);

installExitHandler();
