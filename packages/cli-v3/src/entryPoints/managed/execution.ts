import {
  type CompleteRunAttemptResult,
  type RunExecutionData,
  SuspendedProcessError,
  type TaskRunExecutionMetrics,
  type TaskRunExecutionResult,
  TaskRunExecutionRetry,
  type TaskRunFailedExecutionResult,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import { type WorkloadRunAttemptStartResponseBody } from "@trigger.dev/core/v3/workers";
import { TaskRunProcess } from "../../executions/taskRunProcess.js";
import { RunLogger, SendDebugLogOptions } from "./logger.js";
import { RunnerEnv } from "./env.js";
import { WorkloadHttpClient } from "@trigger.dev/core/v3/workers";
import { setTimeout as sleep } from "timers/promises";
import { RunExecutionSnapshotPoller } from "./poller.js";
import { assertExhaustive, tryCatch } from "@trigger.dev/core/utils";
import { MetadataClient } from "./overrides.js";
import { randomBytes } from "node:crypto";

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
  private id: string;
  private executionAbortController: AbortController;

  private _runFriendlyId?: string;
  private currentSnapshotId?: string;
  private currentAttemptNumber?: number;
  private currentTaskRunEnv?: Record<string, string>;

  private dequeuedAt?: Date;
  private podScheduledAt?: Date;
  private readonly workerManifest: WorkerManifest;
  private readonly env: RunnerEnv;
  private readonly httpClient: WorkloadHttpClient;
  private readonly logger: RunLogger;
  private restoreCount: number;

  private taskRunProcess?: TaskRunProcess;
  private snapshotPoller?: RunExecutionSnapshotPoller;

  private lastHeartbeat?: Date;
  private isShuttingDown = false;

  constructor(opts: RunExecutionOptions) {
    this.id = randomBytes(4).toString("hex");
    this.workerManifest = opts.workerManifest;
    this.env = opts.env;
    this.httpClient = opts.httpClient;
    this.logger = opts.logger;

    this.restoreCount = 0;
    this.executionAbortController = new AbortController();
  }

  /**
   * Prepares the execution with task run environment variables.
   * This should be called before executing, typically after a successful run to prepare for the next one.
   */
  public prepareForExecution(opts: RunExecutionPrepareOptions): this {
    if (this.taskRunProcess) {
      throw new Error("prepareForExecution called after process was already created");
    }

    this.taskRunProcess = this.createTaskRunProcess({
      envVars: opts.taskRunEnv,
      isWarmStart: true,
    });

    return this;
  }

  private createTaskRunProcess({
    envVars,
    isWarmStart,
  }: {
    envVars: Record<string, string>;
    isWarmStart?: boolean;
  }) {
    const taskRunProcess = new TaskRunProcess({
      workerManifest: this.workerManifest,
      env: {
        ...envVars,
        ...this.env.gatherProcessEnv(),
        HEARTBEAT_INTERVAL_MS: String(this.env.TRIGGER_HEARTBEAT_INTERVAL_SECONDS * 1000),
      },
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
      isWarmStart,
    }).initialize();

    taskRunProcess.onTaskRunHeartbeat.attach(async (runId) => {
      if (!this.runFriendlyId) {
        this.sendDebugLog("onTaskRunHeartbeat: missing run ID", { heartbeatRunId: runId });
        return;
      }

      if (runId !== this.runFriendlyId) {
        this.sendDebugLog("onTaskRunHeartbeat: mismatched run ID", {
          heartbeatRunId: runId,
          expectedRunId: this.runFriendlyId,
        });
        return;
      }

      const [error] = await tryCatch(this.onHeartbeat());

      if (error) {
        this.sendDebugLog("onTaskRunHeartbeat: failed", { error: error.message });
      }
    });

    return taskRunProcess;
  }

  /**
   * Returns true if no run has been started yet and the process is prepared for the next run.
   */
  get canExecute(): boolean {
    // If we've ever had a run ID, this execution can't be reused
    if (this._runFriendlyId) {
      return false;
    }

    return !!this.taskRunProcess?.isPreparedForNextRun;
  }

  /**
   * Called by the RunController when it receives a websocket notification
   * or when the snapshot poller detects a change
   */
  public async handleSnapshotChange(runData: RunExecutionData): Promise<void> {
    if (this.isShuttingDown) {
      this.sendDebugLog("handleSnapshotChange: shutting down, skipping");
      return;
    }

    const { run, snapshot, completedWaitpoints } = runData;

    const snapshotMetadata = {
      incomingRunId: run.friendlyId,
      incomingSnapshotId: snapshot.friendlyId,
      completedWaitpoints: completedWaitpoints.length,
    };

    // Ensure we have run details
    if (!this.runFriendlyId || !this.currentSnapshotId) {
      this.sendDebugLog(
        "handleSnapshotChange: missing run or snapshot ID",
        snapshotMetadata,
        run.friendlyId
      );
      return;
    }

    // Ensure the run ID matches
    if (run.friendlyId !== this.runFriendlyId) {
      // Send debug log to both runs
      this.sendDebugLog("handleSnapshotChange: mismatched run IDs", snapshotMetadata);
      this.sendDebugLog(
        "handleSnapshotChange: mismatched run IDs",
        snapshotMetadata,
        run.friendlyId
      );
      return;
    }

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
        this.sendDebugLog("Failed to process snapshot change", { error: error.message });
      }
    }
    this.snapshotChangeQueueLock = false;
  }

  private async processSnapshotChange(runData: RunExecutionData): Promise<void> {
    const { run, snapshot, completedWaitpoints } = runData;

    const snapshotMetadata = {
      incomingSnapshotId: snapshot.friendlyId,
      completedWaitpoints: completedWaitpoints.length,
    };

    // Check if the incoming snapshot is newer than the current one
    if (!this.currentSnapshotId || snapshot.friendlyId < this.currentSnapshotId) {
      this.sendDebugLog(
        "handleSnapshotChange: received older snapshot, skipping",
        snapshotMetadata
      );
      return;
    }

    if (snapshot.friendlyId === this.currentSnapshotId) {
      return;
    }

    if (this.currentAttemptNumber && this.currentAttemptNumber !== run.attemptNumber) {
      this.sendDebugLog("ERROR: attempt number mismatch", snapshotMetadata);
      await this.taskRunProcess?.suspend();
      return;
    }

    this.sendDebugLog(`snapshot has changed to: ${snapshot.executionStatus}`, snapshotMetadata);

    // Reset the snapshot poll interval so we don't do unnecessary work
    this.snapshotPoller?.resetCurrentInterval();

    // Update internal state
    this.currentSnapshotId = snapshot.friendlyId;

    // Update services
    this.snapshotPoller?.updateSnapshotId(snapshot.friendlyId);

    switch (snapshot.executionStatus) {
      case "PENDING_CANCEL": {
        const [error] = await tryCatch(this.cancel());

        if (error) {
          this.sendDebugLog("snapshot change: failed to cancel attempt", {
            ...snapshotMetadata,
            error: error.message,
          });
        }

        this.abortExecution();
        return;
      }
      case "QUEUED": {
        this.sendDebugLog("Run was re-queued", snapshotMetadata);

        // Pretend we've just suspended the run. This will kill the process without failing the run.
        await this.taskRunProcess?.suspend();
        return;
      }
      case "FINISHED": {
        this.sendDebugLog("Run is finished", snapshotMetadata);

        // Pretend we've just suspended the run. This will kill the process without failing the run.
        await this.taskRunProcess?.suspend();
        return;
      }
      case "QUEUED_EXECUTING":
      case "EXECUTING_WITH_WAITPOINTS": {
        this.sendDebugLog("Run is executing with waitpoints", snapshotMetadata);

        const [error] = await tryCatch(this.taskRunProcess?.cleanup(false));

        if (error) {
          this.sendDebugLog("Failed to cleanup task run process, carrying on", {
            ...snapshotMetadata,
            error: error.message,
          });
        }

        if (snapshot.friendlyId !== this.currentSnapshotId) {
          this.sendDebugLog("Snapshot changed after cleanup, abort", snapshotMetadata);

          this.abortExecution();
          return;
        }

        await sleep(this.env.TRIGGER_PRE_SUSPEND_WAIT_MS);

        if (snapshot.friendlyId !== this.currentSnapshotId) {
          this.sendDebugLog("Snapshot changed after suspend threshold, abort", snapshotMetadata);

          this.abortExecution();
          return;
        }

        if (!this.runFriendlyId || !this.currentSnapshotId) {
          this.sendDebugLog(
            "handleSnapshotChange: Missing run ID or snapshot ID after suspension, abort",
            snapshotMetadata
          );

          this.abortExecution();
          return;
        }

        const suspendResult = await this.httpClient.suspendRun(
          this.runFriendlyId,
          this.currentSnapshotId
        );

        if (!suspendResult.success) {
          this.sendDebugLog("Failed to suspend run, staying alive 🎶", {
            ...snapshotMetadata,
            error: suspendResult.error,
          });

          this.sendDebugLog("checkpoint: suspend request failed", {
            ...snapshotMetadata,
            error: suspendResult.error,
          });

          // This is fine, we'll wait for the next status change
          return;
        }

        if (!suspendResult.data.ok) {
          this.sendDebugLog("checkpoint: failed to suspend run", {
            snapshotId: this.currentSnapshotId,
            error: suspendResult.data.error,
          });

          // This is fine, we'll wait for the next status change
          return;
        }

        this.sendDebugLog("Suspending, any day now 🚬", snapshotMetadata);

        // Wait for next status change
        return;
      }
      case "SUSPENDED": {
        this.sendDebugLog("Run was suspended, kill the process", snapshotMetadata);

        // This will kill the process and fail the execution with a SuspendedProcessError
        await this.taskRunProcess?.suspend();

        return;
      }
      case "PENDING_EXECUTING": {
        this.sendDebugLog("Run is pending execution", snapshotMetadata);

        if (completedWaitpoints.length === 0) {
          this.sendDebugLog("No waitpoints to complete, nothing to do", snapshotMetadata);
          return;
        }

        const [error] = await tryCatch(this.restore());

        if (error) {
          this.sendDebugLog("Failed to restore execution", {
            ...snapshotMetadata,
            error: error.message,
          });

          this.abortExecution();
          return;
        }

        return;
      }
      case "EXECUTING": {
        this.sendDebugLog("Run is now executing", snapshotMetadata);

        if (completedWaitpoints.length === 0) {
          return;
        }

        this.sendDebugLog("Processing completed waitpoints", snapshotMetadata);

        if (!this.taskRunProcess) {
          this.sendDebugLog("No task run process, ignoring completed waitpoints", snapshotMetadata);

          this.abortExecution();
          return;
        }

        for (const waitpoint of completedWaitpoints) {
          this.taskRunProcess.waitpointCompleted(waitpoint);
        }

        return;
      }
      case "RUN_CREATED": {
        this.sendDebugLog("Invalid status change", snapshotMetadata);

        this.abortExecution();
        return;
      }
      default: {
        assertExhaustive(snapshot.executionStatus);
      }
    }
  }

  private async startAttempt({
    isWarmStart,
  }: {
    isWarmStart?: boolean;
  }): Promise<WorkloadRunAttemptStartResponseBody & { metrics: TaskRunExecutionMetrics }> {
    if (!this.runFriendlyId || !this.currentSnapshotId) {
      throw new Error("Cannot start attempt: missing run or snapshot ID");
    }

    this.sendDebugLog("Starting attempt");

    const attemptStartedAt = Date.now();

    // Check for abort before each major async operation
    if (this.executionAbortController.signal.aborted) {
      throw new ExecutionAbortError("Execution aborted before start");
    }

    const start = await this.httpClient.startRunAttempt(
      this.runFriendlyId,
      this.currentSnapshotId,
      { isWarmStart }
    );

    if (this.executionAbortController.signal.aborted) {
      throw new ExecutionAbortError("Execution aborted after start");
    }

    if (!start.success) {
      throw new Error(`Start API call failed: ${start.error}`);
    }

    // A snapshot was just created, so update the snapshot ID
    this.currentSnapshotId = start.data.snapshot.friendlyId;

    // Also set or update the attempt number - we do this to detect illegal attempt number changes, e.g. from stalled runners coming back online
    const attemptNumber = start.data.run.attemptNumber;
    if (attemptNumber) {
      this.currentAttemptNumber = attemptNumber;
    } else {
      this.sendDebugLog("ERROR: no attempt number returned from start attempt");
    }

    const metrics = this.measureExecutionMetrics({
      attemptCreatedAt: attemptStartedAt,
      dequeuedAt: this.dequeuedAt?.getTime(),
      podScheduledAt: this.podScheduledAt?.getTime(),
    });

    this.sendDebugLog("Started attempt");

    return { ...start.data, metrics };
  }

  /**
   * Executes the run. This will return when the execution is complete and we should warm start.
   * When this returns, the child process will have been cleaned up.
   */
  public async execute(runOpts: RunExecutionRunOptions): Promise<void> {
    // Setup initial state
    this.runFriendlyId = runOpts.runFriendlyId;
    this.currentSnapshotId = runOpts.snapshotFriendlyId;
    this.dequeuedAt = runOpts.dequeuedAt;
    this.podScheduledAt = runOpts.podScheduledAt;

    // Create and start services
    this.snapshotPoller = new RunExecutionSnapshotPoller({
      runFriendlyId: this.runFriendlyId,
      snapshotFriendlyId: this.currentSnapshotId,
      httpClient: this.httpClient,
      logger: this.logger,
      snapshotPollIntervalSeconds: this.env.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS,
      handleSnapshotChange: this.handleSnapshotChange.bind(this),
    });

    this.snapshotPoller.start();

    const [startError, start] = await tryCatch(
      this.startAttempt({ isWarmStart: runOpts.isWarmStart })
    );

    if (startError) {
      this.sendDebugLog("Failed to start attempt", { error: startError.message });

      this.stopServices();
      return;
    }

    const [executeError] = await tryCatch(this.executeRunWrapper(start));

    if (executeError) {
      this.sendDebugLog("Failed to execute run", { error: executeError.message });

      this.stopServices();
      return;
    }

    this.stopServices();
  }

  private async executeRunWrapper({
    run,
    snapshot,
    envVars,
    execution,
    metrics,
    isWarmStart,
  }: WorkloadRunAttemptStartResponseBody & {
    metrics: TaskRunExecutionMetrics;
    isWarmStart?: boolean;
  }) {
    this.currentTaskRunEnv = envVars;

    const [executeError] = await tryCatch(
      this.executeRun({
        run,
        snapshot,
        envVars,
        execution,
        metrics,
        isWarmStart,
      })
    );

    this.sendDebugLog("Run execution completed", { error: executeError?.message });

    if (!executeError) {
      this.stopServices();
      return;
    }

    if (executeError instanceof SuspendedProcessError) {
      this.sendDebugLog("Run was suspended", {
        run: run.friendlyId,
        snapshot: snapshot.friendlyId,
        error: executeError.message,
      });

      return;
    }

    if (executeError instanceof ExecutionAbortError) {
      this.sendDebugLog("Run was interrupted", {
        run: run.friendlyId,
        snapshot: snapshot.friendlyId,
        error: executeError.message,
      });

      return;
    }

    this.sendDebugLog("Error while executing attempt", {
      error: executeError.message,
      runId: run.friendlyId,
      snapshotId: snapshot.friendlyId,
    });

    const completion = {
      id: execution.run.id,
      ok: false,
      retry: undefined,
      error: TaskRunProcess.parseExecuteError(executeError),
    } satisfies TaskRunFailedExecutionResult;

    const [completeError] = await tryCatch(this.complete({ completion }));

    if (completeError) {
      this.sendDebugLog("Failed to complete run", { error: completeError.message });
    }

    this.stopServices();
  }

  private async executeRun({
    run,
    snapshot,
    envVars,
    execution,
    metrics,
    isWarmStart,
  }: WorkloadRunAttemptStartResponseBody & {
    metrics: TaskRunExecutionMetrics;
    isWarmStart?: boolean;
  }) {
    // For immediate retries, we need to ensure the task run process is prepared for the next attempt
    if (
      this.runFriendlyId &&
      this.taskRunProcess &&
      !this.taskRunProcess.isPreparedForNextAttempt
    ) {
      this.sendDebugLog("killing existing task run process before executing next attempt");
      await this.kill().catch(() => {});
    }

    // To skip this step and eagerly create the task run process, run prepareForExecution first
    if (!this.taskRunProcess || !this.taskRunProcess.isPreparedForNextRun) {
      this.taskRunProcess = this.createTaskRunProcess({ envVars, isWarmStart });
    }

    this.sendDebugLog("executing task run process", { runId: execution.run.id });

    // Set up an abort handler that will cleanup the task run process
    this.executionAbortController.signal.addEventListener("abort", async () => {
      this.sendDebugLog("Execution aborted during task run, cleaning up process", {
        runId: execution.run.id,
      });

      await this.taskRunProcess?.cleanup(true);
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
      isWarmStart
    );

    // If we get here, the task completed normally
    this.sendDebugLog("Completed run attempt", { attemptSuccess: completion.ok });

    // The execution has finished, so we can cleanup the task run process. Killing it should be safe.
    const [error] = await tryCatch(this.taskRunProcess.cleanup(true));

    if (error) {
      this.sendDebugLog("Failed to cleanup task run process, submitting completion anyway", {
        error: error.message,
      });
    }

    const [completionError] = await tryCatch(this.complete({ completion }));

    if (completionError) {
      this.sendDebugLog("Failed to complete run", { error: completionError.message });
    }
  }

  /**
   * Cancels the current execution.
   */
  public async cancel(): Promise<void> {
    this.sendDebugLog("cancelling attempt", { runId: this.runFriendlyId });

    await this.taskRunProcess?.cancel();
  }

  public exit() {
    if (this.taskRunProcess?.isPreparedForNextRun) {
      this.taskRunProcess?.forceExit();
    }
  }

  public async kill() {
    await this.taskRunProcess?.kill("SIGKILL");
  }

  private async complete({ completion }: { completion: TaskRunExecutionResult }): Promise<void> {
    if (!this.runFriendlyId || !this.currentSnapshotId) {
      throw new Error("Cannot complete run: missing run or snapshot ID");
    }

    const completionResult = await this.httpClient.completeRunAttempt(
      this.runFriendlyId,
      this.currentSnapshotId,
      { completion }
    );

    if (!completionResult.success) {
      throw new Error(`failed to submit completion: ${completionResult.error}`);
    }

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
    this.sendDebugLog("Handling completion result", {
      attemptSuccess: completion.ok,
      attemptStatus: result.attemptStatus,
      snapshotId: result.snapshot.friendlyId,
      runId: result.run.friendlyId,
    });

    // Update our snapshot ID to match the completion result
    // This ensures any subsequent API calls use the correct snapshot
    this.currentSnapshotId = result.snapshot.friendlyId;

    const { attemptStatus } = result;

    if (attemptStatus === "RUN_FINISHED") {
      this.sendDebugLog("Run finished");

      return;
    }

    if (attemptStatus === "RUN_PENDING_CANCEL") {
      this.sendDebugLog("Run pending cancel");
      return;
    }

    if (attemptStatus === "RETRY_QUEUED") {
      this.sendDebugLog("Retry queued");

      return;
    }

    if (attemptStatus === "RETRY_IMMEDIATELY") {
      if (completion.ok) {
        throw new Error("Should retry but completion OK.");
      }

      if (!completion.retry) {
        throw new Error("Should retry but missing retry params.");
      }

      await this.retryImmediately({ retryOpts: completion.retry });
      return;
    }

    assertExhaustive(attemptStatus);
  }

  private measureExecutionMetrics({
    attemptCreatedAt,
    dequeuedAt,
    podScheduledAt,
  }: {
    attemptCreatedAt: number;
    dequeuedAt?: number;
    podScheduledAt?: number;
  }): TaskRunExecutionMetrics {
    const metrics: TaskRunExecutionMetrics = [
      {
        name: "start",
        event: "create_attempt",
        timestamp: attemptCreatedAt,
        duration: Date.now() - attemptCreatedAt,
      },
    ];

    if (dequeuedAt) {
      metrics.push({
        name: "start",
        event: "dequeue",
        timestamp: dequeuedAt,
        duration: 0,
      });
    }

    if (podScheduledAt) {
      metrics.push({
        name: "start",
        event: "pod_scheduled",
        timestamp: podScheduledAt,
        duration: 0,
      });
    }

    return metrics;
  }

  private async retryImmediately({ retryOpts }: { retryOpts: TaskRunExecutionRetry }) {
    this.sendDebugLog("Retrying run immediately", {
      timestamp: retryOpts.timestamp,
      delay: retryOpts.delay,
    });

    const delay = retryOpts.timestamp - Date.now();

    if (delay > 0) {
      // Wait for retry delay to pass
      await sleep(delay);
    }

    // Start and execute next attempt
    const [startError, start] = await tryCatch(this.startAttempt({ isWarmStart: true }));

    if (startError) {
      this.sendDebugLog("Failed to start attempt for retry", { error: startError.message });

      this.stopServices();
      return;
    }

    const [executeError] = await tryCatch(this.executeRunWrapper({ ...start, isWarmStart: true }));

    if (executeError) {
      this.sendDebugLog("Failed to execute run for retry", { error: executeError.message });

      this.stopServices();
      return;
    }

    this.stopServices();
  }

  /**
   * Restores a suspended execution from PENDING_EXECUTING
   */
  private async restore(): Promise<void> {
    this.sendDebugLog("Restoring execution");

    if (!this.runFriendlyId || !this.currentSnapshotId) {
      throw new Error("Cannot restore: missing run or snapshot ID");
    }

    // Short delay to give websocket time to reconnect
    await sleep(100);

    // Process any env overrides
    await this.processEnvOverrides();

    const continuationResult = await this.httpClient.continueRunExecution(
      this.runFriendlyId,
      this.currentSnapshotId
    );

    if (!continuationResult.success) {
      throw new Error(continuationResult.error);
    }

    // Track restore count
    this.restoreCount++;
  }

  /**
   * Processes env overrides from the metadata service. Generally called when we're resuming from a suspended state.
   */
  private async processEnvOverrides() {
    if (!this.env.TRIGGER_METADATA_URL) {
      this.sendDebugLog("No metadata URL, skipping env overrides");
      return;
    }

    const metadataClient = new MetadataClient(this.env.TRIGGER_METADATA_URL);
    const overrides = await metadataClient.getEnvOverrides();

    if (!overrides) {
      this.sendDebugLog("No env overrides, skipping");
      return;
    }

    this.sendDebugLog("Processing env overrides", overrides);

    // Override the env with the new values
    this.env.override(overrides);

    // Update services with new values
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

  private async onHeartbeat() {
    if (!this.runFriendlyId) {
      this.sendDebugLog("Heartbeat: missing run ID");
      return;
    }

    if (!this.currentSnapshotId) {
      this.sendDebugLog("Heartbeat: missing snapshot ID");
      return;
    }

    this.sendDebugLog("Heartbeat: started");

    const response = await this.httpClient.heartbeatRun(this.runFriendlyId, this.currentSnapshotId);

    if (!response.success) {
      this.sendDebugLog("Heartbeat: failed", { error: response.error });
    }

    this.lastHeartbeat = new Date();
  }

  private sendDebugLog(
    message: string,
    properties?: SendDebugLogOptions["properties"],
    runIdOverride?: string
  ) {
    this.logger.sendDebugLog({
      runId: runIdOverride ?? this.runFriendlyId,
      message: `[execution] ${message}`,
      properties: {
        ...properties,
        runId: this.runFriendlyId,
        snapshotId: this.currentSnapshotId,
        executionId: this.id,
        executionRestoreCount: this.restoreCount,
        lastHeartbeat: this.lastHeartbeat?.toISOString(),
      },
    });
  }

  // Ensure we can only set this once
  private set runFriendlyId(id: string) {
    if (this._runFriendlyId) {
      throw new Error("Run ID already set");
    }

    this._runFriendlyId = id;
  }

  public get runFriendlyId(): string | undefined {
    return this._runFriendlyId;
  }

  public get currentSnapshotFriendlyId(): string | undefined {
    return this.currentSnapshotId;
  }

  public get taskRunEnv(): Record<string, string> | undefined {
    return this.currentTaskRunEnv;
  }

  public get metrics() {
    return {
      restoreCount: this.restoreCount,
    };
  }

  get isAborted() {
    return this.executionAbortController.signal.aborted;
  }

  private abortExecution() {
    if (this.isAborted) {
      this.sendDebugLog("Execution already aborted");
      return;
    }

    this.executionAbortController.abort();
    this.stopServices();
  }

  private stopServices() {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    this.snapshotPoller?.stop();
    this.taskRunProcess?.onTaskRunHeartbeat.detach();
  }
}
