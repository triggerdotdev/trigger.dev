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

const EventsHistoryOptions = CommonCommandOptions.extend({
  config: z.string().optional(),
  projectRef: z.string().optional(),
  envFile: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().optional(),
  cursor: z.string().optional(),
});

type EventsHistoryOptions = z.infer<typeof EventsHistoryOptions>;

export function configureEventsHistoryCommand(program: Command) {
  return commonOptions(
    program
      .command("history <eventId>")
      .description("Show publish history for an event type")
      .option("-c, --config <config file>", "The name of the config file")
      .option("-p, --project-ref <project ref>", "The project ref")
      .option("--env-file <env file>", "Path to the .env file")
      .option("--from <date>", "Start date (ISO 8601)")
      .option("--to <date>", "End date (ISO 8601)")
      .option("--limit <n>", "Max results (default 50, max 200)")
      .option("--cursor <cursor>", "Pagination cursor from previous response")
  ).action(async (eventId: string, options) => {
    await handleTelemetry(async () => {
      await printInitialBanner(false, options.profile);
      await eventsHistoryCommand({ ...options, eventId });
    });
  });
}

const EventsHistoryCommandInput = EventsHistoryOptions.extend({
  eventId: z.string(),
});

type EventsHistoryCommandInput = z.infer<typeof EventsHistoryCommandInput>;

async function eventsHistoryCommand(options: unknown) {
  return await wrapCommandAction(
    "eventsHistoryCommand",
    EventsHistoryCommandInput,
    options,
    async (opts) => {
      return await _eventsHistoryCommand(opts);
    }
  );
}

async function _eventsHistoryCommand(options: EventsHistoryCommandInput) {
  intro(`Event history for "${options.eventId}"`);

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
  loadingSpinner.start("Fetching event history...");

  const apiClient = new CliApiClient(authentication.auth.apiUrl, authentication.auth.accessToken);
  const result = await apiClient.getEventHistory(resolvedConfig.project, options.eventId, {
    from: options.from,
    to: options.to,
    limit: options.limit,
    cursor: options.cursor,
  });

  if (!result.success) {
    loadingSpinner.stop("Failed to fetch event history");
    logger.error(result.error);
    return;
  }

  const { data, pagination } = result.data;
  loadingSpinner.stop(`Found ${data.length} event(s)`);

  if (data.length === 0) {
    outro("No events found for the given criteria.");
    return;
  }

  logger.table(
    data.map((evt) => ({
      published: evt.publishedAt,
      eventId: evt.eventId,
      fanOut: String(evt.fanOutCount),
      idempotencyKey: evt.idempotencyKey ?? "-",
      tags: evt.tags?.join(", ") ?? "-",
    }))
  );

  if (pagination.hasMore && pagination.cursor) {
    logger.info(`\nMore results available. Use --cursor ${pagination.cursor} to see next page.`);
  }
}
