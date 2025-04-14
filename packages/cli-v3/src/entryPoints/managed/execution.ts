import {
  type CompleteRunAttemptResult,
  type RunExecutionData,
  SuspendedProcessError,
  TaskRunExecution,
  type TaskRunExecutionMetrics,
  type TaskRunExecutionResult,
  type TaskRunFailedExecutionResult,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import { type WorkloadRunAttemptStartResponseBody } from "@trigger.dev/core/v3/workers";
import { TaskRunProcess } from "../../executions/taskRunProcess.js";
import { RunLogger, SendDebugLogOptions } from "./logger.js";
import { RunnerEnv } from "./env.js";
import { WorkloadHttpClient } from "@trigger.dev/core/v3/workers";
import { setTimeout as sleep } from "timers/promises";
import { RunExecutionHeartbeat } from "./heartbeat.js";
import { RunExecutionSnapshotPoller } from "./poller.js";
import { assertExhaustive, tryCatch } from "@trigger.dev/core/utils";
import { MetadataClient } from "./overrides.js";

class ExecutionAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionAbortError";
  }
}

type RunExecutionOptions = {
  workerManifest: WorkerManifest;
  env: RunnerEnv;
  httpClient: WorkloadHttpClient;
  logger: RunLogger;
};

type RunExecutionPrepareOptions = {
  taskRunEnv: Record<string, string>;
};

type RunExecutionRunOptions = {
  runFriendlyId: string;
  snapshotFriendlyId: string;
  dequeuedAt?: Date;
  podScheduledAt?: Date;
  isWarmStart?: boolean;
};

export class RunExecution {
  private executionAbortController = new AbortController();
  private isExecutionActive = false;
  private isPrepared = false;

  private _runFriendlyId?: string;
  private currentSnapshotId?: string;
  private currentTaskRunEnv: Record<string, string> | null = null;

  private dequeuedAt?: Date;
  private podScheduledAt?: Date;
  private isWarmStart: boolean;
  private readonly workerManifest: WorkerManifest;
  private readonly env: RunnerEnv;
  private readonly httpClient: WorkloadHttpClient;
  private readonly logger: RunLogger;
  private restoreCount = 0;

  private taskRunProcess?: TaskRunProcess;
  private runHeartbeat?: RunExecutionHeartbeat;
  private snapshotPoller?: RunExecutionSnapshotPoller;

  constructor(opts: RunExecutionOptions) {
    this.workerManifest = opts.workerManifest;
    this.env = opts.env;
    this.httpClient = opts.httpClient;
    this.logger = opts.logger;
    this.isWarmStart = false;
  }

  /**
   * Prepares the execution with task run environment variables.
   * This should be called before executing, typically after a successful run to prepare for the next one.
   */
  public prepareForExecution(opts: RunExecutionPrepareOptions): void {
    this.currentTaskRunEnv = opts.taskRunEnv;

    if (!this.taskRunProcess || !this.taskRunProcess.isPreparedForNextRun) {
      this.taskRunProcess = new TaskRunProcess({
        workerManifest: this.workerManifest,
        env: opts.taskRunEnv,
        serverWorker: {
          id: "managed",
          contentHash: this.env.TRIGGER_CONTENT_HASH,
          version: this.env.TRIGGER_DEPLOYMENT_VERSION,
          engine: "V2",
        },
        machineResources: {
          cpu: Number(this.env.TRIGGER_MACHINE_CPU),
          memory: Number(this.env.TRIGGER_MACHINE_MEMORY),
        },
        isWarmStart: this.isWarmStart,
      }).initialize();
    }

    this.isPrepared = true;
  }

  /**
   * Returns true if the execution has been prepared with task run env.
   */
  public isPreparedForExecution(): boolean {
    return this.isPrepared;
  }

