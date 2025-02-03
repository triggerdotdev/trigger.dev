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

  private state: {
    run: Run;
    snapshot: Snapshot;
  };

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

  private enterRunPhase(run: Run, snapshot: Snapshot) {
    this.state = { run, snapshot };

    this.runHeartbeat.start();
    this.snapshotPoller.start();
  }

  private get runFriendlyId() {
    return this.state.run.friendlyId;
  }

  private get snapshotFriendlyId() {
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
    const start = await this.httpClient.dev.startRunAttempt(runFriendlyId, snapshotFriendlyId);

    if (!start.success) {
      console.error("[DevRunController] Failed to start run", { error: start.error });

      this.waitForNextRun();
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

        this.waitForNextRun();
        return;
      }

      logger.log("Attempt completion submitted after error", completionResult.data.result);

      try {
        await this.handleCompletionResult(completion, completionResult.data.result);
      } catch (error) {
        console.error("Failed to handle completion result after error", { error });

        this.waitForNextRun();
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

      this.waitForNextRun();
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

      this.waitForNextRun();
      return;
    }

    logger.log("Attempt completion submitted", completionResult.data.result);

    try {
      await this.handleCompletionResult(completion, completionResult.data.result);
    } catch (error) {
      console.error("Failed to handle completion result", { error });

      this.waitForNextRun();
      return;
    }
  }

  private async handleCompletionResult(
    completion: TaskRunExecutionResult,
    result: CompleteRunAttemptResult
  ) {
    logger.debug("[DevRunController] Handling completion result", { completion, result });

    const { attemptStatus, snapshot: completionSnapshot, run } = result;

    if (attemptStatus === "RUN_FINISHED") {
      logger.debug("Run finished");

      this.waitForNextRun();
      return;
    }

    if (attemptStatus === "RUN_PENDING_CANCEL") {
      logger.debug("Run pending cancel");
      return;
    }

    if (attemptStatus === "RETRY_QUEUED") {
      logger.debug("Retry queued");

      this.waitForNextRun();
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

  private async waitForNextRun() {
    // Kill the run process
    await this.taskRunProcess?.kill("SIGKILL");

    //todo signal to the supervisor that this run failed
  }

  async cancelAttempt(runId: string) {
    logger.log("cancelling attempt", { runId });

    await this.taskRunProcess?.cancel();
  }

  async start(dequeueMessage: DequeuedMessage) {
    logger.debug("[DevRunController] Starting up");

    this.state = {
      run: dequeueMessage.run,
      snapshot: dequeueMessage.snapshot,
    };

    this.startAndExecuteRunAttempt({
      runFriendlyId: dequeueMessage.run.friendlyId,
      snapshotFriendlyId: dequeueMessage.snapshot.friendlyId,
    }).finally(() => {});
  }

  async stop() {
    logger.debug("[DevRunController] Shutting down");

    if (this.taskRunProcess) {
      await this.taskRunProcess.cleanup(true);
    }

    this.runHeartbeat.stop();
    this.snapshotPoller.stop();
  }
}

const longPoll = async <T = any>(
  url: string,
  requestInit: Omit<RequestInit, "signal">,
  {
    timeoutMs,
    totalDurationMs,
  }: {
    timeoutMs: number;
    totalDurationMs: number;
  }
): Promise<
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: string;
    }
> => {
  logger.debug("Long polling", { url, requestInit, timeoutMs, totalDurationMs });

  const endTime = Date.now() + totalDurationMs;

  while (Date.now() < endTime) {
    try {
      const controller = new AbortController();
      const signal = controller.signal;

      // TODO: Think about using a random timeout instead
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, { ...requestInit, signal });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();

        return {
          ok: true,
          data,
        };
      } else {
        return {
          ok: false,
          error: `Server error: ${response.status}`,
        };
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.log("Long poll request timed out, retrying...");
        continue;
      } else {
        console.error("Error during fetch, retrying...", error);

        // TODO: exponential backoff
        await sleep(1000);
        continue;
      }
    }
  }

  return {
    ok: false,
    error: "TotalDurationExceeded",
  };
};
