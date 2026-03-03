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

const EventsPublishOptions = CommonCommandOptions.extend({
  config: z.string().optional(),
  projectRef: z.string().optional(),
  envFile: z.string().optional(),
  payload: z.string(),
  delay: z.string().optional(),
  tags: z.string().optional(),
  idempotencyKey: z.string().optional(),
  orderingKey: z.string().optional(),
});

type EventsPublishOptions = z.infer<typeof EventsPublishOptions>;

export function configureEventsPublishCommand(program: Command) {
  return commonOptions(
    program
      .command("publish <eventId>")
      .description("Publish an event with a JSON payload")
      .requiredOption("--payload <json>", "JSON payload to publish")
      .option("-c, --config <config file>", "The name of the config file")
      .option("-p, --project-ref <project ref>", "The project ref")
      .option("--env-file <env file>", "Path to the .env file")
      .option("--delay <delay>", "Delay before execution (e.g. '30s', '5m', ISO date)")
      .option("--tags <tags>", "Comma-separated tags to attach")
      .option("--idempotency-key <key>", "Idempotency key for deduplication")
      .option("--ordering-key <key>", "Ordering key for sequential processing")
  ).action(async (eventId: string, options) => {
    await handleTelemetry(async () => {
      await printInitialBanner(false, options.profile);
      await eventsPublishCommand({ ...options, eventId });
    });
  });
}

const EventsPublishCommandInput = EventsPublishOptions.extend({
  eventId: z.string(),
});

type EventsPublishCommandInput = z.infer<typeof EventsPublishCommandInput>;

async function eventsPublishCommand(options: unknown) {
  return await wrapCommandAction(
    "eventsPublishCommand",
    EventsPublishCommandInput,
    options,
    async (opts) => {
      return await _eventsPublishCommand(opts);
    }
  );
}

async function _eventsPublishCommand(options: EventsPublishCommandInput) {
  intro(`Publishing event "${options.eventId}"`);

  // Parse JSON payload
  let payload: unknown;
  try {
    payload = JSON.parse(options.payload);
  } catch {
    outro("Invalid JSON payload. Provide valid JSON with --payload.");
    return;
  }

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
  loadingSpinner.start("Publishing event...");

  const apiClient = new CliApiClient(authentication.auth.apiUrl, authentication.auth.accessToken);
  const publishOptions = {
    idempotencyKey: options.idempotencyKey,
    delay: options.delay,
    tags: options.tags ? options.tags.split(",").map((t: string) => t.trim()) : undefined,
    orderingKey: options.orderingKey,
  };
  const hasOptions = Object.values(publishOptions).some((v) => v !== undefined);
  const result = await apiClient.publishEvent(
    resolvedConfig.project,
    options.eventId,
    payload,
    hasOptions ? publishOptions : undefined
  );

  if (!result.success) {
    loadingSpinner.stop("Failed to publish event");
    logger.error(result.error);
    return;
  }

  loadingSpinner.stop("Event published");

  logger.info(`Event ID: ${result.data.eventId}`);
  logger.info(`Triggered ${result.data.runs.length} run(s)`);

  if (result.data.runs.length > 0) {
    logger.table(
      result.data.runs.map((run) => ({
        task: run.taskIdentifier,
        runId: run.runId,
      }))
    );
  }
}
