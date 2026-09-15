import { intro, outro } from "@clack/prompts";
import type { Command } from "commander";
import { z } from "zod";
import { commonOptions, handleTelemetry, wrapCommandAction } from "../../cli/common.js";
import { printInitialBanner } from "../../utilities/initialBanner.js";
import { formatEnvInfo, resolveRunsClient, RunsCommonOptions, runsOptions } from "./common.js";

const RunsReplayCommandOptions = RunsCommonOptions.extend({
  runId: z.string(),
});

type RunsReplayCommandOptions = z.infer<typeof RunsReplayCommandOptions>;

export function configureRunsReplayCommand(program: Command) {
  return commonOptions(
    runsOptions(
      program
        .command("replay")
        .description("Replay a run with the same payload, using the latest version")
        .argument("<run id>", "The run ID, starting with run_")
    ).action(async (runId, options) => {
      await handleTelemetry(async () => {
        await printInitialBanner(false, options.profile);
        await runsReplayCommand({ ...options, runId });
      });
    })
  );
}

async function runsReplayCommand(options: unknown) {
  return await wrapCommandAction(
    "runsReplayCommand",
    RunsReplayCommandOptions,
    options,
    async (opts) => await replayRun(opts)
  );
}

async function replayRun(options: RunsReplayCommandOptions) {
  intro(`Replaying run ${options.runId}`);

  const { apiClient, projectRef, env, branch } = await resolveRunsClient(options);

  const replayed = await apiClient.replayRun(options.runId);

  outro(
    `Replayed as ${replayed.id} | Project: ${projectRef} | Environment: ${formatEnvInfo(env, branch)}`
  );
}
