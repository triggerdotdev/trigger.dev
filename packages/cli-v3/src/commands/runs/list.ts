import { intro, log, outro } from "@clack/prompts";
import { RunStatus } from "@trigger.dev/core/v3";
import type { Command } from "commander";
import { z } from "zod";
import { commonOptions, handleTelemetry, wrapCommandAction } from "../../cli/common.js";
import { printInitialBanner } from "../../utilities/initialBanner.js";
import { logger } from "../../utilities/logger.js";
import { formatEnvInfo, resolveRunsClient, RunsCommonOptions, runsOptions } from "./common.js";

const RunsListCommandOptions = RunsCommonOptions.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: RunStatus.optional(),
  task: z.string().optional(),
  tag: z.string().optional(),
  cursor: z.string().optional(),
});

type RunsListCommandOptions = z.infer<typeof RunsListCommandOptions>;

export function configureRunsListCommand(program: Command) {
  return commonOptions(
    runsOptions(
      program
        .command("list")
        .description("List runs for your project")
        .option("--limit <limit>", "The number of runs to list, up to 100", "20")
        .option(
          "--status <status>",
          `Only show runs with this status (${RunStatus.options.join(", ")})`
        )
        .option("--task <task identifier>", "Only show runs for this task")
        .option("--tag <tag>", "Only show runs with this tag")
        .option("--cursor <cursor>", "The pagination cursor from a previous page")
    ).action(async (options) => {
      await handleTelemetry(async () => {
        await printInitialBanner(false, options.profile);
        await runsListCommand(options);
      });
    })
  );
}

async function runsListCommand(options: unknown) {
  return await wrapCommandAction(
    "runsListCommand",
    RunsListCommandOptions,
    options,
    async (opts) => await listRuns(opts)
  );
}

async function listRuns(options: RunsListCommandOptions) {
  intro("Listing runs");

  const { apiClient, projectRef, env, branch } = await resolveRunsClient(options);

  const page = await apiClient.listRuns({
    limit: options.limit,
    after: options.cursor,
    status: options.status,
    taskIdentifier: options.task,
    tag: options.tag,
  });

  if (page.data.length === 0) {
    outro(`No runs found | Project: ${projectRef} | Environment: ${formatEnvInfo(env, branch)}`);
    return;
  }

  logger.table(
    page.data.map((run) => ({
      id: run.id,
      task: run.taskIdentifier,
      status: run.status,
      version: run.version ?? "-",
      created: run.createdAt.toLocaleString(),
      duration: run.durationMs > 0 ? `${(run.durationMs / 1000).toFixed(2)}s` : "-",
    }))
  );

  if (page.pagination.next) {
    log.info(`Next page: --cursor ${page.pagination.next}`);
  }

  outro(
    `Found ${page.data.length} run${page.data.length === 1 ? "" : "s"} | Project: ${projectRef} | Environment: ${formatEnvInfo(env, branch)}`
  );
}
