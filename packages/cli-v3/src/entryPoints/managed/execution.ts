import {
  type CompleteRunAttemptResult,
  type RunExecutionData,
  SuspendedProcessError,
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

class ExecutionExitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionExitError";
  }
}

type RunExecutionOptions = {
  runFriendlyId: string;
  snapshotFriendlyId: string;
  dequeuedAt?: Date;
  podScheduledAt?: Date;
  isWarmStart?: boolean;
  workerManifest: WorkerManifest;
  env: RunnerEnv;
  httpClient: WorkloadHttpClient;
  logger: RunLogger;
};

export class RunExecution {
  private executionAbortController = new AbortController();
  private isExecutionActive = false;

  public readonly runFriendlyId: string;

  private currentSnapshotId: string;
  private currentTaskRunEnv: Record<string, string> | null = null;

  private readonly dequeuedAt?: Date;
  private readonly podScheduledAt?: Date;
  private isWarmStart: boolean;
  private readonly workerManifest: WorkerManifest;
  private readonly env: RunnerEnv;
  private readonly httpClient: WorkloadHttpClient;
  private readonly logger: RunLogger;
  private restoreCount = 0;

  private taskRunProcess?: TaskRunProcess;
  private readonly runHeartbeat: RunExecutionHeartbeat;
  private readonly snapshotPoller: RunExecutionSnapshotPoller;

