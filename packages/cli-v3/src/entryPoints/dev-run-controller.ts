import {
  CompleteRunAttemptResult,
  DequeuedMessage,
  IntervalService,
  LogLevel,
  RunExecutionData,
  TaskRunExecution,
  TaskRunExecutionMetrics,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
} from "@trigger.dev/core/v3";
import { type WorkloadRunAttemptStartResponseBody } from "@trigger.dev/core/v3/workers";
import { setTimeout as sleep } from "timers/promises";
import { CliApiClient } from "../apiClient.js";
import { TaskRunProcess } from "../executions/taskRunProcess.js";
import { assertExhaustive } from "../utilities/assertExhaustive.js";
import { logger } from "../utilities/logger.js";
import { sanitizeEnvVars } from "../utilities/sanitizeEnvVars.js";
import { join } from "node:path";
import { BackgroundWorker } from "../dev/backgroundWorker.js";
import { eventBus } from "../utilities/eventBus.js";
import { TaskRunProcessPool } from "../dev/taskRunProcessPool.js";

type DevRunControllerOptions = {
  runFriendlyId: string;
  worker: BackgroundWorker;
  httpClient: CliApiClient;
  logLevel: LogLevel;
  heartbeatIntervalSeconds?: number;
  taskRunProcessPool: TaskRunProcessPool;
  onSubscribeToRunNotifications: (run: Run, snapshot: Snapshot) => void;
  onUnsubscribeFromRunNotifications: (run: Run, snapshot: Snapshot) => void;
  onFinished: () => void;
};

type Run = {
  friendlyId: string;
  attemptNumber?: number | null;
};

type Snapshot = {
  friendlyId: string;
};

export class DevRunController {
  private taskRunProcess?: TaskRunProcess;
  private readonly worker: BackgroundWorker;
  private readonly httpClient: CliApiClient;
  private readonly runHeartbeat: IntervalService;
  private readonly heartbeatIntervalSeconds: number;
  private readonly snapshotPoller: IntervalService;
  private readonly snapshotPollIntervalSeconds: number;

  private state:
    | {
        phase: "RUN";
        run: Run;
        snapshot: Snapshot;
      }
    | {
        phase: "IDLE" | "WARM_START";
      } = { phase: "IDLE" };

  private enterRunPhase(run: Run, snapshot: Snapshot) {
    this.onExitRunPhase(run);
    this.state = { phase: "RUN", run, snapshot };

    this.runHeartbeat.start();
    this.snapshotPoller.start();
  }

  constructor(private readonly opts: DevRunControllerOptions) {
    logger.debug("[DevRunController] Creating controller", {
      run: opts.runFriendlyId,
    });

    this.worker = opts.worker;
    this.heartbeatIntervalSeconds = opts.heartbeatIntervalSeconds || 20;
    this.snapshotPollIntervalSeconds = 5;

    this.httpClient = opts.httpClient;

    this.snapshotPoller = new IntervalService({
      onInterval: async () => {
        if (!this.runFriendlyId) {
          logger.debug("[DevRunController] Skipping snapshot poll, no run ID");
          return;
        }

        logger.debug("[DevRunController] Polling for latest snapshot");

        this.httpClient.dev.sendDebugLog(this.runFriendlyId, {
          time: new Date(),
          message: `snapshot poll: started`,
          properties: {
            snapshotId: this.snapshotFriendlyId,
          },
        });

        const response = await this.httpClient.dev.getRunExecutionData(this.runFriendlyId);

        if (!response.success) {
          logger.debug("[DevRunController] Snapshot poll failed", { error: response.error });

          this.httpClient.dev.sendDebugLog(this.runFriendlyId, {
            time: new Date(),
            message: `snapshot poll: failed`,
            properties: {
              snapshotId: this.snapshotFriendlyId,
              error: response.error,
            },
          });

          return;
        }

        await this.handleSnapshotChange(response.data.execution);
      },
      intervalMs: this.snapshotPollIntervalSeconds * 1000,
      leadingEdge: false,
      onError: async (error) => {
        logger.debug("[DevRunController] Failed to poll for snapshot", { error });
      },
    });

    this.runHeartbeat = new IntervalService({
      onInterval: async () => {
        if (!this.runFriendlyId || !this.snapshotFriendlyId) {
          logger.debug("[DevRunController] Skipping heartbeat, no run ID or snapshot ID");
          return;
        }

        logger.debug("[DevRunController] Sending heartbeat");

        const response = await this.httpClient.dev.heartbeatRun(
          this.runFriendlyId,
          this.snapshotFriendlyId,
          {
            cpu: 0,
            memory: 0,
          }
        );

        if (!response.success) {
          logger.debug("[DevRunController] Heartbeat failed", { error: response.error });
        }
      },
      intervalMs: this.heartbeatIntervalSeconds * 1000,
      leadingEdge: false,
      onError: async (error) => {
        logger.debug("[DevRunController] Failed to send heartbeat", { error });
      },
    });

    process.on("SIGTERM", this.sigterm);
  }

