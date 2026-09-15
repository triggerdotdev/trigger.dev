import type { Command } from "commander";
import { configureProjectsCreateCommand } from "./create.js";
import { configureProjectsDeleteCommand } from "./delete.js";
import { configureProjectsGetCommand } from "./get.js";
import { configureProjectsListCommand } from "./list.js";
import { configureProjectsRenameCommand } from "./rename.js";

export function configureProjectsCommand(program: Command) {
  const projects = program.command("projects").description("Manage Trigger.dev projects");

  configureProjectsListCommand(projects);
  configureProjectsCreateCommand(projects);
  configureProjectsGetCommand(projects);
  configureProjectsRenameCommand(projects);
  configureProjectsDeleteCommand(projects);

  return projects;
}
