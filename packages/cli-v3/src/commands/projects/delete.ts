import { confirm, intro, isCancel, outro } from "@clack/prompts";
import type { Command } from "commander";
import { z } from "zod";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  OutroCommandError,
  wrapCommandAction,
} from "../../cli/common.js";
import { printStandloneInitialBanner } from "../../utilities/initialBanner.js";
import { getPatApiClient } from "./common.js";

const ProjectsDeleteCommandOptions = CommonCommandOptions.extend({
  projectRef: z.string(),
  yes: z.boolean().default(false),
});

type ProjectsDeleteCommandOptions = z.infer<typeof ProjectsDeleteCommandOptions>;

export function configureProjectsDeleteCommand(program: Command) {
  return commonOptions(
    program
      .command("delete")
      .description("Delete a Trigger.dev project")
      .argument("<project ref>", "The project ref, starting with proj_")
      .option("-y, --yes", "Skip the confirmation prompt")
      .action(async (projectRef, options) => {
        await handleTelemetry(async () => {
          await printStandloneInitialBanner(true, options.profile);
          await projectsDeleteCommand({ ...options, projectRef });
        });
      })
  );
}

async function projectsDeleteCommand(options: unknown) {
  return await wrapCommandAction(
    "projectsDeleteCommand",
    ProjectsDeleteCommandOptions,
    options,
    async (opts) => await deleteProject(opts)
  );
}

async function deleteProject(options: ProjectsDeleteCommandOptions) {
  intro(`Deleting project ${options.projectRef}`);

  const apiClient = await getPatApiClient(options);

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      throw new Error(
        "Interactive prompts cannot be used in non-TTY environments. Pass --yes to delete without confirming."
      );
    }

    const project = await apiClient.getProject(options.projectRef);

    if (!project.success) {
      throw new Error(`Failed to get project: ${project.error}`);
    }

    const shouldDelete = await confirm({
      message: `Delete ${project.data.name} (${project.data.externalRef}) and all of its runs? This cannot be undone.`,
      initialValue: false,
    });

    if (isCancel(shouldDelete) || !shouldDelete) {
      throw new OutroCommandError("Cancelled");
    }
  }

  const response = await apiClient.deleteProject(options.projectRef);

  if (!response.success) {
    throw new Error(`Failed to delete project: ${response.error}`);
  }

  outro(`Deleted project ${options.projectRef}`);
}
