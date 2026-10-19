import type { Command } from "commander";
import { configureTasksTriggerCommand } from "./trigger.js";

export function configureTasksCommand(program: Command) {
  const tasks = program.command("tasks").description("Trigger tasks in your Trigger.dev project");

  configureTasksTriggerCommand(tasks);

  return tasks;
}
