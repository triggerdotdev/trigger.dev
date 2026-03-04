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

const EventsReplayOptions = CommonCommandOptions.extend({
  config: z.string().optional(),
  projectRef: z.string().optional(),
  envFile: z.string().optional(),
  from: z.string(),
  to: z.string(),
  tasks: z.string().optional(),
  dryRun: z.boolean().optional(),
});

type EventsReplayOptions = z.infer<typeof EventsReplayOptions>;

export function configureEventsReplayCommand(program: Command) {
  return commonOptions(
    program
      .command("replay <eventId>")
      .description("Replay historical events to re-trigger subscriber runs")
      .requiredOption("--from <date>", "Start date (ISO 8601)")
      .requiredOption("--to <date>", "End date (ISO 8601)")
      .option("-c, --config <config file>", "The name of the config file")
      .option("-p, --project-ref <project ref>", "The project ref")
      .option("--env-file <env file>", "Path to the .env file")
      .option("--tasks <tasks>", "Comma-separated task slugs to replay to (default: all)")
      .option("--dry-run", "Preview replay without triggering runs")
  ).action(async (eventId: string, options) => {
    await handleTelemetry(async () => {
      await printInitialBanner(false, options.profile);
      await eventsReplayCommand({ ...options, eventId });
    });
  });
}

const EventsReplayCommandInput = EventsReplayOptions.extend({
  eventId: z.string(),
});

type EventsReplayCommandInput = z.infer<typeof EventsReplayCommandInput>;

async function eventsReplayCommand(options: unknown) {
  return await wrapCommandAction(
    "eventsReplayCommand",
    EventsReplayCommandInput,
    options,
    async (opts) => {
      return await _eventsReplayCommand(opts);
    }
  );
}

async function _eventsReplayCommand(options: EventsReplayCommandInput) {
  intro(`Replaying events for "${options.eventId}"`);

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
  loadingSpinner.start(options.dryRun ? "Running dry-run replay..." : "Replaying events...");

  const apiClient = new CliApiClient(authentication.auth.apiUrl, authentication.auth.accessToken);
  const result = await apiClient.replayEvents(resolvedConfig.project, options.eventId, {
    from: options.from,
    to: options.to,
    tasks: options.tasks ? options.tasks.split(",").map((t: string) => t.trim()) : undefined,
    dryRun: options.dryRun,
  });

  if (!result.success) {
    loadingSpinner.stop("Failed to replay events");
    logger.error(result.error);
    return;
  }

  const { replayedCount, skippedCount, dryRun, runs } = result.data;
  loadingSpinner.stop(dryRun ? "Dry run complete" : "Replay complete");

  logger.info(`Replayed: ${replayedCount}, Skipped: ${skippedCount}${dryRun ? " (dry run)" : ""}`);

  if (runs && runs.length > 0) {
    logger.table(
      runs.map((run) => ({
        task: run.taskIdentifier,
        runId: run.runId,
        sourceEvent: run.sourceEventId,
      }))
    );
  }
}
