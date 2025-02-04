import {
  BuildManifest,
  CompleteRunAttemptResult,
  DequeuedMessage,
  HeartbeatService,
  RunExecutionData,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import { type WorkloadRunAttemptStartResponseBody } from "@trigger.dev/core/v3/workers";
import { setTimeout as sleep } from "timers/promises";
import { CliApiClient } from "../apiClient.js";
import { OnWaitMessage, TaskRunProcess } from "../executions/taskRunProcess.js";
import { assertExhaustive } from "../utilities/assertExhaustive.js";
import { logger } from "../utilities/logger.js";
import { sanitizeEnvVars } from "../utilities/sanitizeEnvVars.js";
import { join } from "node:path";

type DevRunControllerOptions = {
  runFriendlyId: string;
  workerManifest: WorkerManifest;
  buildManifest: BuildManifest;
  envVars: Record<string, string>;
  version: string;
  httpClient: CliApiClient;
  heartbeatIntervalSeconds?: number;
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

  private workerManifest: WorkerManifest;

  private readonly httpClient: CliApiClient;

  private readonly runHeartbeat: HeartbeatService;
  private readonly heartbeatIntervalSeconds: number;

  private readonly snapshotPoller: HeartbeatService;
  private readonly snapshotPollIntervalSeconds: number;

  private readonly envVars: Record<string, string>;

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
      w: this.workerManifest,
    });

    this.workerManifest = opts.workerManifest;
    this.heartbeatIntervalSeconds = opts.heartbeatIntervalSeconds || 30;
    this.snapshotPollIntervalSeconds = 5;

    this.httpClient = opts.httpClient;
    this.envVars = opts.envVars;

    this.snapshotPoller = new HeartbeatService({
      heartbeat: async () => {
        if (!this.runFriendlyId) {
          logger.debug("[DevRunController] Skipping snapshot poll, no run ID");
          return;
        }

        console.debug("[DevRunController] Polling for latest snapshot");

        this.httpClient.dev.sendDebugLog(this.runFriendlyId, {
          time: new Date(),
          message: `snapshot poll: started`,
          properties: {
            snapshotId: this.snapshotFriendlyId,
          },
        });

        const response = await this.httpClient.dev.getRunExecutionData(this.runFriendlyId);

        if (!response.success) {
          console.error("[DevRunController] Snapshot poll failed", { error: response.error });

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
        console.error("[DevRunController] Failed to poll for snapshot", { error });
      },
    });

    this.runHeartbeat = new HeartbeatService({
      heartbeat: async () => {
        if (!this.runFriendlyId || !this.snapshotFriendlyId) {
          logger.debug("[DevRunController] Skipping heartbeat, no run ID or snapshot ID");
          return;
        }

        console.debug("[DevRunController] Sending heartbeat");

        const response = await this.httpClient.dev.heartbeatRun(
          this.runFriendlyId,
          this.snapshotFriendlyId,
          {
            cpu: 0,
            memory: 0,
          }
        );

        if (!response.success) {
          console.error("[DevRunController] Heartbeat failed", { error: response.error });
        }
      },
      intervalMs: this.heartbeatIntervalSeconds * 1000,
      leadingEdge: false,
      onError: async (error) => {
        console.error("[DevRunController] Failed to send heartbeat", { error });
      },
    });

    process.on("SIGTERM", async () => {
      logger.debug("[DevRunController] Received SIGTERM, stopping worker");
      await this.stop();
    });
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

  private handleSnapshotChangeLock = false;

  private async handleSnapshotChange({
    run,
    snapshot,
    completedWaitpoints,
  }: Pick<RunExecutionData, "run" | "snapshot" | "completedWaitpoints">) {
    if (this.handleSnapshotChangeLock) {
      console.warn("handleSnapshotChange: already in progress");
      return;
    }

    this.handleSnapshotChangeLock = true;

    // Reset the (fallback) snapshot poll interval so we don't do unnecessary work
    this.snapshotPoller.resetCurrentInterval();

    try {
      if (!this.snapshotFriendlyId) {
        console.error("handleSnapshotChange: Missing snapshot ID", {
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
        console.debug("handleSnapshotChange: snapshot not changed, skipping", { snapshot });

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

      console.log(`handleSnapshotChange: ${snapshot.executionStatus}`, {
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
        console.error("handleSnapshotChange: failed to update run phase", {
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
            await this.cancelAttempt(run.friendlyId);
          } catch (error) {
            console.error("Failed to cancel attempt, shutting down", {
              error,
            });

            //todo kill the process?

            return;
          }

          return;
        }
        case "FINISHED": {
          console.log("Run is finished, nothing to do");
          return;
        }
        case "EXECUTING_WITH_WAITPOINTS": {
          console.log("Run is executing with waitpoints", { snapshot });

          try {
            await this.taskRunProcess?.cleanup(false);
          } catch (error) {
            console.error("Failed to cleanup task run process", { error });
          }

          if (snapshot.friendlyId !== this.snapshotFriendlyId) {
            console.debug("Snapshot changed after cleanup, abort", {
              oldSnapshotId: snapshot.friendlyId,
              newSnapshotId: this.snapshotFriendlyId,
            });
            return;
          }

          //no snapshots in DEV, so we just return.
          return;
        }
        case "SUSPENDED": {
          console.error("Run shouldn't be suspended in DEV", {
            run,
            snapshot,
          });
          return;
        }
        case "PENDING_EXECUTING": {
          console.log("Run is pending execution", { run, snapshot });

          if (completedWaitpoints.length === 0) {
            console.log("No waitpoints to complete, nothing to do");
            return;
          }

          console.error("Run shouldn't be PENDING_EXECUTING with completedWaitpoints in DEV", {
            run,
            snapshot,
          });

          return;
        }
        case "EXECUTING": {
          console.log("Run is now executing", { run, snapshot });

          if (completedWaitpoints.length === 0) {
            return;
          }

          console.log("Processing completed waitpoints", { completedWaitpoints });

          if (!this.taskRunProcess) {
            console.error("No task run process, ignoring completed waitpoints", {
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
        case "QUEUED": {
          console.log("Status change not handled", { status: snapshot.executionStatus });
          return;
        }
        default: {
          assertExhaustive(snapshot.executionStatus);
        }
      }
    } catch (error) {
      console.error("handleSnapshotChange: unexpected error", { error });

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
    isWarmStart = false,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    isWarmStart?: boolean;
  }) {
    this.subscribeToRunNotifications({
      run: { friendlyId: runFriendlyId },
      snapshot: { friendlyId: snapshotFriendlyId },
    });

    const start = await this.httpClient.dev.startRunAttempt(runFriendlyId, snapshotFriendlyId);

    if (!start.success) {
      console.error("[DevRunController] Failed to start run", { error: start.error });

      this.runFinished();
      return;
    }

    const { run, snapshot, execution, envVars } = start.data;

    logger.debug("[DevRunController] Started run", {
      runId: run.friendlyId,
      snapshot: snapshot.friendlyId,
    });

    // TODO: We may already be executing this run, this may be a new attempt
    //  This is the only case where incrementing the attempt number is allowed
    this.enterRunPhase(run, snapshot);

    try {
      return await this.executeRun({ run, snapshot, execution, envVars });
    } catch (error) {
      // TODO: Handle the case where we're in the warm start phase or executing a new run
      // This can happen if we kill the run while it's still executing, e.g. after receiving an attempt number mismatch

      console.error("Error while executing attempt", {
        error,
      });

      console.log("Submitting attempt completion", {
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
        console.error("Failed to submit completion after error", {
          error: completionResult.error,
        });

        // TODO: Maybe we should keep retrying for a while longer

        this.runFinished();
        return;
      }

      logger.log("Attempt completion submitted after error", completionResult.data.result);

      try {
        await this.handleCompletionResult(completion, completionResult.data.result);
      } catch (error) {
        console.error("Failed to handle completion result after error", { error });

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
  }: WorkloadRunAttemptStartResponseBody) {
    this.snapshotPoller.start();

    this.taskRunProcess = new TaskRunProcess({
      workerManifest: this.workerManifest,
      env: {
        ...sanitizeEnvVars(envVars ?? {}),
        ...sanitizeEnvVars(this.envVars),
        TRIGGER_WORKER_MANIFEST_PATH: join(this.opts.buildManifest.outputPath, "index.json"),
      },
      serverWorker: {
        id: "unmanaged",
        contentHash: this.opts.buildManifest.contentHash,
        version: this.opts.version,
        engine: "V2",
      },
      payload: {
        execution,
        traceContext: execution.run.traceContext ?? {},
      },
      messageId: run.friendlyId,
    });

    this.taskRunProcess.onWait.attach(this.handleWait.bind(this));

    await this.taskRunProcess.initialize();

    logger.log("executing task run process", {
      attemptId: execution.attempt.id,
      runId: execution.run.id,
    });

    const completion = await this.taskRunProcess.execute();

    logger.log("Completed run", completion);

    try {
      await this.taskRunProcess.cleanup(true);
      this.taskRunProcess = undefined;
    } catch (error) {
      console.error("Failed to cleanup task run process, submitting completion anyway", {
        error,
      });
    }

    if (!this.runFriendlyId || !this.snapshotFriendlyId) {
      console.error("executeRun: Missing run ID or snapshot ID after execution", {
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
      console.error("Failed to submit completion", {
        error: completionResult.error,
      });

      this.runFinished();
      return;
    }

    logger.log("Attempt completion submitted", completionResult.data.result);

    try {
      await this.handleCompletionResult(completion, completionResult.data.result);
    } catch (error) {
      console.error("Failed to handle completion result", { error });

      this.runFinished();
      return;
    }
  }

  private async handleCompletionResult(
    completion: TaskRunExecutionResult,
    result: CompleteRunAttemptResult
  ) {
    logger.debug("[DevRunController] Handling completion result", { completion, result });

    const { attemptStatus, snapshot: completionSnapshot, run } = result;

    try {
      this.updateRunPhase(run, completionSnapshot);
    } catch (error) {
      console.error("Failed to update run phase after completion", { error });

      this.runFinished();
      return;
    }

    if (attemptStatus === "RUN_FINISHED") {
      logger.debug("Run finished");

      this.runFinished();
      return;
    }

    if (attemptStatus === "RUN_PENDING_CANCEL") {
      logger.debug("Run pending cancel");
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

    assertExhaustive(attemptStatus);
  }

  private async handleWait({ wait }: OnWaitMessage) {
    if (!this.runFriendlyId || !this.snapshotFriendlyId) {
      logger.debug("[DevRunController] Ignoring wait, no run ID or snapshot ID");
      return;
    }

    switch (wait.type) {
      case "DATETIME": {
        logger.log("Waiting for duration", { wait });

        const waitpoint = await this.httpClient.dev.waitForDuration(
          this.runFriendlyId,
          this.snapshotFriendlyId,
          {
            date: wait.date,
          }
        );

        if (!waitpoint.success) {
          console.error("Failed to wait for datetime", { error: waitpoint.error });
          return;
        }

        logger.log("Waitpoint created", { waitpointData: waitpoint.data });

        this.taskRunProcess?.waitpointCreated(wait.id, waitpoint.data.waitpoint.id);

        break;
      }
      default: {
        console.error("Wait type not implemented", { wait });
      }
    }
  }

  private async runFinished() {
    // Kill the run process
    await this.taskRunProcess?.kill("SIGKILL");

    this.runHeartbeat.stop();
    this.snapshotPoller.stop();

    this.opts.onFinished();
  }

  async cancelAttempt(runId: string) {
    logger.log("cancelling attempt", { runId });

    await this.taskRunProcess?.cancel();
  }

  async start(dequeueMessage: DequeuedMessage) {
    logger.debug("[DevRunController] Starting up");

    await this.startAndExecuteRunAttempt({
      runFriendlyId: dequeueMessage.run.friendlyId,
      snapshotFriendlyId: dequeueMessage.snapshot.friendlyId,
    }).finally(async () => {});
  }

  async stop() {
    logger.debug("[DevRunController] Shutting down");

    if (this.taskRunProcess) {
      await this.taskRunProcess.cleanup(true);
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
      console.error("Failed to get latest snapshot", { error: response.error });
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
