import { intro, outro } from "@clack/prompts";
import { Command } from "commander";
import { z } from "zod";
import { CommonCommandOptions, handleTelemetry, wrapCommandAction } from "../cli/common.js";
import { printInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { resolve } from "path";
import { loadConfig } from "../config.js";
import { getProjectClient } from "../utilities/session.js";
import { login } from "./login.js";
import { chalkGrey, chalkLink, cliLink } from "../utilities/cliOutput.js";

const TriggerTaskOptions = CommonCommandOptions.extend({
  env: z.enum(["prod", "staging"]),
  config: z.string().optional(),
  projectRef: z.string().optional(),
});

type TriggerTaskOptions = z.infer<typeof TriggerTaskOptions>;

export function configureTriggerTaskCommand(program: Command) {
  return program
    .command("trigger")
    .description("Trigger a task")
    .argument("[task-name]", "The name of the task")
    .option(
      "-l, --log-level <level>",
      "The CLI log level to use (debug, info, log, warn, error, none). This does not effect the log level of your trigger.dev tasks.",
      "log"
    )
    .option("--skip-telemetry", "Opt-out of sending telemetry")
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
        await triggerTaskCommand(path, options);
      });
    });
}

export async function triggerTaskCommand(taskName: string, options: unknown) {
  return await wrapCommandAction("trigger", TriggerTaskOptions, options, async (opts) => {
    await printInitialBanner(false, opts.profile);
    return await triggerTask(taskName, opts);
  });
}

export async function triggerTask(taskName: string, options: TriggerTaskOptions) {
  if (!taskName) {
    throw new Error("You must provide a task name");
  }

  intro(`Triggering task ${taskName}`);

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

  const projectPath = resolve(process.cwd(), ".");

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

  const triggered = await projectClient.client.triggerTaskRun(taskName, {
    payload: {
      message: "Triggered by CLI",
    },
  });

  if (!triggered.success) {
    throw new Error("Failed to trigger task");
  }

  const baseUrl = `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}`;
  const runUrl = `${baseUrl}/runs/${triggered.data.id}`;

  const pipe = chalkGrey("|");
  const link = chalkLink(cliLink("View run", runUrl));

  outro(`Success! ${pipe} ${link}`);
}
