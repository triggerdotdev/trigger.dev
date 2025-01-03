import { Command } from "commander";
import { printStandloneInitialBanner } from "../../utilities/initialBanner.js";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../../cli/common.js";
import { login } from "../login.js";
import { loadConfig } from "../../config.js";
import { resolve } from "path";
import { getProjectClient } from "../../utilities/session.js";
import { logger } from "../../utilities/logger.js";
import { z } from "zod";
import { intro } from "@clack/prompts";

const WorkersListCommandOptions = CommonCommandOptions.extend({
  env: z.enum(["prod", "staging"]),
  config: z.string().optional(),
  projectRef: z.string().optional(),
});
type WorkersListCommandOptions = z.infer<typeof WorkersListCommandOptions>;

export function configureWorkersListCommand(program: Command) {
  return commonOptions(
    program
      .command("list")
      .description("List all available workers")
      .argument("[path]", "The path to the project", ".")
      .option(
        "-e, --env <env>",
        "Deploy to a specific environment (currently only prod and staging are supported)",
        "prod"
      )
      .option("-c, --config <config file>", "The name of the config file, found at [path]")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file. This will override the project specified in the config file."
      )
      .action(async (path, options) => {
        await handleTelemetry(async () => {
          await printStandloneInitialBanner(true);
          await workersListCommand(path, options);
        });
      })
  );
}

async function workersListCommand(dir: string, options: unknown) {
  return await wrapCommandAction(
    "workerListCommand",
    WorkersListCommandOptions,
    options,
    async (opts) => {
      return await _workersListCommand(dir, opts);
    }
  );
}

async function _workersListCommand(dir: string, options: WorkersListCommandOptions) {
  intro("Listing workers");

  const authorization = await login({
    embedded: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
    silent: true,
  });

  if (!authorization.ok) {
    if (authorization.error === "fetch failed") {
      throw new Error(
        `Failed to connect to ${authorization.auth?.apiUrl}. Are you sure it's the correct URL?`
      );
    } else {
      throw new Error(
        `You must login first. Use the \`login\` CLI command.\n\n${authorization.error}`
      );
    }
  }

  const projectPath = resolve(process.cwd(), dir);

  const resolvedConfig = await loadConfig({
    cwd: projectPath,
    overrides: { project: options.projectRef },
    configFile: options.config,
  });

  logger.debug("Resolved config", resolvedConfig);

  const projectClient = await getProjectClient({
    accessToken: authorization.auth.accessToken,
    apiUrl: authorization.auth.apiUrl,
    projectRef: resolvedConfig.project,
    env: options.env,
    profile: options.profile,
  });

  if (!projectClient) {
    throw new Error("Failed to get project client");
  }

  const workers = await projectClient.client.workers.list();

  if (!workers.success) {
    throw new Error(`Failed to list workers: ${workers.error}`);
  }

  logger.table(
    workers.data.map((worker) => ({
      default: worker.isDefault ? "x" : "-",
      type: worker.type,
      name: worker.name,
      description: worker.description ?? "-",
      "updated at": worker.updatedAt.toLocaleString(),
    }))
  );
}