  private async sigterm() {
    logger.debug("[DevRunController] Received SIGTERM, stopping worker");
    await this.stop();
  }

  // This should only be used when we're already executing a run. Attempt number changes are not allowed.
  private updateRunPhase(run: Run, snapshot: Snapshot) {
    if (this.state.phase !== "RUN") {
      this.httpClient.dev.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: `updateRunPhase: Invalid phase for updating snapshot: ${this.state.phase}`,
        properties: {
          currentPhase: this.state.phase,
          snapshotId: snapshot.friendlyId,
        },
      });

      throw new Error(`Invalid phase for updating snapshot: ${this.state.phase}`);
    }

    if (this.state.run.friendlyId !== run.friendlyId) {
      this.httpClient.dev.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: `updateRunPhase: Mismatched run IDs`,
        properties: {
          currentRunId: this.state.run.friendlyId,
          newRunId: run.friendlyId,
          currentSnapshotId: this.state.snapshot.friendlyId,
          newSnapshotId: snapshot.friendlyId,
        },
      });

      throw new Error("Mismatched run IDs");
    }

    if (this.state.snapshot.friendlyId === snapshot.friendlyId) {
      logger.debug("updateRunPhase: Snapshot not changed", { run, snapshot });

      this.httpClient.dev.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: `updateRunPhase: Snapshot not changed`,
        properties: {
          snapshotId: snapshot.friendlyId,
        },
      });

      return;
    }

    if (this.state.run.attemptNumber !== run.attemptNumber) {
      this.httpClient.dev.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: `updateRunPhase: Attempt number changed`,
        properties: {
          oldAttemptNumber: this.state.run.attemptNumber ?? undefined,
          newAttemptNumber: run.attemptNumber ?? undefined,
        },
      });
      throw new Error("Attempt number changed");
    }

    this.state = {
      phase: "RUN",
      run: {
        friendlyId: run.friendlyId,
        attemptNumber: run.attemptNumber,
      },
      snapshot: {
        friendlyId: snapshot.friendlyId,
      },
    };
  }

  private onExitRunPhase(newRun: Run | undefined = undefined) {
    // We're not in a run phase, nothing to do
    if (this.state.phase !== "RUN") {
      logger.debug("onExitRunPhase: Not in run phase, skipping", { phase: this.state.phase });
      return;
    }

    // This is still the same run, so we're not exiting the phase
    if (newRun?.friendlyId === this.state.run.friendlyId) {
      logger.debug("onExitRunPhase: Same run, skipping", { newRun });
      return;
    }

    logger.debug("onExitRunPhase: Exiting run phase", { newRun });

    this.runHeartbeat.stop();
    this.snapshotPoller.stop();

    const { run, snapshot } = this.state;

    this.unsubscribeFromRunNotifications({ run, snapshot });
  }

  private subscribeToRunNotifications({ run, snapshot }: { run: Run; snapshot: Snapshot }) {
    logger.debug("[DevRunController] Subscribing to run notifications", { run, snapshot });
    this.opts.onSubscribeToRunNotifications(run, snapshot);
  }

  private unsubscribeFromRunNotifications({ run, snapshot }: { run: Run; snapshot: Snapshot }) {
    logger.debug("[DevRunController] Unsubscribing from run notifications", { run, snapshot });
    this.opts.onUnsubscribeFromRunNotifications(run, snapshot);
  }

  private get runFriendlyId() {
    if (this.state.phase !== "RUN") {
      return undefined;
    }

    return this.state.run.friendlyId;
  }

  private get snapshotFriendlyId() {
    if (this.state.phase !== "RUN") {
      return;
    }

    return this.state.snapshot.friendlyId;
  }

  get workerFriendlyId() {
    if (!this.opts.worker.serverWorker) {
      throw new Error("No version for dev worker");
    }

    return this.opts.worker.serverWorker.id;
  }

  private handleSnapshotChangeLock = false;

  private async handleSnapshotChange({
    run,
    snapshot,
    completedWaitpoints,
  }: Pick<RunExecutionData, "run" | "snapshot" | "completedWaitpoints">) {
    if (this.handleSnapshotChangeLock) {
      logger.debug("handleSnapshotChange: already in progress");
      return;
    }

    this.handleSnapshotChangeLock = true;

    // Reset the (fallback) snapshot poll interval so we don't do unnecessary work
    this.snapshotPoller.resetCurrentInterval();

    try {
      if (!this.snapshotFriendlyId) {
        logger.debug("handleSnapshotChange: Missing snapshot ID", {
          runId: run.friendlyId,
          snapshotId: this.snapshotFriendlyId,
        });

        this.httpClient.dev.sendDebugLog(run.friendlyId, {
          time: new Date(),
          message: `snapshot change: missing snapshot ID`,
          properties: {
            newSnapshotId: snapshot.friendlyId,
            newSnapshotStatus: snapshot.executionStatus,
          },
        });

        return;
      }

      if (this.snapshotFriendlyId === snapshot.friendlyId) {
        logger.debug("handleSnapshotChange: snapshot not changed, skipping", { snapshot });

        this.httpClient.dev.sendDebugLog(run.friendlyId, {
          time: new Date(),
          message: `snapshot change: skipping, no change`,
          properties: {
            snapshotId: this.snapshotFriendlyId,
            snapshotStatus: snapshot.executionStatus,
          },
        });

        return;
      }

      logger.debug(`handleSnapshotChange: ${snapshot.executionStatus}`, {
        run,
        oldSnapshotId: this.snapshotFriendlyId,
        newSnapshot: snapshot,
        completedWaitpoints: completedWaitpoints.length,
      });

      this.httpClient.dev.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: `snapshot change: ${snapshot.executionStatus}`,
        properties: {
          oldSnapshotId: this.snapshotFriendlyId,
          newSnapshotId: snapshot.friendlyId,
          completedWaitpoints: completedWaitpoints.length,
        },
      });

      try {
        this.updateRunPhase(run, snapshot);
      } catch (error) {
        logger.debug("handleSnapshotChange: failed to update run phase", {
          run,
          snapshot,
          error,
        });

        this.runFinished();
        return;
      }

      switch (snapshot.executionStatus) {
        case "PENDING_CANCEL": {
          try {
            await this.cancelAttempt();
          } catch (error) {
            logger.debug("Failed to cancel attempt, killing task run process", {
              error,
            });

            try {
              await this.taskRunProcess?.kill("SIGKILL");
            } catch (error) {
              logger.debug("Failed to cancel attempt, failed to kill task run process", { error });
            }

            return;
          }

          return;
        }
        case "FINISHED": {
          logger.debug("Run is finished, nothing to do");
          return;
        }
        case "EXECUTING_WITH_WAITPOINTS": {
          logger.debug("Run is executing with waitpoints", { snapshot });

          try {
            await this.taskRunProcess?.cleanup(false);
          } catch (error) {
            logger.debug("Failed to cleanup task run process", { error });
          }

          if (snapshot.friendlyId !== this.snapshotFriendlyId) {
            logger.debug("Snapshot changed after cleanup, abort", {
              oldSnapshotId: snapshot.friendlyId,
              newSnapshotId: this.snapshotFriendlyId,
            });
            return;
          }

          //no snapshots in DEV, so we just return.
          return;
        }
        case "SUSPENDED": {
          logger.debug("Run shouldn't be suspended in DEV", {
            run,
            snapshot,
          });
          return;
        }
        case "PENDING_EXECUTING": {
          logger.debug("Run is pending execution", { run, snapshot });

          if (completedWaitpoints.length === 0) {
            logger.log("No waitpoints to complete, nothing to do");
            return;
          }

          logger.debug("Run shouldn't be PENDING_EXECUTING with completedWaitpoints in DEV", {
            run,
            snapshot,
          });

          return;
        }
        case "EXECUTING": {
          logger.debug("Run is now executing", { run, snapshot });

          if (completedWaitpoints.length === 0) {
            return;
          }

          logger.debug("Processing completed waitpoints", { completedWaitpoints });

          if (!this.taskRunProcess) {
            logger.debug("No task run process, ignoring completed waitpoints", {
              completedWaitpoints,
            });
            return;
          }

          for (const waitpoint of completedWaitpoints) {
            this.taskRunProcess.waitpointCompleted(waitpoint);
          }

          return;
        }
        case "RUN_CREATED":
        case "QUEUED_EXECUTING":
        case "QUEUED": {
          logger.debug("Status change not handled", { status: snapshot.executionStatus });
          return;
        }
        default: {
          assertExhaustive(snapshot.executionStatus);
        }
      }
    } catch (error) {
      logger.debug("handleSnapshotChange: unexpected error", { error });

      this.httpClient.dev.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: `snapshot change: unexpected error`,
        properties: {
          snapshotId: snapshot.friendlyId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      this.handleSnapshotChangeLock = false;
    }
  }

  private async startAndExecuteRunAttempt({
    runFriendlyId,
    snapshotFriendlyId,
    dequeuedAt,
    isWarmStart = false,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    dequeuedAt?: Date;
    isWarmStart?: boolean;
  }) {
    this.subscribeToRunNotifications({
      run: { friendlyId: runFriendlyId },
      snapshot: { friendlyId: snapshotFriendlyId },
    });

    const attemptStartedAt = Date.now();

    const start = await this.httpClient.dev.startRunAttempt(runFriendlyId, snapshotFriendlyId);

    if (!start.success) {
      logger.debug("[DevRunController] Failed to start run", { error: start.error });

      this.runFinished();
      return;
    }

    const attemptDuration = Date.now() - attemptStartedAt;

    const { run, snapshot, execution, envVars } = start.data;

    eventBus.emit("runStarted", this.opts.worker, execution);

    logger.debug("[DevRunController] Started run", {
      runId: run.friendlyId,
      snapshot: snapshot.friendlyId,
    });

    this.enterRunPhase(run, snapshot);

    const metrics = [
      {
        name: "start",
        event: "create_attempt",
        timestamp: attemptStartedAt,
        duration: attemptDuration,
      },
    ].concat(
      dequeuedAt
        ? [
            {
              name: "start",
              event: "dequeue",
              timestamp: dequeuedAt.getTime(),
              duration: 0,
            },
          ]
        : []
    );

    try {
      return await this.executeRun({ run, snapshot, execution, envVars, metrics });
    } catch (error) {
      logger.debug("Error while executing attempt", {
        error,
      });

      logger.debug("Submitting attempt completion", {
        runId: run.friendlyId,
        snapshotId: snapshot.friendlyId,
        updatedSnapshotId: this.snapshotFriendlyId,
      });

      const completion = {
        id: execution.run.id,
        ok: false,
        retry: undefined,
        error: TaskRunProcess.parseExecuteError(error),
      } satisfies TaskRunFailedExecutionResult;

      const completionResult = await this.httpClient.dev.completeRunAttempt(
        run.friendlyId,
        this.snapshotFriendlyId ?? snapshot.friendlyId,
        { completion }
      );

      if (!completionResult.success) {
        logger.debug("Failed to submit completion after error", {
          error: completionResult.error,
        });

        this.runFinished();
        return;
      }

      logger.debug("Attempt completion submitted after error", completionResult.data.result);

      try {
        await this.handleCompletionResult(completion, completionResult.data.result, execution);
      } catch (error) {
        logger.debug("Failed to handle completion result after error", { error });

        this.runFinished();
        return;
      }
    }
  }

  private async executeRun({
    run,
    snapshot,
    execution,
    envVars,
    metrics,
  }: WorkloadRunAttemptStartResponseBody & {
    metrics?: TaskRunExecutionMetrics;
  }) {
    if (!this.opts.worker.serverWorker) {
      throw new Error(`No server worker for Dev ${run.friendlyId}`);
    }

    if (!this.opts.worker.manifest) {
      throw new Error(`No worker manifest for Dev ${run.friendlyId}`);
    }

    this.snapshotPoller.start();

    // Get process from pool instead of creating new one
    this.taskRunProcess = await this.opts.taskRunProcessPool.getProcess(
      this.opts.worker.manifest,
      {
        id: "unmanaged",
        contentHash: this.opts.worker.build.contentHash,
        version: this.opts.worker.serverWorker?.version,
        engine: "V2",
      },
      execution.machine,
      {
        TRIGGER_WORKER_MANIFEST_PATH: join(this.opts.worker.build.outputPath, "index.json"),
        RUN_WORKER_SHOW_LOGS: this.opts.logLevel === "debug" ? "true" : "false",
      }
    );

    // Update the process environment for this specific run
    // Note: We may need to enhance TaskRunProcess to support updating env vars
    logger.debug("executing task run process from pool", {
      attemptNumber: execution.attempt.number,
      runId: execution.run.id,
    });

    const completion = await this.taskRunProcess.execute({
      payload: {
        execution,
        traceContext: execution.run.traceContext ?? {},
        metrics,
      },
      messageId: run.friendlyId,
      env: {
        ...sanitizeEnvVars(envVars ?? {}),
        ...sanitizeEnvVars(this.opts.worker.params.env),
        TRIGGER_PROJECT_REF: execution.project.ref,
      },
    });

    logger.debug("Completed run", completion);

    // Return process to pool instead of killing it
    try {
      await this.opts.taskRunProcessPool.returnProcess(this.taskRunProcess);
      this.taskRunProcess = undefined;
    } catch (error) {
      logger.debug("Failed to return task run process to pool, submitting completion anyway", {
        error,
      });
    }

    if (!this.runFriendlyId || !this.snapshotFriendlyId) {
      logger.debug("executeRun: Missing run ID or snapshot ID after execution", {
        runId: this.runFriendlyId,
        snapshotId: this.snapshotFriendlyId,
      });

      this.runFinished();
      return;
    }

    const completionResult = await this.httpClient.dev.completeRunAttempt(
      this.runFriendlyId,
      this.snapshotFriendlyId,
      {
        completion,
      }
    );

    if (!completionResult.success) {
      logger.debug("Failed to submit completion", {
        error: completionResult.error,
      });

      this.runFinished();
      return;
    }

    logger.debug("Attempt completion submitted", completionResult.data.result);

    try {
      await this.handleCompletionResult(completion, completionResult.data.result, execution);
    } catch (error) {
      logger.debug("Failed to handle completion result", { error });

      this.runFinished();
      return;
    }
  }

  private async handleCompletionResult(
    completion: TaskRunExecutionResult,
    result: CompleteRunAttemptResult,
    execution: TaskRunExecution
  ) {
    logger.debug("[DevRunController] Handling completion result", { completion, result });

    const { attemptStatus, snapshot: completionSnapshot, run } = result;

    try {
      this.updateRunPhase(run, completionSnapshot);
    } catch (error) {
      logger.debug("Failed to update run phase after completion", { error });

      this.runFinished();
      return;
    }

    if (attemptStatus === "RETRY_QUEUED") {
      logger.debug("Retry queued");

      this.runFinished();
      return;
    }

    if (attemptStatus === "RETRY_IMMEDIATELY") {
      if (completion.ok) {
        throw new Error("Should retry but completion OK.");
      }

      if (!completion.retry) {
        throw new Error("Should retry but missing retry params.");
      }

      await sleep(completion.retry.delay);

      if (!this.snapshotFriendlyId) {
        throw new Error("Missing snapshot ID after retry");
      }

      this.startAndExecuteRunAttempt({
        runFriendlyId: run.friendlyId,
        snapshotFriendlyId: this.snapshotFriendlyId,
      }).finally(() => {});
      return;
    }

    if (attemptStatus === "RUN_PENDING_CANCEL") {
      logger.debug("Run pending cancel");
      return;
    }

    eventBus.emit(
      "runCompleted",
      this.opts.worker,
      execution,
      completion,
      completion.usage?.durationMs ?? 0
    );

    if (attemptStatus === "RUN_FINISHED") {
      logger.debug("Run finished");

      this.runFinished();
      return;
    }

    assertExhaustive(attemptStatus);
  }

  private async runFinished() {
    // Return the process to the pool instead of killing it directly
    if (this.taskRunProcess) {
      try {
        await this.opts.taskRunProcessPool.returnProcess(this.taskRunProcess);
        this.taskRunProcess = undefined;
      } catch (error) {
        logger.debug("Failed to return task run process to pool during runFinished", { error });
      }
    }

    this.runHeartbeat.stop();
    this.snapshotPoller.stop();

    this.opts.onFinished();
  }

  private async cancelAttempt() {
    logger.debug("Cancelling attempt", { runId: this.runFriendlyId });

    await this.taskRunProcess?.cancel();
  }

  async start(dequeueMessage: DequeuedMessage) {
    logger.debug("[DevRunController] Starting up");

    await this.startAndExecuteRunAttempt({
      runFriendlyId: dequeueMessage.run.friendlyId,
      snapshotFriendlyId: dequeueMessage.snapshot.friendlyId,
      dequeuedAt: dequeueMessage.dequeuedAt,
    }).finally(async () => {});
  }

  async stop() {
    logger.debug("[DevRunController] Shutting down");

    process.off("SIGTERM", this.sigterm);

    if (this.taskRunProcess && !this.taskRunProcess.isBeingKilled) {
      try {
        await this.opts.taskRunProcessPool.returnProcess(this.taskRunProcess);
        this.taskRunProcess = undefined;
      } catch (error) {
        logger.debug("Failed to return task run process to pool during stop", { error });
      }
    }

    this.runHeartbeat.stop();
    this.snapshotPoller.stop();
  }

  async getLatestSnapshot() {
    if (!this.runFriendlyId) {
      return;
    }

    logger.debug("[DevRunController] Received notification, manually getting the latest snapshot.");

    const response = await this.httpClient.dev.getRunExecutionData(this.runFriendlyId);

    if (!response.success) {
      logger.debug("Failed to get latest snapshot", { error: response.error });
      return;
    }

    await this.handleSnapshotChange(response.data.execution);
  }

  resubscribeToRunNotifications() {
    if (this.state.phase !== "RUN") {
      return;
    }

    this.subscribeToRunNotifications(this.state);
  }
}
