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

// --- dlq list ---

const DlqListOptions = CommonCommandOptions.extend({
  config: z.string().optional(),
  projectRef: z.string().optional(),
  envFile: z.string().optional(),
  eventType: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().optional(),
  cursor: z.string().optional(),
});

type DlqListOptions = z.infer<typeof DlqListOptions>;

function configureDlqListCommand(program: Command) {
  return commonOptions(
    program
      .command("list")
      .description("List dead letter queue entries")
      .option("-c, --config <config file>", "The name of the config file")
      .option("-p, --project-ref <project ref>", "The project ref")
      .option("--env-file <env file>", "Path to the .env file")
      .option("--event-type <type>", "Filter by event type")
      .option("--status <status>", "Filter by status (PENDING, RETRIED, DISCARDED)")
      .option("--limit <n>", "Max results (default 50, max 200)")
      .option("--cursor <cursor>", "Pagination cursor from previous response")
  ).action(async (options) => {
    await handleTelemetry(async () => {
      await printInitialBanner(false, options.profile);
      await dlqListCommand(options);
    });
  });
}

async function dlqListCommand(options: unknown) {
  return await wrapCommandAction("dlqListCommand", DlqListOptions, options, async (opts) => {
    return await _dlqListCommand(opts);
  });
}

async function _dlqListCommand(options: DlqListOptions) {
  intro("Dead letter queue");

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
  loadingSpinner.start("Fetching DLQ entries...");

  const apiClient = new CliApiClient(authentication.auth.apiUrl, authentication.auth.accessToken);
  const result = await apiClient.listDeadLetterEvents(resolvedConfig.project, {
    eventType: options.eventType,
    status: options.status,
    limit: options.limit,
    cursor: options.cursor,
  });

  if (!result.success) {
    loadingSpinner.stop("Failed to fetch DLQ entries");
    logger.error(result.error);
    return;
  }

  const { data, pagination } = result.data;
  loadingSpinner.stop(`Found ${data.length} DLQ entry/entries`);

  if (data.length === 0) {
    outro("No dead letter entries found.");
    return;
  }

  logger.table(
    data.map((entry) => ({
      id: entry.friendlyId,
      eventType: entry.eventType,
      task: entry.taskSlug,
      status: entry.status,
      attempts: String(entry.attemptCount),
      created: entry.createdAt,
    }))
  );

  if (pagination.hasMore && pagination.cursor) {
    logger.info(`\nMore results available. Use --cursor ${pagination.cursor} to see next page.`);
  }
}

// --- dlq retry ---

const DlqRetryOptions = CommonCommandOptions.extend({
  config: z.string().optional(),
  projectRef: z.string().optional(),
  envFile: z.string().optional(),
});

type DlqRetryOptions = z.infer<typeof DlqRetryOptions>;

function configureDlqRetryCommand(program: Command) {
  return commonOptions(
    program
      .command("retry <id>")
      .description("Retry a dead letter queue entry")
      .option("-c, --config <config file>", "The name of the config file")
      .option("-p, --project-ref <project ref>", "The project ref")
      .option("--env-file <env file>", "Path to the .env file")
  ).action(async (id: string, options) => {
    await handleTelemetry(async () => {
      await printInitialBanner(false, options.profile);
      await dlqRetryCommand({ ...options, id });
    });
  });
}

const DlqRetryCommandInput = DlqRetryOptions.extend({
  id: z.string(),
});

type DlqRetryCommandInput = z.infer<typeof DlqRetryCommandInput>;

async function dlqRetryCommand(options: unknown) {
  return await wrapCommandAction(
    "dlqRetryCommand",
    DlqRetryCommandInput,
    options,
    async (opts) => {
      return await _dlqRetryCommand(opts);
    }
  );
}

async function _dlqRetryCommand(options: DlqRetryCommandInput) {
  intro(`Retrying DLQ entry "${options.id}"`);

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
  loadingSpinner.start("Retrying dead letter event...");

  const apiClient = new CliApiClient(authentication.auth.apiUrl, authentication.auth.accessToken);
  const result = await apiClient.retryDeadLetterEvent(resolvedConfig.project, options.id);

  if (!result.success) {
    loadingSpinner.stop("Failed to retry DLQ entry");
    logger.error(result.error);
    return;
  }

  loadingSpinner.stop("DLQ entry retried successfully");

  logger.info(`Status: ${result.data.status}`);
  if (result.data.runId) {
    logger.info(`New run ID: ${result.data.runId}`);
  }
}

// --- Main export ---

export function configureEventsDlqCommand(program: Command) {
  const dlq = program.command("dlq").description("Manage the dead letter queue");

  configureDlqListCommand(dlq);
  configureDlqRetryCommand(dlq);

  return dlq;
}
