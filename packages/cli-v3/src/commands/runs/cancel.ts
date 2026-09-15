import { confirm, intro, isCancel, outro } from "@clack/prompts";
import type { Command } from "commander";
import { z } from "zod";
import {
  commonOptions,
  handleTelemetry,
  OutroCommandError,
  wrapCommandAction,
} from "../../cli/common.js";
import { printInitialBanner } from "../../utilities/initialBanner.js";
import { formatEnvInfo, resolveRunsClient, RunsCommonOptions, runsOptions } from "./common.js";

const RunsCancelCommandOptions = RunsCommonOptions.extend({
  runId: z.string(),
  yes: z.boolean().default(false),
});

type RunsCancelCommandOptions = z.infer<typeof RunsCancelCommandOptions>;

export function configureRunsCancelCommand(program: Command) {
  return commonOptions(
    runsOptions(
      program
        .command("cancel")
        .description("Cancel a run that hasn't finished yet")
        .argument("<run id>", "The run ID, starting with run_")
        .option("-y, --yes", "Skip the confirmation prompt")
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
  const run = await apiClient.retrieveRun(options.runId);

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      throw new Error(
        "Interactive prompts cannot be used in non-TTY environments. Pass --yes to cancel without confirming."
      );
    }

    const shouldCancel = await confirm({
      message: `Cancel ${run.id} (${run.taskIdentifier}, ${run.status})?`,
      initialValue: false,
    });

    if (isCancel(shouldCancel) || !shouldCancel) {
      throw new OutroCommandError("Aborted");
    }
  }

  await apiClient.cancelRun(options.runId);

  const cancelled = await apiClient.retrieveRun(options.runId);

  outro(
    `Cancelled ${cancelled.id} (${cancelled.status}) | Project: ${projectRef} | Environment: ${formatEnvInfo(env, branch)}`
  );
}
