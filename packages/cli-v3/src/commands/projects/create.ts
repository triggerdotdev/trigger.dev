import { intro, isCancel, outro, select, text } from "@clack/prompts";
import type { Command } from "commander";
import { z } from "zod";
import type { CliApiClient } from "../../apiClient.js";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  OutroCommandError,
  wrapCommandAction,
} from "../../cli/common.js";
import { printStandloneInitialBanner } from "../../utilities/initialBanner.js";
import { getPatApiClient } from "./common.js";

const ProjectsCreateCommandOptions = CommonCommandOptions.extend({
  org: z.string().optional(),
  name: z.string().optional(),
});

type ProjectsCreateCommandOptions = z.infer<typeof ProjectsCreateCommandOptions>;

export function configureProjectsCreateCommand(program: Command) {
  return commonOptions(
    program
      .command("create")
      .description("Create a new Trigger.dev project")
      .option("-o, --org <org>", "The organization slug or ID to create the project in")
      .option("-n, --name <name>", "The name of the new project")
      .action(async (options) => {
        await handleTelemetry(async () => {
          await printStandloneInitialBanner(true, options.profile);
          await projectsCreateCommand(options);
        });
      })
  );
}

async function projectsCreateCommand(options: unknown) {
  return await wrapCommandAction(
    "projectsCreateCommand",
    ProjectsCreateCommandOptions,
    options,
    async (opts) => await createProject(opts)
  );
}

async function createProject(options: ProjectsCreateCommandOptions) {
  intro("Creating a new project");

  const apiClient = await getPatApiClient(options);

  const org = options.org ?? (await promptForOrg(apiClient));
  const name = options.name ?? (await promptForName());

  const response = await apiClient.createProject(org, { name });

  if (!response.success) {
    throw new Error(`Failed to create project: ${response.error}`);
  }

  outro(`Created project ${response.data.name} (${response.data.externalRef})`);
}

async function promptForOrg(apiClient: CliApiClient) {
  const orgs = await apiClient.getOrgs();

  if (!orgs.success) {
    throw new Error(`Failed to list organizations: ${orgs.error}`);
  }

  if (orgs.data.length === 0) {
    throw new Error(
      "You don't belong to any organizations yet. Create one in the dashboard first."
    );
  }

  if (orgs.data.length === 1) {
    return orgs.data[0]!.slug;
  }

  const selected = await select({
    message: "Select an organization",
    options: orgs.data.map((org) => ({ value: org.slug, label: org.title })),
  });

  if (isCancel(selected)) {
    throw new OutroCommandError();
  }

  return selected;
}

async function promptForName() {
  const name = await text({
    message: "What should the project be called?",
    validate: (value) => (value.trim().length === 0 ? "Please enter a name" : undefined),
  });

  if (isCancel(name)) {
    throw new OutroCommandError();
  }

  return name;
}
