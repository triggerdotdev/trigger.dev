import { Command } from "commander";
import { configureWorkersListCommand } from "./list.js";

export function configureWorkersCommand(program: Command) {
  const workers = program.command("workers").description("Subcommands for managing workers");

  configureWorkersListCommand(workers);

  return workers;
}
