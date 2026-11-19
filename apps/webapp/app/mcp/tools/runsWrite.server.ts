import type { TaskRun } from "@trigger.dev/database";
import { EngineServiceValidationError } from "@internal/run-engine";
import { CURRENT_API_VERSION } from "~/api/versions";
import { prisma } from "~/db.server";
import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { MCP_REMOTE_TRIGGER_SOURCE } from "~/utils/triggerSource";
import { runStore } from "~/v3/runStore.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import type { McpToolDefinition } from "../registry.server";
import { dashboardUrl, resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool, fencedError } from "./defineWrite.server";
import { CommonRunsInput } from "./schemas/common";
import { ReplayRunInput } from "./schemas/write";

type CancelOutcome = "canceled" | "not_found" | "timed_out";

export type RunsWriteOptions = {
  cancelRun?: (environment: AuthenticatedEnvironment, runId: string) => Promise<CancelOutcome>;
  replayRun?: (
    taskRun: TaskRun,
    overrides: Omit<
      ReplayRunInput,
      "runId" | "projectRef" | "configPath" | "environment" | "branch"
    >,
    triggerSource: string
  ) => Promise<{ id: string } | null>;
};

const defaultCancelRun: NonNullable<RunsWriteOptions["cancelRun"]> = async (environment, runId) => {
  const { mutateWithFallback } = await import("~/v3/mollifier/mutateWithFallback.server");
  const { CancelTaskRunService } = await import("~/v3/services/cancelTaskRun.server");
  const { env } = await import("~/env.server");

  const outcome = await mutateWithFallback({
    runId,
    environmentId: environment.id,
    organizationId: environment.organizationId,
    bufferPatch: {
      type: "mark_cancelled",
      cancelledAt: new Date().toISOString(),
      cancelReason: "Canceled by user",
    },
    pgMutation: async (taskRun) => {
      await new CancelTaskRunService().call(taskRun);
      return true;
    },
    synthesisedResponse: () => true,
    safetyNetMs: env.TRIGGER_MOLLIFIER_MUTATE_SAFETY_NET_MS,
    pollStepMs: env.TRIGGER_MOLLIFIER_MUTATE_POLL_STEP_MS,
    maxPollStepMs: env.TRIGGER_MOLLIFIER_MUTATE_MAX_POLL_STEP_MS,
    backoffFactor: env.TRIGGER_MOLLIFIER_MUTATE_BACKOFF_FACTOR,
  });

  return outcome.kind === "not_found" || outcome.kind === "timed_out" ? outcome.kind : "canceled";
};

const defaultReplayRun: NonNullable<RunsWriteOptions["replayRun"]> = async (
  taskRun,
  overrides,
  triggerSource
) => {
  const { ReplayTaskRunService } = await import("~/v3/services/replayTaskRun.server");

  const newRun = await new ReplayTaskRunService().call(taskRun, {
    triggerSource,
    payload: overrides.payload === undefined ? undefined : JSON.stringify(overrides.payload),
    payloadType: "application/json",
    metadata: overrides.metadata,
    tags: overrides.tags,
    queue: overrides.queue,
    concurrencyKey: overrides.concurrencyKey,
    machine: overrides.machine,
    version: overrides.version,
    region: overrides.region,
    delay: overrides.delay,
    ttl: overrides.ttl,
    idempotencyKey: overrides.idempotencyKey,
    maxAttempts: overrides.maxAttempts,
    maxDurationSeconds: overrides.maxDuration,
    prioritySeconds: overrides.priority,
  });
  return newRun ? { id: newRun.friendlyId } : null;
};

export function createRunsWriteTools(options: RunsWriteOptions = {}): McpToolDefinition[] {
  const cancelRun = options.cancelRun ?? defaultCancelRun;
  const replayRun = options.replayRun ?? defaultReplayRun;

  return [
    defineWriteTool({
      name: "cancel_run",
      title: "Cancel Run",
      description:
        "Cancel a run. The run ID is the ID of the run that was triggered. It starts with run_",
      shape: CommonRunsInput.shape,
      approval: "configurable",
      auth: { action: "write", subject: "runs" },
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return fencedError("Environment not found", "cancel-error");

        const outcome = await cancelRun(environment, input.runId);
        if (outcome === "not_found") return fencedError("Run not found", "cancel-error");
        if (outcome === "timed_out") {
          return fencedError("Run materialisation timed out", "cancel-error");
        }

        const found = await ApiRetrieveRunPresenter.findRun(input.runId, environment);
        const run = found
          ? await new ApiRetrieveRunPresenter(CURRENT_API_VERSION).call(found, environment)
          : undefined;

        return textResult(
          [
            `Run ${input.runId} canceled.`,
            ...(run ? [`Status: ${run.status}`, `Task: ${run.taskIdentifier}`] : []),
            `[View in dashboard](${dashboardUrl(`/projects/v3/${environment.project.externalRef}/runs/${input.runId}`)})`,
          ].join("\n")
        );
      },
    }),
    defineWriteTool({
      name: "replay_run",
      title: "Replay Run",
      description:
        "Replay a run: create a new run of the same task in the same environment, reusing the original run's payload, metadata, tags, queue, concurrency key and machine. Pass any of payload, metadata, tags, queue, concurrencyKey, machine, version, region, delay, ttl, idempotencyKey, maxAttempts, maxDuration or priority to override them for the new run. The run ID starts with run_",
      shape: ReplayRunInput.shape,
      approval: "configurable",
      auth: { action: "write", subject: "runs" },
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return fencedError("Environment not found", "replay-error");

        const { runId, projectRef, configPath, environment: _env, branch, ...overrides } = input;

        const taskRun = await runStore.findRun(
          { friendlyId: runId, runtimeEnvironmentId: environment.id },
          prisma
        );
        if (!taskRun) return fencedError("Run not found", "replay-error");

        const canTrigger = ctx.ability?.can("trigger", {
          type: "tasks",
          id: taskRun.taskIdentifier,
          envType: environment.type,
        });
        if (!canTrigger) {
          return fencedError(
            `Replaying this run needs permission to trigger the ${taskRun.taskIdentifier} task`,
            "replay-error"
          );
        }

        let replayed: { id: string } | null;
        try {
          replayed = await replayRun(taskRun, overrides, MCP_REMOTE_TRIGGER_SOURCE);
        } catch (error) {
          if (
            error instanceof ServiceValidationError ||
            error instanceof EngineServiceValidationError
          ) {
            return fencedError(error.message, "replay-error");
          }
          throw error;
        }
        if (!replayed) return fencedError("Run not found", "replay-error");

        return textResult(
          [
            `Run ${runId} replayed as ${replayed.id}.`,
            `[View in dashboard](${dashboardUrl(`/projects/v3/${environment.project.externalRef}/runs/${replayed.id}`)})`,
          ].join("\n")
        );
      },
    }),
  ];
}

export const runsWriteTools: McpToolDefinition[] = createRunsWriteTools();
