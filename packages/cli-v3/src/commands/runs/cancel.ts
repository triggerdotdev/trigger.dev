import { intro, outro } from "@clack/prompts";
import type { Command } from "commander";
import { z } from "zod";
import { commonOptions, handleTelemetry, wrapCommandAction } from "../../cli/common.js";
import { printInitialBanner } from "../../utilities/initialBanner.js";
import { formatEnvInfo, resolveRunsClient, RunsCommonOptions, runsOptions } from "./common.js";

const RunsCancelCommandOptions = RunsCommonOptions.extend({
  runId: z.string(),
});

type RunsCancelCommandOptions = z.infer<typeof RunsCancelCommandOptions>;

export function configureRunsCancelCommand(program: Command) {
  return commonOptions(
    runsOptions(
      program
        .command("cancel")
        .description("Cancel a run that hasn't finished yet")
        .argument("<run id>", "The run ID, starting with run_")
    ).action(async (runId, options) => {
      await handleTelemetry(async () => {
        await printInitialBanner(false, options.profile);
        await runsCancelCommand({ ...options, runId });
      });
    })
  );
}

async function runsCancelCommand(options: unknown) {
  return await wrapCommandAction(
    "runsCancelCommand",
    RunsCancelCommandOptions,
    options,
    async (opts) => await cancelRun(opts)
  );
}

async function cancelRun(options: RunsCancelCommandOptions) {
  intro(`Cancelling run ${options.runId}`);

  const { apiClient, projectRef, env, branch } = await resolveRunsClient(options);

  await apiClient.cancelRun(options.runId);

  const run = await apiClient.retrieveRun(options.runId);

  outro(
    `Cancelled ${run.id} (${run.status}) | Project: ${projectRef} | Environment: ${formatEnvInfo(env, branch)}`
  );
}
