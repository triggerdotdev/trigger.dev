import { intro, outro } from "@clack/prompts";
import type { Command } from "commander";
import { z } from "zod";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../../cli/common.js";
import { printStandloneInitialBanner } from "../../utilities/initialBanner.js";
import { getPatApiClient } from "./common.js";

const ProjectsRenameCommandOptions = CommonCommandOptions.extend({
  projectRef: z.string(),
  name: z.string().trim().min(1).max(255),
});

type ProjectsRenameCommandOptions = z.infer<typeof ProjectsRenameCommandOptions>;

export function configureProjectsRenameCommand(program: Command) {
  return commonOptions(
    program
      .command("rename")
      .description("Rename a Trigger.dev project")
      .argument("<project ref>", "The project ref, starting with proj_")
      .argument("<name>", "The new project name")
      .action(async (projectRef, name, options) => {
        await handleTelemetry(async () => {
          await printStandloneInitialBanner(true, options.profile);
          await projectsRenameCommand({ ...options, projectRef, name });
        });
      })
  );
}

async function projectsRenameCommand(options: unknown) {
  return await wrapCommandAction(
    "projectsRenameCommand",
    ProjectsRenameCommandOptions,
    options,
    async (opts) => await renameProject(opts)
  );
}

async function renameProject(options: ProjectsRenameCommandOptions) {
  intro(`Renaming project ${options.projectRef}`);

  const apiClient = await getPatApiClient(options);
  const response = await apiClient.renameProject(options.projectRef, { name: options.name });

  if (!response.success) {
    throw new Error(`Failed to rename project: ${response.error}`);
  }

  outro(`Renamed project ${options.projectRef} to ${response.data.name}`);
}