  /**
   * Called by the RunController when it receives a websocket notification
   * or when the snapshot poller detects a change
   */
  public async handleSnapshotChange(runData: RunExecutionData): Promise<void> {
    const { run, snapshot, completedWaitpoints } = runData;

    // Ensure we have run details
    if (!this.runFriendlyId || !this.currentSnapshotId) {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: "handleSnapshotChange: missing run or snapshot ID",
        properties: {
          currentRunId: this.runFriendlyId,
          newRunId: run.friendlyId,
          currentSnapshotId: this.currentSnapshotId,
          newSnapshotId: snapshot.friendlyId,
        },
      });
      return;
    }

    // Ensure the run ID matches
    if (run.friendlyId !== this._runFriendlyId) {
      this.sendDebugLog({
        runId: this._runFriendlyId,
        message: "handleSnapshotChange: mismatched run IDs",
        properties: {
          currentRunId: this._runFriendlyId,
          newRunId: run.friendlyId,
          currentSnapshotId: this.currentSnapshotId,
          newSnapshotId: snapshot.friendlyId,
        },
      });
      return;
    }

    this.sendDebugLog({
      runId: this._runFriendlyId,
      message: `enqueued snapshot change: ${snapshot.executionStatus}`,
      properties: {
        oldSnapshotId: this.currentSnapshotId,
        newSnapshotId: snapshot.friendlyId,
        completedWaitpoints: completedWaitpoints.length,
      },
    });

    this.snapshotChangeQueue.push(runData);
    await this.processSnapshotChangeQueue();
  }

  private snapshotChangeQueue: RunExecutionData[] = [];
  private snapshotChangeQueueLock = false;

  private async processSnapshotChangeQueue() {
    if (this.snapshotChangeQueueLock) {
      return;
    }

    this.snapshotChangeQueueLock = true;
    while (this.snapshotChangeQueue.length > 0) {
      const runData = this.snapshotChangeQueue.shift();

      if (!runData) {
        continue;
      }

      const [error] = await tryCatch(this.processSnapshotChange(runData));

      if (error) {
        this.sendDebugLog({
          runId: this._runFriendlyId,
          message: "Failed to process snapshot change",
          properties: {
            error: error.message,
            currentSnapshotId: this.currentSnapshotId,
          },
        });
      }
    }
    this.snapshotChangeQueueLock = false;
  }

  private async processSnapshotChange(runData: RunExecutionData): Promise<void> {
    const { run, snapshot, completedWaitpoints } = runData;

    // Check if the incoming snapshot is newer than the current one
    if (!this.currentSnapshotId || snapshot.friendlyId < this.currentSnapshotId) {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: "handleSnapshotChange: received older snapshot, skipping",
        properties: {
          currentSnapshotId: this.currentSnapshotId,
          receivedSnapshotId: snapshot.friendlyId,
        },
      });
      return;
    }

    if (snapshot.friendlyId === this.currentSnapshotId) {
      this.sendDebugLog({
        runId: this._runFriendlyId,
        message: "handleSnapshotChange: snapshot not changed",
        properties: { snapshot: snapshot.friendlyId },
      });
      return;
    }

    this.sendDebugLog({
      runId: this._runFriendlyId,
      message: `snapshot change: ${snapshot.executionStatus}`,
      properties: {
        oldSnapshotId: this.currentSnapshotId,
        newSnapshotId: snapshot.friendlyId,
        completedWaitpoints: completedWaitpoints.length,
      },
    });

    // Reset the snapshot poll interval so we don't do unnecessary work
    this.snapshotPoller?.resetCurrentInterval();

    // Update internal state
    this.currentSnapshotId = snapshot.friendlyId;

    // Update services
    this.runHeartbeat?.updateSnapshotId(snapshot.friendlyId);
    this.snapshotPoller?.updateSnapshotId(snapshot.friendlyId);

    switch (snapshot.executionStatus) {
      case "PENDING_CANCEL": {
        const [error] = await tryCatch(this.cancel());

        if (error) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "snapshot change: failed to cancel attempt",
            properties: { error: error.message },
          });
        }

        this.abortExecution();
        return;
      }
      case "FINISHED": {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Run is finished",
        });

        // Pretend we've just suspended the run. This will kill the process without failing the run.
        await this.suspend();
        return;
      }
      case "QUEUED_EXECUTING":
      case "EXECUTING_WITH_WAITPOINTS": {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Run is executing with waitpoints",
          properties: { snapshot: snapshot.friendlyId },
        });

        const [error] = await tryCatch(this.taskRunProcess?.cleanup(false));

        if (error) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Failed to cleanup task run process, carrying on",
            properties: { error: error.message },
          });
        }

        if (snapshot.friendlyId !== this.currentSnapshotId) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Snapshot changed after cleanup, abort",
            properties: {
              oldSnapshotId: snapshot.friendlyId,
              newSnapshotId: this.currentSnapshotId,
            },
          });

          this.abortExecution();
          return;
        }

        await sleep(this.env.TRIGGER_PRE_SUSPEND_WAIT_MS);

        if (snapshot.friendlyId !== this.currentSnapshotId) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Snapshot changed after suspend threshold, abort",
            properties: {
              oldSnapshotId: snapshot.friendlyId,
              newSnapshotId: this.currentSnapshotId,
            },
          });

          this.abortExecution();
          return;
        }

        if (!this._runFriendlyId || !this.currentSnapshotId) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "handleSnapshotChange: Missing run ID or snapshot ID after suspension, abort",
            properties: {
              runId: this._runFriendlyId,
              snapshotId: this.currentSnapshotId,
            },
          });

          this.abortExecution();
          return;
        }

        const suspendResult = await this.httpClient.suspendRun(
          this._runFriendlyId,
          this.currentSnapshotId
        );

        if (!suspendResult.success) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Failed to suspend run, staying alive 🎶",
            properties: {
              error: suspendResult.error,
            },
          });

          this.sendDebugLog({
            runId: run.friendlyId,
            message: "checkpoint: suspend request failed",
            properties: {
              snapshotId: this.currentSnapshotId,
              error: suspendResult.error,
            },
          });

          // This is fine, we'll wait for the next status change
          return;
        }

        if (!suspendResult.data.ok) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "checkpoint: failed to suspend run",
            properties: {
              snapshotId: this.currentSnapshotId,
              error: suspendResult.data.error,
            },
          });

          // This is fine, we'll wait for the next status change
          return;
        }

        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Suspending, any day now 🚬",
          properties: { ok: suspendResult.data.ok },
        });

        // Wait for next status change
        return;
      }
      case "SUSPENDED": {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Run was suspended, kill the process",
          properties: { run: run.friendlyId, snapshot: this.currentSnapshotId },
        });

        await this.suspend();
        return;
      }
      case "PENDING_EXECUTING": {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Run is pending execution",
          properties: { run: run.friendlyId, snapshot: this.currentSnapshotId },
        });

        if (completedWaitpoints.length === 0) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "No waitpoints to complete, nothing to do",
          });
          return;
        }

        await this.restore();
        return;
      }
      case "EXECUTING": {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Run is now executing",
          properties: { run: run.friendlyId, snapshot: this.currentSnapshotId },
        });

        if (completedWaitpoints.length === 0) {
          return;
        }

        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Processing completed waitpoints",
          properties: { completedWaitpoints: completedWaitpoints.length },
        });

        if (!this.taskRunProcess) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "No task run process, ignoring completed waitpoints",
            properties: { completedWaitpoints: completedWaitpoints.length },
          });

          this.abortExecution();
          return;
        }

        for (const waitpoint of completedWaitpoints) {
          this.taskRunProcess.waitpointCompleted(waitpoint);
        }

        return;
      }
      case "RUN_CREATED":
      case "QUEUED": {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Invalid status change",
          properties: { status: snapshot.executionStatus },
        });

        this.abortExecution();
        return;
      }
      default: {
        assertExhaustive(snapshot.executionStatus);
      }
    }
  }

  /**
   * Executes the run. This will return when the execution is complete and we should warm start.
   * When this returns, the child process will have been cleaned up.
   */
  public async execute(runOpts: RunExecutionRunOptions): Promise<void> {
    this._runFriendlyId = runOpts.runFriendlyId;
    this.currentSnapshotId = runOpts.snapshotFriendlyId;
    this.dequeuedAt = runOpts.dequeuedAt;
    this.podScheduledAt = runOpts.podScheduledAt;
    this.isWarmStart = runOpts.isWarmStart ?? false;

    // Reset abort controller for new execution
    this.executionAbortController = new AbortController();

    // Create and start the heartbeat and poller services
    this.runHeartbeat = new RunExecutionHeartbeat({
      runFriendlyId: this._runFriendlyId,
      snapshotFriendlyId: this.currentSnapshotId,
      httpClient: this.httpClient,
      logger: this.logger,
      heartbeatIntervalSeconds: this.env.TRIGGER_HEARTBEAT_INTERVAL_SECONDS,
    });

    this.snapshotPoller = new RunExecutionSnapshotPoller({
      runFriendlyId: this._runFriendlyId,
      snapshotFriendlyId: this.currentSnapshotId,
      httpClient: this.httpClient,
      logger: this.logger,
      snapshotPollIntervalSeconds: this.env.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS,
      handleSnapshotChange: this.handleSnapshotChange.bind(this),
    });

    this.runHeartbeat.start();
    this.snapshotPoller.start();

    try {
      const attemptStartedAt = Date.now();

      // Check for abort before each major async operation
      if (this.executionAbortController.signal.aborted) {
        throw new ExecutionAbortError("Execution aborted before start");
      }

      const start = await this.httpClient.startRunAttempt(
        this._runFriendlyId,
        this.currentSnapshotId,
        {
          isWarmStart: this.isWarmStart,
        }
      );

      if (this.executionAbortController.signal.aborted) {
        throw new ExecutionAbortError("Execution aborted after start");
      }

      if (!start.success) {
        this.sendDebugLog({
          runId: this._runFriendlyId,
          message: "Failed to start run",
          properties: { error: start.error },
        });

        return;
      }

      // A snapshot was just created, so update the snapshot ID
      this.currentSnapshotId = start.data.snapshot.friendlyId;

      const attemptDuration = Date.now() - attemptStartedAt;

      const { run, snapshot, execution, envVars } = start.data;

      this.sendDebugLog({
        runId: run.friendlyId,
        message: "Started run",
        properties: { snapshot: snapshot.friendlyId },
      });

      const metrics = [
        {
          name: "start",
          event: "create_attempt",
          timestamp: attemptStartedAt,
          duration: attemptDuration,
        },
      ]
        .concat(
          this.dequeuedAt
            ? [
                {
                  name: "start",
                  event: "dequeue",
                  timestamp: this.dequeuedAt.getTime(),
                  duration: 0,
                },
              ]
            : []
        )
        .concat(
          this.podScheduledAt
            ? [
                {
                  name: "start",
                  event: "pod_scheduled",
                  timestamp: this.podScheduledAt.getTime(),
                  duration: 0,
                },
              ]
            : []
        ) satisfies TaskRunExecutionMetrics;

      this.currentTaskRunEnv = {
        ...this.env.gatherProcessEnv(),
        ...envVars,
      };

      const [error] = await tryCatch(
        this.executeRun({
          run,
          snapshot,
          envVars: this.currentTaskRunEnv,
          execution,
          metrics,
        })
      );

      this.sendDebugLog({
        runId: run.friendlyId,
        message: "Run execution completed",
        properties: { error: error?.message },
      });

      if (!error) {
        // Stop the heartbeat and poller
        this.runHeartbeat?.stop();
        this.snapshotPoller?.stop();
      }

      if (error) {
        if (error instanceof SuspendedProcessError) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Run was suspended",
            properties: {
              run: run.friendlyId,
              snapshot: snapshot.friendlyId,
              error: error.message,
            },
          });

          return;
        }

        if (error instanceof ExecutionAbortError) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Run was interrupted",
            properties: {
              run: run.friendlyId,
              snapshot: snapshot.friendlyId,
              error: error.message,
            },
          });

          return;
        }

        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Error while executing attempt",
          properties: {
            error: error.message,
            runId: run.friendlyId,
            snapshotId: snapshot.friendlyId,
          },
        });

        const completion = {
          id: execution.run.id,
          ok: false,
          retry: undefined,
          error: TaskRunProcess.parseExecuteError(error),
        } satisfies TaskRunFailedExecutionResult;

        this.snapshotPoller?.stop();
        await this.complete({ execution, completion });
        this.runHeartbeat?.stop();
      }
    } finally {
      // Ensure we clean up even if aborted
      this.runHeartbeat?.stop();
      this.snapshotPoller?.stop();
    }
  }

  /**
   * Cancels the current execution.
   */
  public async cancel(): Promise<void> {
    this.sendDebugLog({
      runId: this._runFriendlyId,
      message: "cancelling attempt",
      properties: { runId: this._runFriendlyId },
    });

    await this.taskRunProcess?.cancel();
  }

  public exit() {
    if (this.taskRunProcess?.isPreparedForNextRun) {
      this.taskRunProcess.forceExit();
    }
  }

  private async executeRun({
    run,
    snapshot,
    envVars,
    execution,
    metrics,
  }: WorkloadRunAttemptStartResponseBody & {
    metrics?: TaskRunExecutionMetrics;
  }) {
    this.isExecutionActive = true;

    try {
      // To skip this step and eagerly create the task run process, run prepareForExecution first
      if (!this.taskRunProcess || !this.taskRunProcess.isPreparedForNextRun) {
        this.taskRunProcess = new TaskRunProcess({
          workerManifest: this.workerManifest,
          env: envVars,
          serverWorker: {
            id: "managed",
            contentHash: this.env.TRIGGER_CONTENT_HASH,
            version: this.env.TRIGGER_DEPLOYMENT_VERSION,
            engine: "V2",
          },
          machineResources: execution.machine,
          isWarmStart: this.isWarmStart,
        }).initialize();
      }

      this.sendDebugLog({
        runId: this._runFriendlyId,
        message: "executing task run process",
        properties: {
          attemptId: execution.attempt.id,
          runId: execution.run.id,
        },
      });

      // Set up an abort handler that will cleanup the task run process
      this.executionAbortController.signal.addEventListener("abort", async () => {
        this.sendDebugLog({
          runId: this._runFriendlyId,
          message: "Execution aborted during task run, cleaning up process",
          properties: {
            attemptId: execution.attempt.id,
            runId: execution.run.id,
          },
        });

        await this.taskRunProcess?.cleanup(true);
        throw new ExecutionAbortError("Execution aborted during task run");
      });

      const completion = await this.taskRunProcess.execute(
        {
          payload: {
            execution,
            traceContext: execution.run.traceContext ?? {},
            metrics,
          },
          messageId: run.friendlyId,
          env: envVars,
        },
        this.isWarmStart
      );

      // If we get here, the task completed normally
      this.sendDebugLog({
        runId: this._runFriendlyId,
        message: "Completed run",
        properties: { completion: completion.ok },
      });

      // The execution has finished, so we can cleanup the task run process. Killing it should be safe.
      const [error] = await tryCatch(this.taskRunProcess.cleanup(true));

      if (error) {
        this.sendDebugLog({
          runId: this._runFriendlyId,
          message: "Failed to cleanup task run process, submitting completion anyway",
          properties: { error: error.message },
        });
      }

      const [completionError] = await tryCatch(this.complete({ execution, completion }));

      if (completionError) {
        this.sendDebugLog({
          runId: this._runFriendlyId,
          message: "Failed to complete run",
          properties: { error: completionError.message },
        });
      }
    } finally {
      this.isExecutionActive = false;
    }
  }

  private async complete({
    execution,
    completion,
  }: {
    execution: TaskRunExecution;
    completion: TaskRunExecutionResult;
  }): Promise<void> {
    if (!this._runFriendlyId || !this.currentSnapshotId) {
      throw new Error("Cannot complete run: missing run or snapshot ID");
    }

    const completionResult = await this.httpClient.completeRunAttempt(
      this._runFriendlyId,
      this.currentSnapshotId,
      { completion }
    );

    if (!completionResult.success) {
      this.sendDebugLog({
        runId: this._runFriendlyId,
        message: "completion: failed to submit",
        properties: {
          error: completionResult.error,
        },
      });

      return;
    }

    this.sendDebugLog({
      runId: this._runFriendlyId,
      message: "Attempt completion submitted",
      properties: {
        attemptStatus: completionResult.data.result.attemptStatus,
        runId: completionResult.data.result.run.friendlyId,
        snapshotId: completionResult.data.result.snapshot.friendlyId,
      },
    });

    await this.handleCompletionResult({
      completion,
      result: completionResult.data.result,
    });
  }

  private async handleCompletionResult({
    completion,
    result,
  }: {
    completion: TaskRunExecutionResult;
    result: CompleteRunAttemptResult;
  }) {
    this.sendDebugLog({
      runId: this._runFriendlyId,
      message: "Handling completion result",
      properties: {
        completion: completion.ok,
        attemptStatus: result.attemptStatus,
        snapshotId: result.snapshot.friendlyId,
        runId: result.run.friendlyId,
      },
    });

    // Update our snapshot ID to match the completion result
    // This ensures any subsequent API calls use the correct snapshot
    this.currentSnapshotId = result.snapshot.friendlyId;

    const { attemptStatus } = result;

    if (attemptStatus === "RUN_FINISHED") {
      this.sendDebugLog({
        runId: this._runFriendlyId,
        message: "Run finished",
      });

      return;
    }

    if (attemptStatus === "RUN_PENDING_CANCEL") {
      this.sendDebugLog({
        runId: this._runFriendlyId,
        message: "Run pending cancel",
      });
      return;
    }

    if (attemptStatus === "RETRY_QUEUED") {
      this.sendDebugLog({
        runId: this._runFriendlyId,
        message: "Retry queued",
      });

      return;
    }

    if (attemptStatus === "RETRY_IMMEDIATELY") {
      if (completion.ok) {
        throw new Error("Should retry but completion OK.");
      }

      if (!completion.retry) {
        throw new Error("Should retry but missing retry params.");
      }

      await this.retry({ result, delay: completion.retry.delay });
      return;
    }

    assertExhaustive(attemptStatus);
  }

  private async retry({ result, delay }: { result: CompleteRunAttemptResult; delay: number }) {
    await sleep(delay);

    await this.execute({
      runFriendlyId: result.run.id,
      snapshotFriendlyId: result.snapshot.friendlyId,
      isWarmStart: true,
    });
  }

  /**
   * Suspends the current execution.
   */
  private async suspend(): Promise<void> {
    try {
      if (!this._runFriendlyId || !this.currentSnapshotId) {
        this.sendDebugLog({
          runId: this._runFriendlyId,
          message: "Cannot suspend: missing run or snapshot ID",
        });

        return;
      }

      const suspendResult = await this.httpClient.suspendRun(
        this._runFriendlyId,
        this.currentSnapshotId
      );

      if (!suspendResult.success) {
        this.sendDebugLog({
          runId: this._runFriendlyId,
          message: "Failed to suspend run, staying alive 🎶",
          properties: {
            error: suspendResult.error,
          },
        });

        return;
      }

      if (!suspendResult.data.ok) {
        this.sendDebugLog({
          runId: this._runFriendlyId,
          message: "checkpoint: failed to suspend run",
          properties: {
            snapshotId: this.currentSnapshotId,
            error: suspendResult.data.error,
          },
        });

        return;
      }

      this.sendDebugLog({
        runId: this._runFriendlyId,
        message: "Suspending, any day now 🚬",
        properties: { ok: suspendResult.data.ok },
      });

      await this.taskRunProcess?.suspend();
    } finally {
      this.abortExecution();
    }
  }

  /**
   * Restores a suspended execution from PENDING_EXECUTING
   */
  private async restore(): Promise<void> {
    try {
      if (!this._runFriendlyId || !this.currentSnapshotId) {
        throw new Error("Cannot restore: missing run or snapshot ID");
      }

      // Track restore count
      this.restoreCount++;

      // Short delay to give websocket time to reconnect
      await sleep(100);

      // Process any env overrides
      await this.processEnvOverrides();

      const continuationResult = await this.httpClient.continueRunExecution(
        this._runFriendlyId,
        this.currentSnapshotId
      );

      if (!continuationResult.success) {
        this.sendDebugLog({
          runId: this._runFriendlyId,
          message: "failed to restore execution",
          properties: {
            error: continuationResult.error,
          },
        });

        return;
      }
    } catch (error) {
      this.sendDebugLog({
        runId: this._runFriendlyId,
        message: "failed to restore execution",
        properties: { error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      this.abortExecution();
    }
  }

  /**
   * Processes env overrides from the metadata service. Generally called when we're resuming from a suspended state.
   */
  private async processEnvOverrides() {
    if (!this.env.TRIGGER_METADATA_URL) {
      this.sendDebugLog({
        runId: this._runFriendlyId,
        message: "No metadata URL, skipping env overrides",
      });
      return;
    }

    const metadataClient = new MetadataClient(this.env.TRIGGER_METADATA_URL);
    const overrides = await metadataClient.getEnvOverrides();

    if (!overrides) {
      this.sendDebugLog({
        runId: this._runFriendlyId,
        message: "No env overrides, skipping",
      });
      return;
    }

    this.sendDebugLog({
      runId: this._runFriendlyId,
      message: "Processing env overrides",
      properties: { ...overrides },
    });

    // Override the env with the new values
    this.env.override(overrides);

    // Update services with new values
    if (overrides.TRIGGER_HEARTBEAT_INTERVAL_SECONDS) {
      this.runHeartbeat?.updateInterval(this.env.TRIGGER_HEARTBEAT_INTERVAL_SECONDS * 1000);
    }
    if (overrides.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS) {
      this.snapshotPoller?.updateInterval(this.env.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS * 1000);
    }
    if (
      overrides.TRIGGER_SUPERVISOR_API_PROTOCOL ||
      overrides.TRIGGER_SUPERVISOR_API_DOMAIN ||
      overrides.TRIGGER_SUPERVISOR_API_PORT
    ) {
      this.httpClient.updateApiUrl(this.env.TRIGGER_SUPERVISOR_API_URL);
    }
    if (overrides.TRIGGER_RUNNER_ID) {
      this.httpClient.updateRunnerId(this.env.TRIGGER_RUNNER_ID);
    }
  }

  sendDebugLog(opts: SendDebugLogOptions) {
    this.logger.sendDebugLog({
      ...opts,
      properties: {
        ...opts.properties,
        executionRestoreCount: this.restoreCount,
      },
    });
  }

  public get runFriendlyId(): string | undefined {
    return this._runFriendlyId;
  }

  public get currentSnapshotFriendlyId(): string | undefined {
    return this.currentSnapshotId;
  }

  public get taskRunEnv(): Record<string, string> | null {
    return this.currentTaskRunEnv;
  }

  public get metrics() {
    return {
      restoreCount: this.restoreCount,
    };
  }

  private abortExecution() {
    if (this.isExecutionActive) {
      this.executionAbortController.abort();
    }
  }
}
