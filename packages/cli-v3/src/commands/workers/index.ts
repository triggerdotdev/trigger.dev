import { Command } from "commander";
import { configureWorkersBuildCommand } from "./build.js";
import { configureWorkersListCommand } from "./list.js";
import { configureWorkersCreateCommand } from "./create.js";
import { configureWorkersRunCommand } from "./run.js";

export function configureWorkersCommand(program: Command) {
  const workers = program.command("workers").description("Subcommands for managing workers");

  configureWorkersBuildCommand(workers);
  configureWorkersListCommand(workers);
  configureWorkersCreateCommand(workers);
  configureWorkersRunCommand(workers);

  return workers;
}
