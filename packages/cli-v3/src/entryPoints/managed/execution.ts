import {
  type CompleteRunAttemptResult,
  type RunExecutionData,
  SuspendedProcessError,
  type TaskRunExecutionMetrics,
  type TaskRunExecutionResult,
  TaskRunExecutionRetry,
  TaskRunExecutionStatus,
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
import { Metadata, MetadataClient } from "./overrides.js";
import { randomBytes } from "node:crypto";
import { SnapshotManager, SnapshotState } from "./snapshot.js";
import type { SupervisorSocket } from "./controller.js";
import { RunNotifier } from "./notifier.js";
import { TaskRunProcessProvider } from "./taskRunProcessProvider.js";

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
  supervisorSocket: SupervisorSocket;
  taskRunProcessProvider: TaskRunProcessProvider;
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
  private currentAttemptNumber?: number;
  private currentTaskRunEnv?: Record<string, string>;
  private snapshotManager?: SnapshotManager;

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
  private shutdownReason?: string;

  private supervisorSocket: SupervisorSocket;
  private notifier?: RunNotifier;
  private metadataClient?: MetadataClient;
  private taskRunProcessProvider: TaskRunProcessProvider;

  constructor(opts: RunExecutionOptions) {
    this.id = randomBytes(4).toString("hex");
    this.workerManifest = opts.workerManifest;
    this.env = opts.env;
    this.httpClient = opts.httpClient;
    this.logger = opts.logger;
    this.supervisorSocket = opts.supervisorSocket;
    this.taskRunProcessProvider = opts.taskRunProcessProvider;

    this.restoreCount = 0;
    this.executionAbortController = new AbortController();

    if (this.env.TRIGGER_METADATA_URL) {
      this.metadataClient = new MetadataClient(this.env.TRIGGER_METADATA_URL);
    }
  }

  /**
   * Cancels the current execution.
   */
  public async cancel(): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error("cancel called after execution shut down");
    }

    this.sendDebugLog("cancelling attempt", { runId: this.runFriendlyId });

    await this.taskRunProcess?.cancel();
  }

  /**
   * Kills the current execution.
   */
  public async kill({ exitExecution = true }: { exitExecution?: boolean } = {}) {
    if (this.taskRunProcess) {
      await this.taskRunProcessProvider.handleProcessAbort(this.taskRunProcess);
    }

    if (exitExecution) {
      this.shutdown("kill");
    }
  }

  /**
   * Prepares the execution with task run environment variables.
   * This should be called before executing, typically after a successful run to prepare for the next one.
   */
  public prepareForExecution(opts: RunExecutionPrepareOptions): this {
    if (this.isShuttingDown) {
      throw new Error("prepareForExecution called after execution shut down");
    }

    if (this.taskRunProcess) {
      throw new Error("prepareForExecution called after process was already created");
    }

    // Store the environment for later use, don't create process yet
    // The process will be created when needed in executeRun
    this.currentTaskRunEnv = opts.taskRunEnv;

    return this;
  }

  private attachTaskRunProcessHandlers(taskRunProcess: TaskRunProcess): void {
    taskRunProcess.onTaskRunHeartbeat.detach();
    taskRunProcess.onSendDebugLog.detach();
    taskRunProcess.onSetSuspendable.detach();

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

    taskRunProcess.onSendDebugLog.attach(async (debugLog) => {
      this.sendRuntimeDebugLog(debugLog.message, debugLog.properties);
    });

    taskRunProcess.onSetSuspendable.attach(async ({ suspendable }) => {
      this.suspendable = suspendable;
    });
  }

  /**
   * Returns true if no run has been started yet and we're prepared for the next run.
   */
  get canExecute(): boolean {
    // If we've ever had a run ID, this execution can't be reused
    if (this._runFriendlyId) {
      return false;
    }

    // We can execute if we have the task run environment ready
    return !!this.currentTaskRunEnv;
  }

  /**
   * Called by the RunController when it receives a websocket notification
   * or when the snapshot poller detects a change.
   *
   * This is the main entry point for snapshot changes, but processing is deferred to the snapshot manager.
   */
  private async enqueueSnapshotChangesAndWait(snapshots: RunExecutionData[]): Promise<void> {
    if (this.isShuttingDown) {
      this.sendDebugLog("enqueueSnapshotChangeAndWait: shutting down, skipping");
      return;
    }

    if (!this.snapshotManager) {
      this.sendDebugLog("enqueueSnapshotChangeAndWait: missing snapshot manager");
      return;
    }

    await this.snapshotManager.handleSnapshotChanges(snapshots);
  }

  private async processSnapshotChange(
    runData: RunExecutionData,
    deprecated: boolean
  ): Promise<void> {
    const { run, snapshot, completedWaitpoints } = runData;

    const snapshotMetadata = {
      incomingSnapshotId: snapshot.friendlyId,
      completedWaitpoints: completedWaitpoints.length,
    };

    if (!this.snapshotManager) {
      this.sendDebugLog("handleSnapshotChange: missing snapshot manager", snapshotMetadata);
      return;
    }

    if (this.currentAttemptNumber && this.currentAttemptNumber !== run.attemptNumber) {
      this.sendDebugLog("error: attempt number mismatch", snapshotMetadata);
      // This is a rogue execution, a new one will already have been created elsewhere
      await this.exitTaskRunProcessWithoutFailingRun({ flush: false });
      return;
    }

    // DO NOT REMOVE (very noisy, but helpful for debugging)
    // this.sendDebugLog(`processing snapshot change: ${snapshot.executionStatus}`, snapshotMetadata);

    // Reset the snapshot poll interval so we don't do unnecessary work
    this.snapshotPoller?.updateSnapshotId(snapshot.friendlyId);
    this.snapshotPoller?.resetCurrentInterval();

    if (deprecated) {
      this.sendDebugLog("run execution is deprecated", { incomingSnapshot: snapshot });

      await this.exitTaskRunProcessWithoutFailingRun({ flush: false });
      return;
    }

    switch (snapshot.executionStatus) {
      case "PENDING_CANCEL": {
        this.sendDebugLog("run was cancelled", snapshotMetadata);

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
        this.sendDebugLog("run was re-queued", snapshotMetadata);

        await this.exitTaskRunProcessWithoutFailingRun({ flush: true });
        return;
      }
      case "FINISHED": {
        this.sendDebugLog("run is finished", snapshotMetadata);

        await this.exitTaskRunProcessWithoutFailingRun({ flush: true });
        return;
      }
      case "QUEUED_EXECUTING":
      case "EXECUTING_WITH_WAITPOINTS": {
        this.sendDebugLog("run is executing with waitpoints", snapshotMetadata);

        // Wait for next status change - suspension is handled by the snapshot manager
        return;
      }
      case "SUSPENDED": {
        this.sendDebugLog("run was suspended", snapshotMetadata);

        // This will kill the process and fail the execution with a SuspendedProcessError
        // We don't flush because we already did before suspending
        await this.exitTaskRunProcessWithoutFailingRun({ flush: false });
        return;
      }
      case "PENDING_EXECUTING": {
        this.sendDebugLog("run is pending execution", snapshotMetadata);

        if (completedWaitpoints.length === 0) {
          this.sendDebugLog("no waitpoints to complete, nothing to do", snapshotMetadata);
          return;
        }

        const [error] = await tryCatch(this.restore());

        if (error) {
          this.sendDebugLog("failed to restore execution", {
            ...snapshotMetadata,
            error: error.message,
          });

          this.abortExecution();
          return;
        }

        return;
      }
      case "EXECUTING": {
        if (completedWaitpoints.length === 0) {
          this.sendDebugLog("run is executing without completed waitpoints", snapshotMetadata);
          return;
        }

        this.sendDebugLog("run is executing with completed waitpoints", snapshotMetadata);

        if (!this.taskRunProcess) {
          this.sendDebugLog("no task run process, ignoring completed waitpoints", snapshotMetadata);

          this.abortExecution();
          return;
        }

        for (const waitpoint of completedWaitpoints) {
          this.taskRunProcess.waitpointCompleted(waitpoint);
        }

        return;
      }
      case "RUN_CREATED": {
        this.sendDebugLog(
          "aborting execution: invalid status change: RUN_CREATED",
          snapshotMetadata
        );

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
    if (!this.runFriendlyId || !this.snapshotManager) {
      throw new Error("Cannot start attempt: missing run or snapshot manager");
    }

    this.sendDebugLog("starting attempt");

    const attemptStartedAt = Date.now();

    // Check for abort before each major async operation
    if (this.executionAbortController.signal.aborted) {
      throw new ExecutionAbortError("Execution aborted before start");
    }

    const start = await this.httpClient.startRunAttempt(
      this.runFriendlyId,
      this.snapshotManager.snapshotId,
      { isWarmStart }
    );

    if (this.executionAbortController.signal.aborted) {
      throw new ExecutionAbortError("Execution aborted after start");
    }

    if (!start.success) {
      throw new Error(`Start API call failed: ${start.error}`);
    }

    // A snapshot was just created, so update the snapshot ID
    this.snapshotManager.updateSnapshot(
      start.data.snapshot.friendlyId,
      start.data.snapshot.executionStatus
    );

    // Also set or update the attempt number - we do this to detect illegal attempt number changes, e.g. from stalled runners coming back online
    const attemptNumber = start.data.run.attemptNumber;
    if (attemptNumber && attemptNumber > 0) {
      this.currentAttemptNumber = attemptNumber;
    } else {
      this.sendDebugLog("error: invalid attempt number returned from start attempt", {
        attemptNumber: String(attemptNumber),
      });
    }

    const metrics = this.measureExecutionMetrics({
      attemptCreatedAt: attemptStartedAt,
      dequeuedAt: this.dequeuedAt?.getTime(),
      podScheduledAt: this.podScheduledAt?.getTime(),
    });

    this.sendDebugLog("started attempt");

    return { ...start.data, metrics };
  }

  /**
   * Executes the run. This will return when the execution is complete and we should warm start.
   * When this returns, the child process will have been cleaned up.
   */
  public async execute(runOpts: RunExecutionRunOptions): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error("execute called after execution shut down");
    }

    // Setup initial state
    this.runFriendlyId = runOpts.runFriendlyId;

    // Create snapshot manager
    this.snapshotManager = new SnapshotManager({
      runFriendlyId: runOpts.runFriendlyId,
      runnerId: this.env.TRIGGER_RUNNER_ID,
      initialSnapshotId: runOpts.snapshotFriendlyId,
      // We're just guessing here, but "PENDING_EXECUTING" is probably fine
      initialStatus: "PENDING_EXECUTING",
      logger: this.logger,
      metadataClient: this.metadataClient,
      onSnapshotChange: this.processSnapshotChange.bind(this),
      onSuspendable: this.handleSuspendable.bind(this),
    });

    this.dequeuedAt = runOpts.dequeuedAt;
    this.podScheduledAt = runOpts.podScheduledAt;

    // Create and start services
    this.snapshotPoller = new RunExecutionSnapshotPoller({
      runFriendlyId: this.runFriendlyId,
      snapshotFriendlyId: this.snapshotManager.snapshotId,
      logger: this.logger,
      snapshotPollIntervalSeconds: this.env.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS,
      onPoll: this.fetchAndProcessSnapshotChanges.bind(this),
    }).start();

    this.notifier = new RunNotifier({
      runFriendlyId: this.runFriendlyId,
      supervisorSocket: this.supervisorSocket,
      onNotify: this.fetchAndProcessSnapshotChanges.bind(this),
      logger: this.logger,
    }).start();

    const [startError, start] = await tryCatch(
      this.startAttempt({ isWarmStart: runOpts.isWarmStart })
    );

    if (startError) {
      this.sendDebugLog("failed to start attempt", { error: startError.message });

      this.shutdown("failed to start attempt");
      return;
    }

    const [executeError] = await tryCatch(this.executeRunWrapper(start));

    if (executeError) {
      this.sendDebugLog("failed to execute run", { error: executeError.message });

      this.shutdown("failed to execute run");
      return;
    }

    // This is here for safety, but it
    this.shutdown("execute call finished");
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

    if (!executeError) {
      return;
    }

    if (executeError instanceof SuspendedProcessError) {
      this.sendDebugLog("execution was suspended", {
        run: run.friendlyId,
        snapshot: snapshot.friendlyId,
        error: executeError.message,
      });

      return;
    }

    if (executeError instanceof ExecutionAbortError) {
      this.sendDebugLog("execution was aborted", {
        run: run.friendlyId,
        snapshot: snapshot.friendlyId,
        error: executeError.message,
      });

      return;
    }

    this.sendDebugLog("error while executing attempt", {
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
      this.sendDebugLog("failed to complete run", { error: completeError.message });
    }
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
    const isImmediateRetry = !!this.runFriendlyId;

    if (isImmediateRetry) {
      await this.taskRunProcessProvider.handleImmediateRetry();
    }

    const taskRunEnv = this.currentTaskRunEnv ?? envVars;

    this.taskRunProcess = await this.taskRunProcessProvider.getProcess({
      taskRunEnv: { ...taskRunEnv, TRIGGER_PROJECT_REF: execution.project.ref },
      isWarmStart,
    });

    this.attachTaskRunProcessHandlers(this.taskRunProcess);

    this.sendDebugLog("executing task run process", { runId: execution.run.id });

    const abortHandler = async () => {
      this.sendDebugLog("execution aborted during task run, cleaning up process", {
        runId: execution.run.id,
      });

      if (this.taskRunProcess) {
        await this.taskRunProcessProvider.handleProcessAbort(this.taskRunProcess);
      }
    };

    // Set up an abort handler that will cleanup the task run process
    this.executionAbortController.signal.addEventListener("abort", abortHandler);

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

    this.executionAbortController.signal.removeEventListener("abort", abortHandler);

    // If we get here, the task completed normally
    this.sendDebugLog("completed run attempt", { attemptSuccess: completion.ok });

    // Return the process to the provider - this handles all cleanup logic
    const [returnError] = await tryCatch(
      this.taskRunProcessProvider.returnProcess(this.taskRunProcess)
    );

    if (returnError) {
      this.sendDebugLog("failed to return task run process, submitting completion anyway", {
        error: returnError.message,
      });
    }

    const [completionError] = await tryCatch(this.complete({ completion }));

    if (completionError) {
      this.sendDebugLog("failed to complete run", { error: completionError.message });
    }
  }

  private async complete({ completion }: { completion: TaskRunExecutionResult }): Promise<void> {
    if (!this.runFriendlyId || !this.snapshotManager) {
      throw new Error("cannot complete run: missing run or snapshot manager");
    }

    const completionResult = await this.httpClient.completeRunAttempt(
      this.runFriendlyId,
      this.snapshotManager.snapshotId,
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
    this.sendDebugLog(`completion result: ${result.attemptStatus}`, {
      attemptSuccess: completion.ok,
      attemptStatus: result.attemptStatus,
      snapshotId: result.snapshot.friendlyId,
      runId: result.run.friendlyId,
    });

    const snapshotStatus = this.convertAttemptStatusToSnapshotStatus(result.attemptStatus);

    // Update our snapshot ID to match the completion result to ensure any subsequent API calls use the correct snapshot
    this.updateSnapshotAfterCompletion(result.snapshot.friendlyId, snapshotStatus);

    const { attemptStatus } = result;

    switch (attemptStatus) {
      case "RUN_FINISHED":
      case "RUN_PENDING_CANCEL":
      case "RETRY_QUEUED": {
        return;
      }
      case "RETRY_IMMEDIATELY": {
        if (attemptStatus !== "RETRY_IMMEDIATELY") {
          return;
        }

        if (completion.ok) {
          throw new Error("Should retry but completion OK.");
        }

        if (!completion.retry) {
          throw new Error("Should retry but missing retry params.");
        }

        await this.retryImmediately({ retryOpts: completion.retry });
        return;
      }
      default: {
        assertExhaustive(attemptStatus);
      }
    }
  }

  private updateSnapshotAfterCompletion(snapshotId: string, status: TaskRunExecutionStatus) {
    this.snapshotManager?.updateSnapshot(snapshotId, status);
    this.snapshotPoller?.updateSnapshotId(snapshotId);
  }

  private convertAttemptStatusToSnapshotStatus(
    attemptStatus: CompleteRunAttemptResult["attemptStatus"]
  ): TaskRunExecutionStatus {
    switch (attemptStatus) {
      case "RUN_FINISHED":
        return "FINISHED";
      case "RUN_PENDING_CANCEL":
        return "PENDING_CANCEL";
      case "RETRY_QUEUED":
        return "QUEUED";
      case "RETRY_IMMEDIATELY":
        return "EXECUTING";
      default:
        assertExhaustive(attemptStatus);
    }
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
    this.sendDebugLog("retrying run immediately", {
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
      this.sendDebugLog("failed to start attempt for retry", { error: startError.message });

      this.shutdown("retryImmediately: failed to start attempt");
      return;
    }

    const [executeError] = await tryCatch(this.executeRunWrapper({ ...start, isWarmStart: true }));

    if (executeError) {
      this.sendDebugLog("failed to execute run for retry", { error: executeError.message });

      this.shutdown("retryImmediately: failed to execute run");
      return;
    }
  }

  /**
   * Restores a suspended execution from PENDING_EXECUTING
   */
  private async restore(): Promise<void> {
    this.sendDebugLog("restoring execution");

    if (!this.runFriendlyId || !this.snapshotManager) {
      throw new Error("Cannot restore: missing run or snapshot manager");
    }

    // Short delay to give websocket time to reconnect
    await sleep(100);

    // Process any env overrides
    await this.processEnvOverrides("restore");

    const continuationResult = await this.httpClient.continueRunExecution(
      this.runFriendlyId,
      this.snapshotManager.snapshotId
    );

    if (!continuationResult.success) {
      throw new Error(continuationResult.error);
    }

    // Track restore count
    this.restoreCount++;
  }

  private async exitTaskRunProcessWithoutFailingRun({ flush }: { flush: boolean }) {
    await this.taskRunProcess?.suspend({ flush });

    // No services should be left running after this line - let's make sure of it
    this.shutdown("exitTaskRunProcessWithoutFailingRun");
  }

  /**
   * Processes env overrides from the metadata service. Generally called when we're resuming from a suspended state.
   */
  public async processEnvOverrides(reason?: string): Promise<{ overrides: Metadata } | null> {
    if (!this.metadataClient) {
      return null;
    }

    const [error, overrides] = await this.metadataClient.getEnvOverrides();

    if (error) {
      this.sendDebugLog("[override] failed to fetch", {
        reason,
        error: error.message,
      });
      return null;
    }

    if (overrides.TRIGGER_RUN_ID && overrides.TRIGGER_RUN_ID !== this.runFriendlyId) {
      this.sendDebugLog("[override] run ID mismatch, ignoring overrides", {
        reason,
        currentRunId: this.runFriendlyId,
        incomingRunId: overrides.TRIGGER_RUN_ID,
      });
      return null;
    }

    this.sendDebugLog(`[override] processing: ${reason}`, {
      overrides,
      currentEnv: this.env.raw,
    });

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

    return {
      overrides,
    };
  }

  private async onHeartbeat() {
    if (!this.runFriendlyId) {
      this.sendDebugLog("heartbeat: missing run ID");
      return;
    }

    if (!this.snapshotManager) {
      this.sendDebugLog("heartbeat: missing snapshot manager");
      return;
    }

    this.sendDebugLog("heartbeat");

    const response = await this.httpClient.heartbeatRun(
      this.runFriendlyId,
      this.snapshotManager.snapshotId
    );

    if (!response.success) {
      this.sendDebugLog("heartbeat: failed", { error: response.error });
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
        snapshotId: this.currentSnapshotFriendlyId,
        executionId: this.id,
        executionRestoreCount: this.restoreCount,
        lastHeartbeat: this.lastHeartbeat?.toISOString(),
      },
    });
  }

  private sendRuntimeDebugLog(
    message: string,
    properties?: SendDebugLogOptions["properties"],
    runIdOverride?: string
  ) {
    this.logger.sendDebugLog({
      runId: runIdOverride ?? this.runFriendlyId,
      message: `[runtime] ${message}`,
      print: false,
      properties: {
        ...properties,
        runId: this.runFriendlyId,
        snapshotId: this.currentSnapshotFriendlyId,
        executionId: this.id,
        executionRestoreCount: this.restoreCount,
        lastHeartbeat: this.lastHeartbeat?.toISOString(),
      },
    });
  }

  private set suspendable(suspendable: boolean) {
    this.snapshotManager?.setSuspendable(suspendable).catch((error) => {
      this.sendDebugLog("failed to set suspendable", { error: error.message });
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
    return this.snapshotManager?.snapshotId;
  }

  public get taskRunEnv(): Record<string, string> | undefined {
    return this.currentTaskRunEnv;
  }

  public get metrics() {
    return {
      execution: {
        restoreCount: this.restoreCount,
        lastHeartbeat: this.lastHeartbeat,
      },
      poller: this.snapshotPoller?.metrics,
      notifier: this.notifier?.metrics,
    };
  }

  get isAborted() {
    return this.executionAbortController.signal.aborted;
  }

  private abortExecution() {
    if (this.isAborted) {
      this.sendDebugLog("execution already aborted");
      return;
    }

    this.executionAbortController.abort();
    this.shutdown("abortExecution");
  }

  private shutdown(reason: string) {
    if (this.isShuttingDown) {
      this.sendDebugLog(`[shutdown] ${reason} (already shutting down)`, {
        firstShutdownReason: this.shutdownReason,
      });
      return;
    }

    this.sendDebugLog(`[shutdown] ${reason}`);

    this.isShuttingDown = true;
    this.shutdownReason = reason;

    this.snapshotPoller?.stop();
    this.snapshotManager?.stop();
    this.notifier?.stop();

    this.taskRunProcess?.unsafeDetachEvtHandlers();
  }

  private async handleSuspendable(suspendableSnapshot: SnapshotState) {
    this.sendDebugLog("handleSuspendable", { suspendableSnapshot });

    if (!this.snapshotManager) {
      this.sendDebugLog("handleSuspendable: missing snapshot manager", { suspendableSnapshot });
      return;
    }

    // Ensure this is the current snapshot
    if (suspendableSnapshot.id !== this.currentSnapshotFriendlyId) {
      this.sendDebugLog("snapshot changed before cleanup, abort", {
        suspendableSnapshot,
        currentSnapshotId: this.currentSnapshotFriendlyId,
      });
      this.abortExecution();
      return;
    }

    // First cleanup the task run process
    const [error] = await tryCatch(this.taskRunProcess?.cleanup(false));

    if (error) {
      this.sendDebugLog("failed to cleanup task run process, carrying on", {
        suspendableSnapshot,
        error: error.message,
      });
    }

    // Double check snapshot hasn't changed after cleanup
    if (suspendableSnapshot.id !== this.currentSnapshotFriendlyId) {
      this.sendDebugLog("snapshot changed after cleanup, abort", {
        suspendableSnapshot,
        currentSnapshotId: this.currentSnapshotFriendlyId,
      });
      this.abortExecution();
      return;
    }

    if (!this.runFriendlyId) {
      this.sendDebugLog("missing run ID for suspension, abort", { suspendableSnapshot });
      this.abortExecution();
      return;
    }

    // Call the suspend API with the current snapshot ID
    const suspendResult = await this.httpClient.suspendRun(
      this.runFriendlyId,
      suspendableSnapshot.id
    );

    if (!suspendResult.success) {
      this.sendDebugLog("suspension request failed, staying alive 🎶", {
        suspendableSnapshot,
        error: suspendResult.error,
      });

      // This is fine, we'll wait for the next status change
      return;
    }

    if (!suspendResult.data.ok) {
      this.sendDebugLog("suspension request returned error, staying alive 🎶", {
        suspendableSnapshot,
        error: suspendResult.data.error,
      });

      // This is fine, we'll wait for the next status change
      return;
    }

    this.sendDebugLog("suspending, any day now 🚬", { suspendableSnapshot });
  }

  /**
   * Fetches the latest execution data and enqueues snapshot changes. Used by both poller and notification handlers.
   * @param source string - where this call originated (e.g. 'poller', 'notification')
   */
  public async fetchAndProcessSnapshotChanges(source: string): Promise<void> {
    if (!this.runFriendlyId) {
      this.sendDebugLog(`fetchAndProcessSnapshotChanges: missing runFriendlyId`, { source });
      return;
    }

    // Use the last processed snapshot as the since parameter
    const sinceSnapshotId = this.currentSnapshotFriendlyId;

    if (!sinceSnapshotId) {
      this.sendDebugLog(`fetchAndProcessSnapshotChanges: missing sinceSnapshotId`, { source });
      return;
    }

    const response = await this.httpClient.getSnapshotsSince(this.runFriendlyId, sinceSnapshotId);

    if (!response.success) {
      this.sendDebugLog(`fetchAndProcessSnapshotChanges: failed to get snapshots since`, {
        source,
        error: response.error,
      });

      await this.processEnvOverrides("snapshots since error");
      return;
    }

    const { snapshots } = response.data;

    if (!snapshots.length) {
      return;
    }

    const [error] = await tryCatch(this.enqueueSnapshotChangesAndWait(snapshots));

    if (error) {
      this.sendDebugLog(
        `fetchAndProcessSnapshotChanges: failed to enqueue and process snapshot change`,
        {
          source,
          error: error.message,
        }
      );
      return;
    }
  }
}
