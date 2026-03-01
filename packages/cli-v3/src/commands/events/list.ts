import { Command } from "commander";
import { z } from "zod";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../../cli/common.js";
import { printInitialBanner } from "../../utilities/initialBanner.js";
import { isLoggedIn } from "../../utilities/session.js";
import { loadConfig } from "../../config.js";
import { resolveLocalEnvVars } from "../../utilities/localEnvVars.js";
import { CliApiClient } from "../../apiClient.js";
import { intro, outro } from "@clack/prompts";
import { spinner } from "../../utilities/windows.js";
import { logger } from "../../utilities/logger.js";
import { tryCatch } from "@trigger.dev/core";

const EventsListOptions = CommonCommandOptions.extend({
  config: z.string().optional(),
  projectRef: z.string().optional(),
  envFile: z.string().optional(),
});

type EventsListOptions = z.infer<typeof EventsListOptions>;

export function configureEventsListCommand(program: Command) {
  return commonOptions(
    program
      .command("list")
      .description("List all event definitions in the project")
      .option("-c, --config <config file>", "The name of the config file")
      .option("-p, --project-ref <project ref>", "The project ref")
      .option("--env-file <env file>", "Path to the .env file")
  ).action(async (options) => {
    await handleTelemetry(async () => {
      await printInitialBanner(false, options.profile);
      await eventsListCommand(options);
    });
  });
}

async function eventsListCommand(options: unknown) {
  return await wrapCommandAction(
    "eventsListCommand",
    EventsListOptions,
    options,
    async (opts) => {
      return await _eventsListCommand(opts);
    }
  );
}

async function _eventsListCommand(options: EventsListOptions) {
  intro("Listing event definitions");

  const envVars = resolveLocalEnvVars(options.envFile);

  const authentication = await isLoggedIn(options.profile);
  if (!authentication.ok) {
    outro(`Not logged in. Use \`trigger login\` first.`);
    return;
  }

  const [configError, resolvedConfig] = await tryCatch(
    loadConfig({
      overrides: { project: options.projectRef ?? envVars.TRIGGER_PROJECT_REF },
      configFile: options.config,
      warn: false,
    })
  );

  if (configError || !resolvedConfig?.project) {
    outro("Could not resolve project. Use --project-ref or configure trigger.config.ts.");
    return;
  }

  const loadingSpinner = spinner();
  loadingSpinner.start("Fetching events...");

  const apiClient = new CliApiClient(authentication.auth.apiUrl, authentication.auth.accessToken);
  const result = await apiClient.listEvents(resolvedConfig.project);

  if (!result.success) {
    loadingSpinner.stop("Failed to fetch events");
    logger.error(result.error);
    return;
  }

  loadingSpinner.stop(`Found ${result.data.data.length} event(s)`);

  if (result.data.data.length === 0) {
    outro("No events defined yet. Define events with `event()` in your task files.");
    return;
  }

  logger.table(
    result.data.data.map((evt) => ({
      id: evt.slug,
      version: evt.version,
      subscribers: String(evt.subscriberCount),
      schema: evt.hasSchema ? "yes" : "no",
    }))
  );
}