  constructor(opts: RunExecutionOptions) {
    this.runFriendlyId = opts.runFriendlyId;
    this.currentSnapshotId = opts.snapshotFriendlyId;
    this.dequeuedAt = opts.dequeuedAt;
    this.podScheduledAt = opts.podScheduledAt;
    this.isWarmStart = opts.isWarmStart ?? false;
    this.workerManifest = opts.workerManifest;
    this.env = opts.env;
    this.httpClient = opts.httpClient;
    this.logger = opts.logger;

    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "Run execution created",
      properties: {
        runId: this.runFriendlyId,
        snapshotId: this.currentSnapshotId,
        isWarmStart: this.isWarmStart,
        dequeuedAt: this.dequeuedAt?.toISOString(),
        podScheduledAt: this.podScheduledAt?.toISOString(),
      },
    });

    this.runHeartbeat = new RunExecutionHeartbeat({
      runFriendlyId: this.runFriendlyId,
      snapshotFriendlyId: this.currentSnapshotId,
      httpClient: this.httpClient,
      logger: this.logger,
      heartbeatIntervalSeconds: this.env.TRIGGER_HEARTBEAT_INTERVAL_SECONDS,
    });

    this.snapshotPoller = new RunExecutionSnapshotPoller({
      runFriendlyId: this.runFriendlyId,
      snapshotFriendlyId: this.currentSnapshotId,
      httpClient: this.httpClient,
      logger: this.logger,
      snapshotPollIntervalSeconds: this.env.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS,
      handleSnapshotChange: this.handleSnapshotChange.bind(this),
    });
  }

  // TODO: we need to be able to exit the execution here if we need to
  /**
   * Called by the RunController when it receives a websocket notification
   * or when the snapshot poller detects a change
   */
  public async handleSnapshotChange(runData: RunExecutionData): Promise<void> {
    const { run, snapshot, completedWaitpoints } = runData;

    // Ensure the run ID matches
    if (run.friendlyId !== this.runFriendlyId) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "handleSnapshotChange: mismatched run IDs",
        properties: {
          currentRunId: this.runFriendlyId,
          newRunId: run.friendlyId,
          currentSnapshotId: this.currentSnapshotId,
          newSnapshotId: snapshot.friendlyId,
        },
      });
      return;
    }

    this.sendDebugLog({
      runId: this.runFriendlyId,
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
          runId: this.runFriendlyId,
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
    if (snapshot.friendlyId < this.currentSnapshotId) {
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
        runId: this.runFriendlyId,
        message: "handleSnapshotChange: snapshot not changed",
        properties: { snapshot: snapshot.friendlyId },
      });
      return;
    }

    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: `snapshot change: ${snapshot.executionStatus}`,
      properties: {
        oldSnapshotId: this.currentSnapshotId,
        newSnapshotId: snapshot.friendlyId,
        completedWaitpoints: completedWaitpoints.length,
      },
    });

    // Reset the snapshot poll interval so we don't do unnecessary work
    this.snapshotPoller.resetCurrentInterval();

    // Update internal state
    this.currentSnapshotId = snapshot.friendlyId;

    // Update services
    this.runHeartbeat.updateSnapshotId(snapshot.friendlyId);
    this.snapshotPoller.updateSnapshotId(snapshot.friendlyId);

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

        this.signalExecutionExit();
        return;
      }
      case "FINISHED": {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Run is finished",
        });

        // Pretend we've just suspended the run. This will kill the process without failing the run.
        await this.taskRunProcess?.suspend();
        this.signalExecutionExit();
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
            message: "Failed to cleanup task run process",
            properties: { error: error.message },
          });
        }

        if (snapshot.friendlyId !== this.snapshotFriendlyId) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Snapshot changed after cleanup, abort",
            properties: {
              oldSnapshotId: snapshot.friendlyId,
              newSnapshotId: this.snapshotFriendlyId,
            },
          });
          return;
        }

        await sleep(this.env.TRIGGER_PRE_SUSPEND_WAIT_MS);

        if (snapshot.friendlyId !== this.snapshotFriendlyId) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "Snapshot changed after suspend threshold, abort",
            properties: {
              oldSnapshotId: snapshot.friendlyId,
              newSnapshotId: this.snapshotFriendlyId,
            },
          });
          return;
        }

        if (!this.runFriendlyId || !this.snapshotFriendlyId) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "handleSnapshotChange: Missing run ID or snapshot ID after suspension, abort",
            properties: {
              runId: this.runFriendlyId,
              snapshotId: this.snapshotFriendlyId,
            },
          });
          return;
        }

        const suspendResult = await this.httpClient.suspendRun(
          this.runFriendlyId,
          this.snapshotFriendlyId
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
              snapshotId: snapshot.friendlyId,
              error: suspendResult.error,
            },
          });

          return;
        }

        if (!suspendResult.data.ok) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "checkpoint: failed to suspend run",
            properties: {
              snapshotId: snapshot.friendlyId,
              error: suspendResult.data.error,
            },
          });

          return;
        }

        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Suspending, any day now 🚬",
          properties: { ok: suspendResult.data.ok },
        });
        return;
      }
      case "SUSPENDED": {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Run was suspended, kill the process",
          properties: { run: run.friendlyId, snapshot: snapshot.friendlyId },
        });

        await this.taskRunProcess?.suspend();
        this.signalExecutionExit();
        return;
      }
      case "PENDING_EXECUTING": {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Run is pending execution",
          properties: { run: run.friendlyId, snapshot: snapshot.friendlyId },
        });

        if (completedWaitpoints.length === 0) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "No waitpoints to complete, nothing to do",
          });
          return;
        }

        // Track restore count
        this.restoreCount++;

        // Short delay to give websocket time to reconnect
        await sleep(100);

        // Process any env overrides
        await this.processEnvOverrides();

        // We need to let the platform know we're ready to continue
        const continuationResult = await this.httpClient.continueRunExecution(
          run.friendlyId,
          snapshot.friendlyId
        );

        if (!continuationResult.success) {
          this.sendDebugLog({
            runId: run.friendlyId,
            message: "failed to continue execution",
            properties: {
              error: continuationResult.error,
            },
          });

          // TODO: exit any active executions
          return;
        }

        return;
      }
      case "EXECUTING": {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "Run is now executing",
          properties: { run: run.friendlyId, snapshot: snapshot.friendlyId },
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
          message: "Status change not handled",
          properties: { status: snapshot.executionStatus },
        });
        return;
      }
      default: {
        assertExhaustive(snapshot.executionStatus);
      }
    }
  }

  /**
   * Eagerly creates the TaskRunProcess for this execution.
   * This is useful for warm starts where we want to prepare the process before we have the run details.
   */
  public prepareForExecution(taskRunEnv: Record<string, string>): void {
    if (this.taskRunProcess) {
      return;
    }

    this.taskRunProcess = new TaskRunProcess({
      workerManifest: this.workerManifest,
      // FIXME: this is not enough, we need the env vars of the first run - think secret API keys etc
      env: taskRunEnv,
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

  /**
   * Executes the run. This will return when the execution is complete and we should warm start.
   * When this returns, the child process will have been cleaned up.
   */
  public async execute(): Promise<void> {
    // Reset abort controller for new execution
    this.executionAbortController = new AbortController();

    // Start the heartbeat and poller
    this.runHeartbeat.start();
    this.snapshotPoller.start();

    try {
      const attemptStartedAt = Date.now();

      // Check for abort before each major async operation
      if (this.executionAbortController.signal.aborted) {
        throw new ExecutionExitError("Execution aborted before start");
      }

      const start = await this.httpClient.startRunAttempt(
        this.runFriendlyId,
        this.currentSnapshotId,
        {
          isWarmStart: this.isWarmStart,
        }
      );

      if (this.executionAbortController.signal.aborted) {
        throw new ExecutionExitError("Execution aborted after start");
      }

      if (!start.success) {
        this.sendDebugLog({
          runId: this.runFriendlyId,
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
        this.runHeartbeat.stop();
        this.snapshotPoller.stop();
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

        if (error instanceof ExecutionExitError) {
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

        this.snapshotPoller.stop();
        await this.complete(completion);
        this.runHeartbeat.stop();
      }
    } finally {
      // Ensure we clean up even if aborted
      this.runHeartbeat.stop();
      this.snapshotPoller.stop();
    }
  }

  /**
   * Cancels the current execution.
   */
  public async cancel(): Promise<void> {
    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "cancelling attempt",
      properties: { runId: this.runFriendlyId },
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
        runId: this.runFriendlyId,
        message: "executing task run process",
        properties: {
          attemptId: execution.attempt.id,
          runId: execution.run.id,
        },
      });

      // Set up an abort handler that will cleanup the task run process
      this.executionAbortController.signal.addEventListener("abort", async () => {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "Execution aborted during task run, cleaning up process",
          properties: {
            attemptId: execution.attempt.id,
            runId: execution.run.id,
          },
        });

        await this.taskRunProcess?.cleanup(true);
        throw new ExecutionExitError("Execution aborted during task run");
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
        runId: this.runFriendlyId,
        message: "Completed run",
        properties: { completion: completion.ok },
      });

      // The execution has finished, so we can cleanup the task run process. Killing it should be safe.
      const [error] = await tryCatch(this.taskRunProcess.cleanup(true));

      if (error) {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "Failed to cleanup task run process, submitting completion anyway",
          properties: { error: error.message },
        });
      }

      const [completionError] = await tryCatch(this.complete(completion));

      if (completionError) {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "Failed to complete run",
          properties: { error: completionError.message },
        });
      }
    } finally {
      this.isExecutionActive = false;
    }
  }

  private async complete(completion: TaskRunExecutionResult): Promise<void> {
    const completionResult = await this.httpClient.completeRunAttempt(
      this.runFriendlyId,
      this.currentSnapshotId,
      { completion }
    );

    if (!completionResult.success) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "completion: failed to submit",
        properties: {
          error: completionResult.error,
        },
      });

      return;
    }

    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "Attempt completion submitted",
      properties: {
        attemptStatus: completionResult.data.result.attemptStatus,
        runId: completionResult.data.result.run.friendlyId,
        snapshotId: completionResult.data.result.snapshot.friendlyId,
      },
    });

    await this.handleCompletionResult(completion, completionResult.data.result);
  }

  private async handleCompletionResult(
    completion: TaskRunExecutionResult,
    result: CompleteRunAttemptResult
  ) {
    this.sendDebugLog({
      runId: this.runFriendlyId,
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
        runId: this.runFriendlyId,
        message: "Run finished",
      });

      return;
    }

    if (attemptStatus === "RUN_PENDING_CANCEL") {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "Run pending cancel",
      });
      return;
    }

    if (attemptStatus === "RETRY_QUEUED") {
      this.sendDebugLog({
        runId: this.runFriendlyId,
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

      await sleep(completion.retry.delay);

      // FIXME: this is wrong
      // Create a new execution for the retry
      const retryExecution = new RunExecution({
        ...this,
        isWarmStart: true,
      });

      this.isWarmStart = true;

      await this.execute();
      return;
    }

    assertExhaustive(attemptStatus);
  }

  /**
   * Suspends the current execution.
   */
  public async suspend(): Promise<void> {
    const suspendResult = await this.httpClient.suspendRun(
      this.runFriendlyId,
      this.currentSnapshotId
    );

    if (!suspendResult.success) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "Failed to suspend run, staying alive 🎶",
        properties: {
          error: suspendResult.error,
        },
      });

      return;
    }

    if (!suspendResult.data.ok) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "checkpoint: failed to suspend run",
        properties: {
          snapshotId: this.currentSnapshotId,
          error: suspendResult.data.error,
        },
      });

      return;
    }

    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "Suspending, any day now 🚬",
      properties: { ok: suspendResult.data.ok },
    });

    await this.taskRunProcess?.suspend();
  }

  // TODO: remove if not needed
  /**
   * Resumes a suspended execution.
   */
  public async resume(): Promise<void> {
    // Process any env overrides
    await this.processEnvOverrides();

    const continuationResult = await this.httpClient.continueRunExecution(
      this.runFriendlyId,
      this.currentSnapshotId
    );

    if (!continuationResult.success) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "failed to continue execution",
        properties: {
          error: continuationResult.error,
        },
      });

      return;
    }
  }

  /**
   * Processes env overrides from the metadata service. Generally called when we're resuming from a suspended state.
   */
  private async processEnvOverrides() {
    if (!this.env.TRIGGER_METADATA_URL) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "No metadata URL, skipping env overrides",
      });
      return;
    }

    const metadataClient = new MetadataClient(this.env.TRIGGER_METADATA_URL);
    const overrides = await metadataClient.getEnvOverrides();

    if (!overrides) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "No env overrides, skipping",
      });
      return;
    }

    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "Processing env overrides",
      properties: { ...overrides },
    });

    // Override the env with the new values
    this.env.override(overrides);

    // Update services with new values
    if (overrides.TRIGGER_HEARTBEAT_INTERVAL_SECONDS) {
      this.runHeartbeat.updateInterval(this.env.TRIGGER_HEARTBEAT_INTERVAL_SECONDS * 1000);
    }
    if (overrides.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS) {
      this.snapshotPoller.updateInterval(this.env.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS * 1000);
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

  // Add getter for current snapshot ID
  public get snapshotFriendlyId(): string {
    return this.currentSnapshotId;
  }

  // Add getter for current task run env
  public get taskRunEnv(): Record<string, string> | null {
    return this.currentTaskRunEnv;
  }

  // Add getter for metrics
  public get metrics() {
    return {
      restoreCount: this.restoreCount,
    };
  }

  private signalExecutionExit() {
    if (this.isExecutionActive) {
      this.executionAbortController.abort();
    }
  }
}
