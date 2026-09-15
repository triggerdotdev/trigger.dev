import type { Command } from "commander";
import { configureRunsCancelCommand } from "./cancel.js";
import { configureRunsGetCommand } from "./get.js";
import { configureRunsListCommand } from "./list.js";
import { configureRunsReplayCommand } from "./replay.js";

export function configureRunsCommand(program: Command) {
  const runs = program.command("runs").description("Manage runs for your Trigger.dev project");

  configureRunsListCommand(runs);
  configureRunsGetCommand(runs);
  configureRunsReplayCommand(runs);
  configureRunsCancelCommand(runs);

  return runs;
}
