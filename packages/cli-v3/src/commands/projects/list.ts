import { intro, outro } from "@clack/prompts";
import { NODE_RUNTIME_UPDATE_MAJOR } from "@trigger.dev/core/v3";
import type { Command } from "commander";
import { z } from "zod";
import { CliApiClient } from "../../apiClient.js";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../../cli/common.js";
import { printStandloneInitialBanner } from "../../utilities/initialBanner.js";
import { logger } from "../../utilities/logger.js";
import { login } from "../login.js";

const ProjectsListCommandOptions = CommonCommandOptions.extend({
  needsUpdate: z.boolean().default(false),
});

type ProjectsListCommandOptions = z.infer<typeof ProjectsListCommandOptions>;

export function configureProjectsListCommand(program: Command) {
  return commonOptions(
    program
      .command("list")
      .description("List current Production deployment runtimes for your projects")
      .option(
        "--needs-update",
        `Only show projects using Node.js ${NODE_RUNTIME_UPDATE_MAJOR} in Production`
      )
      .action(async (options) => {
        await handleTelemetry(async () => {
          await printStandloneInitialBanner(true, options.profile);
          await projectsListCommand(options);
        });
      })
  );
}

async function projectsListCommand(options: unknown) {
  return await wrapCommandAction(
    "projectsListCommand",
    ProjectsListCommandOptions,
    options,
    async (opts) => await listProjects(opts)
  );
}

async function listProjects(options: ProjectsListCommandOptions) {
  intro("Listing current Production deployment runtimes");

  const authorization = await login({
    embedded: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
    silent: true,
  });

  if (!authorization.ok) {
    throw new Error(
      `You must login first. Use the \`login\` CLI command.\n\n${authorization.error}`
    );
  }

  const apiClient = new CliApiClient(authorization.auth.apiUrl, authorization.auth.accessToken);
  const response = await apiClient.getProjectRuntimes();

  if (!response.success) {
    throw new Error(`Failed to list projects: ${response.error}`);
  }

  const projects = options.needsUpdate
    ? response.data.filter((project) => project.deployment?.nodeMajor === NODE_RUNTIME_UPDATE_MAJOR)
    : response.data;

  if (projects.length === 0) {
    outro(
      options.needsUpdate
        ? `No Production projects using Node.js ${NODE_RUNTIME_UPDATE_MAJOR} found.`
        : "No Production projects found."
    );
    return;
  }

  logger.table(
    projects.map(({ organization, project, deployment }) => ({
      organization: organization.title,
      project: project.name,
      ref: project.externalRef,
      runtime: deployment?.runtime ?? "Not deployed",
      version: deployment?.runtimeVersion ?? "-",
      "deployed at": deployment?.deployedAt?.toLocaleString() ?? "-",
    }))
  );
}
