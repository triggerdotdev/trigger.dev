import type { Command } from "commander";
import { configureProjectsListCommand } from "./list.js";

export function configureProjectsCommand(program: Command) {
  const projects = program.command("projects").description("Manage Trigger.dev projects");

  configureProjectsListCommand(projects);

  return projects;
}
