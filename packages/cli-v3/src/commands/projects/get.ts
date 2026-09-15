import { intro, note, outro } from "@clack/prompts";
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

const ProjectsGetCommandOptions = CommonCommandOptions.extend({
  projectRef: z.string(),
});

type ProjectsGetCommandOptions = z.infer<typeof ProjectsGetCommandOptions>;

export function configureProjectsGetCommand(program: Command) {
  return commonOptions(
    program
      .command("get")
      .description("Show the details of a Trigger.dev project")
      .argument("<project ref>", "The project ref, starting with proj_")
      .action(async (projectRef, options) => {
        await handleTelemetry(async () => {
          await printStandloneInitialBanner(true, options.profile);
          await projectsGetCommand({ ...options, projectRef });
        });
      })
  );
}

async function projectsGetCommand(options: unknown) {
  return await wrapCommandAction(
    "projectsGetCommand",
    ProjectsGetCommandOptions,
    options,
    async (opts) => await getProject(opts)
  );
}

async function getProject(options: ProjectsGetCommandOptions) {
  intro(`Getting project ${options.projectRef}`);

  const apiClient = await getPatApiClient(options);
  const response = await apiClient.getProject(options.projectRef);

  if (!response.success) {
    throw new Error(`Failed to get project: ${response.error}`);
  }

  const project = response.data;

  note(
    `Name:    ${project.name}
Ref:     ${project.externalRef}
Slug:    ${project.slug}
Org:     ${project.organization.title}
Runtime: ${project.defaultRuntime ?? "-"}
Region:  ${project.defaultRegion ?? "-"}
Created: ${project.createdAt.toLocaleString()}`,
    "Project details"
  );

  outro(`Project: ${project.externalRef}`);
}
