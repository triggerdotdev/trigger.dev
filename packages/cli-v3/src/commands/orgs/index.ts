import type { Command } from "commander";
import { configureOrgsCreateCommand } from "./create.js";

export function configureOrgsCommand(program: Command) {
  const orgs = program.command("orgs").description("Manage Trigger.dev organizations");

  configureOrgsCreateCommand(orgs);
}
