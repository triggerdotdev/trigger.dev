import { intro, note, outro } from "@clack/prompts";
import type { Command } from "commander";
import { z } from "zod";
import { commonOptions, handleTelemetry, wrapCommandAction } from "../../cli/common.js";
import { printInitialBanner } from "../../utilities/initialBanner.js";
import { formatEnvInfo, resolveRunsClient, RunsCommonOptions, runsOptions } from "./common.js";

const RunsGetCommandOptions = RunsCommonOptions.extend({
  runId: z.string(),
});

type RunsGetCommandOptions = z.infer<typeof RunsGetCommandOptions>;

export function configureRunsGetCommand(program: Command) {
  return commonOptions(
    runsOptions(
      program
        .command("get")
        .description("Show the details of a run")
        .argument("<run id>", "The run ID, starting with run_")
    ).action(async (runId, options) => {
      await handleTelemetry(async () => {
        await printInitialBanner(false, options.profile);
        await runsGetCommand({ ...options, runId });
      });
    })
  );
}

async function runsGetCommand(options: unknown) {
  return await wrapCommandAction(
    "runsGetCommand",
    RunsGetCommandOptions,
    options,
    async (opts) => await getRun(opts)
  );
}

async function getRun(options: RunsGetCommandOptions) {
  intro(`Getting run ${options.runId}`);

  const { apiClient, projectRef, env, branch } = await resolveRunsClient(options);

  const run = await apiClient.retrieveRun(options.runId);

  note(
    `ID:       ${run.id}
Task:     ${run.taskIdentifier}
Status:   ${run.status}
Version:  ${run.version ?? "-"}
Test:     ${run.isTest ? "yes" : "no"}
Tags:     ${run.tags.length > 0 ? run.tags.join(", ") : "-"}
Created:  ${run.createdAt.toLocaleString()}
Started:  ${run.startedAt?.toLocaleString() ?? "-"}
Finished: ${run.finishedAt?.toLocaleString() ?? "-"}
Duration: ${run.durationMs > 0 ? `${(run.durationMs / 1000).toFixed(2)}s` : "-"}
Cost:     $${((run.costInCents + run.baseCostInCents) / 100).toFixed(4)}
Error:    ${run.error ? `${run.error.name ? `${run.error.name}: ` : ""}${run.error.message}` : "-"}`,
    "Run details"
  );

  outro(`Project: ${projectRef} | Environment: ${formatEnvInfo(env, branch)}`);
}
