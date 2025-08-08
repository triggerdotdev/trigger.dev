import { Command } from "commander";
import { configureAnalyzeCommand } from "../commands/analyze.js";
import { configureDeployCommand } from "../commands/deploy.js";
import { configureDevCommand } from "../commands/dev.js";
import { configureInitCommand } from "../commands/init.js";
import { configureListProfilesCommand } from "../commands/list-profiles.js";
import { configureLoginCommand } from "../commands/login.js";
import { configureLogoutCommand } from "../commands/logout.js";
import { configurePreviewCommand } from "../commands/preview.js";
import { configurePromoteCommand } from "../commands/promote.js";
import { configureSwitchProfilesCommand } from "../commands/switch.js";
import { configureUpdateCommand } from "../commands/update.js";
import { configureWhoamiCommand } from "../commands/whoami.js";
import { configureMcpCommand } from "../commands/mcp.js";
import { COMMAND_NAME } from "../consts.js";
import { VERSION } from "../version.js";
import { installExitHandler } from "./common.js";
import { configureInstallMcpCommand } from "../commands/install-mcp.js";

export const program = new Command();

program
  .name(COMMAND_NAME)
  .description("Create, run locally and deploy Trigger.dev background tasks.")
  .version(VERSION, "-v, --version", "Display the version number");

configureLoginCommand(program);
configureInitCommand(program);
configureDevCommand(program);
configureDeployCommand(program);
configurePromoteCommand(program);
configureWhoamiCommand(program);
configureLogoutCommand(program);
configureListProfilesCommand(program);
configureSwitchProfilesCommand(program);
configureUpdateCommand(program);
configurePreviewCommand(program);
configureAnalyzeCommand(program);
configureMcpCommand(program);
configureInstallMcpCommand(program);

installExitHandler();
