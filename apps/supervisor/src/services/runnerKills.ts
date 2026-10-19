import type { V1Pod } from "@kubernetes/client-node";
import type { TaskRunExecutionStatus } from "@trigger.dev/core/v3";
import type { SupervisorHttpClient } from "@trigger.dev/core/v3/workers";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import type { Registry } from "prom-client";
import { Counter } from "prom-client";
import { attemptOfRunnerId } from "../util.js";

export type RunnerKillCode = "TASK_PROCESS_OOM_KILLED" | "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE";

/** A runner the runtime killed, with the error its run fails with. */
export type RunnerKill = {
  code: RunnerKillCode;
  /** The run the runner was created for. */
  runFriendlyId: string;
  environmentId: string;
  killedAt: Date;
  /**
   * Whether `killedAt` is only when the failure was observed (a Runner's Failed condition), so it
   * can postdate a retry that started elsewhere, rather than when the process died (a pod's).
   */
  killedAtObserved?: boolean;
};

const SIGKILL_EXIT_CODE = 137;

// Fixed per code so nothing from the runtime reaches users, and without "SIGKILL", which the
// error enhancer would read back as a possible OOM.
const KILL_MESSAGES: Record<RunnerKillCode, string> = {
  TASK_PROCESS_OOM_KILLED: "The run's process ran out of memory and was killed.",
  TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE:
    "Your run's process was stopped by a kill signal before it finished. It did not run out of memory, and it will be retried based on your task's retry settings and the number of retries remaining.",
};

const EXECUTING_STATUSES: TaskRunExecutionStatus[] = ["EXECUTING", "EXECUTING_WITH_WAITPOINTS"];

/**
 * The error for the runtime's account of a runner's end, if it was a kill worth reporting. Only
 * the runtime knows whether a SIGKILL was the OOM killer, so the exit code alone never reads as one.
 */
export function killCode(
  reason: string | undefined,
  exitCode: number | undefined
): RunnerKillCode | undefined {
  if (reason === "OOMKilled") {
    return "TASK_PROCESS_OOM_KILLED";
  }
  if (exitCode === SIGKILL_EXIT_CODE) {
    return "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE";
  }
  return undefined;
}

/** The run-controller container's kill, from a failed pod's status. */
export function podKill(pod: V1Pod): RunnerKill | undefined {
  const container = pod.spec?.containers?.find((c) => c.name === "run-controller");
  const terminated = pod.status?.containerStatuses?.find((c) => c.name === "run-controller")?.state
    ?.terminated;
  const code = terminated && killCode(terminated.reason, terminated.exitCode);
  const env = (name: string) => container?.env?.find((e) => e.name === name)?.value;
  const runFriendlyId = env("TRIGGER_RUN_ID");
  const environmentId = env("TRIGGER_ENV_ID");
  if (!code || !runFriendlyId || !environmentId || !terminated.finishedAt) {
    return undefined;
  }
  return { code, runFriendlyId, environmentId, killedAt: new Date(terminated.finishedAt) };
}

type RunnerKillOutcome = "applied" | "not_executing" | "error";

/**
 * Fails the run a killed runner was executing through the attempt completion route, so it fails
 * with the runtime's reason instead of waiting out the heartbeat timeout. Only the runner's own
 * run is covered: a warm-started runner has moved on from it, and its run is left to the timeout.
 */
export class RunnerKillReporter {
  private readonly logger = new SimpleStructuredLogger("runner-kill-reporter");
  private readonly reportsTotal: Counter;

  constructor(
    private readonly opts: {
      /** Read on each report, since the worker session is created after the reporter. */
      client: () => Pick<SupervisorHttpClient, "getLatestSnapshot" | "completeRunAttempt">;
      register: Registry;
    }
  ) {
    this.reportsTotal = new Counter({
      name: "runner_kill_reports_total",
      help: "Runners the runtime killed, by whether their run's attempt was failed",
      labelNames: ["oom", "outcome"],
      registers: [opts.register],
    });
  }

  async onRunnerKilled(runnerId: string, kill: RunnerKill): Promise<RunnerKillOutcome> {
    const outcome = await this.report(runnerId, kill);
    this.reportsTotal.inc({ oom: String(kill.code === "TASK_PROCESS_OOM_KILLED"), outcome });
    return outcome;
  }

  private async report(runnerId: string, kill: RunnerKill): Promise<RunnerKillOutcome> {
    const fields = { runnerId, runFriendlyId: kill.runFriendlyId, code: kill.code };
    try {
      const latest = await this.opts
        .client()
        .getLatestSnapshot(kill.runFriendlyId, runnerId, kill.environmentId);
      if (!latest.success) {
        this.logger.warn("Runner kill not reported, no latest snapshot", {
          ...fields,
          error: latest.error,
        });
        return "error";
      }

      // A snapshot written after the kill means the run moved on, e.g. restored on another runner.
      // A cold start's runner names its attempt, so a later attempt (a retry elsewhere) is also
      // moved on, whatever the timestamps say. Without that, an observed kill time can postdate a
      // retry that already started, so only a pod's exact kill time is trusted on its own.
      const { snapshot, run } = latest.data.execution;
      const attempt = attemptOfRunnerId(runnerId, kill.runFriendlyId);
      if (
        !EXECUTING_STATUSES.includes(snapshot.executionStatus) ||
        snapshot.createdAt.getTime() > kill.killedAt.getTime() ||
        (attempt !== undefined ? run.attemptNumber !== attempt : kill.killedAtObserved)
      ) {
        this.logger.debug("Runner kill not reported, the run is not executing on it", {
          ...fields,
          executionStatus: snapshot.executionStatus,
        });
        return "not_executing";
      }

      const completed = await this.opts.client().completeRunAttempt(
        kill.runFriendlyId,
        snapshot.friendlyId,
        {
          completion: {
            ok: false,
            id: kill.runFriendlyId,
            error: { type: "INTERNAL_ERROR", code: kill.code, message: KILL_MESSAGES[kill.code] },
          },
          // The runner is dead, so a retry must go to a new one, never immediately back to it.
          forceRequeue: true,
        },
        runnerId,
        kill.environmentId
      );
      if (!completed.success) {
        this.logger.warn("Runner kill not reported, completing the attempt failed", {
          ...fields,
          error: completed.error,
          statusCode: completed.statusCode,
        });
        return "error";
      }

      this.logger.info("Runner kill reported", fields);
      return "applied";
    } catch (error) {
      this.logger.warn("Runner kill report failed", { ...fields, error });
      return "error";
    }
  }
}
