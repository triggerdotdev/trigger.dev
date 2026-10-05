import type { Command } from "commander";
import { configureOrgsCreateCommand } from "./create.js";
import { configureOrgsListCommand } from "./list.js";

export function configureOrgsCommand(program: Command) {
  const orgs = program.command("orgs").description("Manage Trigger.dev organizations");

  configureOrgsListCommand(orgs);
  configureOrgsCreateCommand(orgs);
}
