import { logger } from "../utilities/logger.js";
import { TaskRunProcess } from "../executions/taskRunProcess.js";
import { env as stdEnv } from "std-env";
import { z } from "zod";
import { randomUUID } from "crypto";
import { readJSONFile } from "../utilities/fileSystem.js";
import {
  type CompleteRunAttemptResult,
  HeartbeatService,
  type RunExecutionData,
  type TaskRunExecutionMetrics,
  type TaskRunExecutionResult,
  type TaskRunFailedExecutionResult,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import {
  WarmStartClient,
  WORKLOAD_HEADERS,
  type WorkloadClientToServerEvents,
  type WorkloadDebugLogRequestBody,
  WorkloadHttpClient,
  type WorkloadServerToClientEvents,
  type WorkloadRunAttemptStartResponseBody,
} from "@trigger.dev/core/v3/workers";
import { assertExhaustive } from "../utilities/assertExhaustive.js";
import { setTimeout as sleep } from "timers/promises";
import { io, type Socket } from "socket.io-client";

// All IDs are friendly IDs
const Env = z.object({
  // Set at build time
  TRIGGER_CONTENT_HASH: z.string(),
  TRIGGER_DEPLOYMENT_ID: z.string(),
  TRIGGER_DEPLOYMENT_VERSION: z.string(),
  TRIGGER_PROJECT_ID: z.string(),
  TRIGGER_PROJECT_REF: z.string(),
  NODE_ENV: z.string().default("production"),
  NODE_EXTRA_CA_CERTS: z.string().optional(),

  // Set at runtime
  TRIGGER_WORKLOAD_CONTROLLER_ID: z.string().default(`controller_${randomUUID()}`),
  TRIGGER_ENV_ID: z.string(),
  TRIGGER_RUN_ID: z.string().optional(), // This is only useful for cold starts
  TRIGGER_SNAPSHOT_ID: z.string().optional(), // This is only useful for cold starts
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url(),
  TRIGGER_WARM_START_URL: z.string().optional(),
  TRIGGER_WARM_START_CONNECTION_TIMEOUT_MS: z.coerce.number().default(30_000),
  TRIGGER_WARM_START_KEEPALIVE_MS: z.coerce.number().default(300_000),
  TRIGGER_MACHINE_CPU: z.string().default("0"),
  TRIGGER_MACHINE_MEMORY: z.string().default("0"),
  TRIGGER_RUNNER_ID: z.string(),
  TRIGGER_METADATA_URL: z.string().optional(),

  // Timeline metrics
  TRIGGER_POD_SCHEDULED_AT_MS: z.coerce.date(),

  // May be overridden
  TRIGGER_SUPERVISOR_API_PROTOCOL: z.enum(["http", "https"]),
  TRIGGER_SUPERVISOR_API_DOMAIN: z.string(),
  TRIGGER_SUPERVISOR_API_PORT: z.coerce.number(),
  TRIGGER_WORKER_INSTANCE_NAME: z.string(),
  TRIGGER_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().default(30),
  TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS: z.coerce.number().default(5),
  TRIGGER_SUCCESS_EXIT_CODE: z.coerce.number().default(0),
  TRIGGER_FAILURE_EXIT_CODE: z.coerce.number().default(1),
});

const env = Env.parse(stdEnv);

logger.loggerLevel = "debug";

type ManagedRunControllerOptions = {
  workerManifest: WorkerManifest;
};

type Run = {
  friendlyId: string;
  attemptNumber?: number | null;
};

type Snapshot = {
  friendlyId: string;
};

type Metadata = {
  TRIGGER_SUPERVISOR_API_PROTOCOL: string | undefined;
  TRIGGER_SUPERVISOR_API_DOMAIN: string | undefined;
  TRIGGER_SUPERVISOR_API_PORT: number | undefined;
  TRIGGER_WORKER_INSTANCE_NAME: string | undefined;
  TRIGGER_HEARTBEAT_INTERVAL_SECONDS: number | undefined;
  TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS: number | undefined;
  TRIGGER_SUCCESS_EXIT_CODE: number | undefined;
  TRIGGER_FAILURE_EXIT_CODE: number | undefined;
  TRIGGER_RUNNER_ID: string | undefined;
};

class MetadataClient {
  private readonly url: URL;

  constructor(url: string) {
    this.url = new URL(url);
  }

  async getEnvOverrides(): Promise<Metadata | null> {
    try {
      const response = await fetch(new URL("/env", this.url));
      return response.json();
    } catch (error) {
      console.error("Failed to fetch metadata", { error });
      return null;
    }
  }
}

class ManagedRunController {
  private taskRunProcess?: TaskRunProcess;

  private workerManifest: WorkerManifest;

  private readonly httpClient: WorkloadHttpClient;
  private readonly warmStartClient: WarmStartClient | undefined;
  private readonly metadataClient?: MetadataClient;

  private socket: Socket<WorkloadServerToClientEvents, WorkloadClientToServerEvents>;

  private readonly runHeartbeat: HeartbeatService;
  private heartbeatIntervalSeconds: number;

  private readonly snapshotPoller: HeartbeatService;
  private snapshotPollIntervalSeconds: number;

  private workerApiUrl: string;
  private workerInstanceName: string;

  private runnerId: string;

  private successExitCode = env.TRIGGER_SUCCESS_EXIT_CODE;
  private failureExitCode = env.TRIGGER_FAILURE_EXIT_CODE;

  private state:
    | {
        phase: "RUN";
        run: Run;
        snapshot: Snapshot;
      }
    | {
        phase: "IDLE" | "WARM_START";
      } = { phase: "IDLE" };

  constructor(opts: ManagedRunControllerOptions) {
    logger.debug("[ManagedRunController] Creating controller", { env });

    this.workerManifest = opts.workerManifest;

    this.runnerId = env.TRIGGER_RUNNER_ID;

    this.heartbeatIntervalSeconds = env.TRIGGER_HEARTBEAT_INTERVAL_SECONDS;
    this.snapshotPollIntervalSeconds = env.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS;

    if (env.TRIGGER_METADATA_URL) {
      this.metadataClient = new MetadataClient(env.TRIGGER_METADATA_URL);
    }

    this.workerApiUrl = `${env.TRIGGER_SUPERVISOR_API_PROTOCOL}://${env.TRIGGER_SUPERVISOR_API_DOMAIN}:${env.TRIGGER_SUPERVISOR_API_PORT}`;
    this.workerInstanceName = env.TRIGGER_WORKER_INSTANCE_NAME;

    this.httpClient = new WorkloadHttpClient({
      workerApiUrl: this.workerApiUrl,
      runnerId: this.runnerId,
      deploymentId: env.TRIGGER_DEPLOYMENT_ID,
      deploymentVersion: env.TRIGGER_DEPLOYMENT_VERSION,
      projectRef: env.TRIGGER_PROJECT_REF,
    });

    if (env.TRIGGER_WARM_START_URL) {
      this.warmStartClient = new WarmStartClient({
        apiUrl: new URL(env.TRIGGER_WARM_START_URL),
        controllerId: env.TRIGGER_WORKLOAD_CONTROLLER_ID,
        deploymentId: env.TRIGGER_DEPLOYMENT_ID,
        deploymentVersion: env.TRIGGER_DEPLOYMENT_VERSION,
        machineCpu: env.TRIGGER_MACHINE_CPU,
        machineMemory: env.TRIGGER_MACHINE_MEMORY,
      });
    }

    this.snapshotPoller = new HeartbeatService({
      heartbeat: async () => {
        if (!this.runFriendlyId) {
          logger.debug("[ManagedRunController] Skipping snapshot poll, no run ID");
          return;
        }

        console.debug("[ManagedRunController] Polling for latest snapshot");

        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: `snapshot poll: started`,
          properties: {
            snapshotId: this.snapshotFriendlyId,
          },
        });

        const response = await this.httpClient.getRunExecutionData(this.runFriendlyId);

        if (!response.success) {
          console.error("[ManagedRunController] Snapshot poll failed", { error: response.error });

          this.sendDebugLog({
            runId: this.runFriendlyId,
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
        console.error("[ManagedRunController] Failed to poll for snapshot", { error });
      },
    });

    this.runHeartbeat = new HeartbeatService({
      heartbeat: async () => {
        if (!this.runFriendlyId || !this.snapshotFriendlyId) {
          logger.debug("[ManagedRunController] Skipping heartbeat, no run ID or snapshot ID");
          return;
        }

        console.debug("[ManagedRunController] Sending heartbeat");

        const response = await this.httpClient.heartbeatRun(
          this.runFriendlyId,
          this.snapshotFriendlyId
        );

        if (!response.success) {
          console.error("[ManagedRunController] Heartbeat failed", { error: response.error });

          this.sendDebugLog({
            runId: this.runFriendlyId,
            message: "heartbeat: failed",
            properties: {
              error: response.error,
            },
          });
        }
      },
      intervalMs: this.heartbeatIntervalSeconds * 1000,
      leadingEdge: false,
      onError: async (error) => {
        console.error("[ManagedRunController] Failed to send heartbeat", { error });
      },
    });

    process.on("SIGTERM", async () => {
      logger.debug("[ManagedRunController] Received SIGTERM, stopping worker");
      await this.stop();
    });
  }

  private enterRunPhase(run: Run, snapshot: Snapshot) {
    this.onExitRunPhase(run);
    this.state = { phase: "RUN", run, snapshot };

    this.runHeartbeat.start();
    this.snapshotPoller.start();
  }

  private enterWarmStartPhase() {
    this.onExitRunPhase();
    this.state = { phase: "WARM_START" };
  }

  // This should only be used when we're already executing a run. Attempt number changes are not allowed.
  private updateRunPhase(run: Run, snapshot: Snapshot) {
    if (this.state.phase !== "RUN") {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: `updateRunPhase: Invalid phase for updating snapshot: ${this.state.phase}`,
        properties: {
          currentPhase: this.state.phase,
          snapshotId: snapshot.friendlyId,
        },
      });

      throw new Error(`Invalid phase for updating snapshot: ${this.state.phase}`);
    }

    if (this.state.run.friendlyId !== run.friendlyId) {
      this.sendDebugLog({
        runId: run.friendlyId,
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

      this.sendDebugLog({
        runId: run.friendlyId,
        message: `updateRunPhase: Snapshot not changed`,
        properties: {
          snapshotId: snapshot.friendlyId,
        },
      });

      return;
    }

    if (this.state.run.attemptNumber !== run.attemptNumber) {
      this.sendDebugLog({
        runId: run.friendlyId,
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
    this.socket.emit("run:start", {
      version: "1",
      run: {
        friendlyId: run.friendlyId,
      },
      snapshot: {
        friendlyId: snapshot.friendlyId,
      },
    });
  }

  private unsubscribeFromRunNotifications({ run, snapshot }: { run: Run; snapshot: Snapshot }) {
    this.socket.emit("run:stop", {
      version: "1",
      run: {
        friendlyId: run.friendlyId,
      },
      snapshot: {
        friendlyId: snapshot.friendlyId,
      },
    });
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

    try {
      if (!this.snapshotFriendlyId) {
        console.error("handleSnapshotChange: Missing snapshot ID", {
          runId: run.friendlyId,
          snapshotId: this.snapshotFriendlyId,
        });

        this.sendDebugLog({
          runId: run.friendlyId,
          message: "snapshot change: missing snapshot ID",
          properties: {
            newSnapshotId: snapshot.friendlyId,
            newSnapshotStatus: snapshot.executionStatus,
          },
        });

        return;
      }

      if (this.snapshotFriendlyId === snapshot.friendlyId) {
        console.debug("handleSnapshotChange: snapshot not changed, skipping", { snapshot });

        this.sendDebugLog({
          runId: run.friendlyId,
          message: "snapshot change: skipping, no change",
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

      this.sendDebugLog({
        runId: run.friendlyId,
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

        this.sendDebugLog({
          runId: run.friendlyId,
          message: "snapshot change: failed to update run phase",
          properties: {
            currentPhase: this.state.phase,
            error: error instanceof Error ? error.message : String(error),
          },
        });

        this.waitForNextRun();
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

            this.waitForNextRun();
            return;
          }

          return;
        }
        case "FINISHED": {
          console.log("Run is finished, will wait for next run");
          this.waitForNextRun();
          return;
        }
        case "QUEUED_EXECUTING":
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

          // TODO: Make this configurable and add wait debounce
          await sleep(200);

          if (snapshot.friendlyId !== this.snapshotFriendlyId) {
            console.debug("Snapshot changed after suspend threshold, abort", {
              oldSnapshotId: snapshot.friendlyId,
              newSnapshotId: this.snapshotFriendlyId,
            });
            return;
          }

          if (!this.runFriendlyId || !this.snapshotFriendlyId) {
            console.error(
              "handleSnapshotChange: Missing run ID or snapshot ID after suspension, abort",
              {
                runId: this.runFriendlyId,
                snapshotId: this.snapshotFriendlyId,
              }
            );
            return;
          }

          const suspendResult = await this.httpClient.suspendRun(
            this.runFriendlyId,
            this.snapshotFriendlyId
          );

          if (!suspendResult.success) {
            console.error("Failed to suspend run, staying alive 🎶", {
              error: suspendResult.error,
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
            console.error("Failed to suspend run, staying alive 🎶🎶", {
              suspendResult: suspendResult.data,
            });

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

          console.log("Suspending, any day now 🚬", { suspendResult: suspendResult.data });
          return;
        }
        case "SUSPENDED": {
          console.log("Run was suspended, kill the process and wait for more runs", {
            run,
            snapshot,
          });

          this.waitForNextRun();
          return;
        }
        case "PENDING_EXECUTING": {
          console.log("Run is pending execution", { run, snapshot });

          if (completedWaitpoints.length === 0) {
            console.log("No waitpoints to complete, nothing to do");
            return;
          }

          // There are waitpoints to complete so we've been restored after being suspended

          // Short delay to give websocket time to reconnect
          await sleep(100);

          // Env may have changed after restore
          await this.processEnvOverrides();

          // We need to let the platform know we're ready to continue
          const continuationResult = await this.httpClient.continueRunExecution(
            run.friendlyId,
            snapshot.friendlyId
          );

          if (!continuationResult.success) {
            console.error("Failed to continue execution", { error: continuationResult.error });

            this.sendDebugLog({
              runId: run.friendlyId,
              message: "failed to continue execution",
              properties: {
                error: continuationResult.error,
              },
            });

            this.waitForNextRun();
            return;
          }

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

      this.sendDebugLog({
        runId: run.friendlyId,
        message: "snapshot change: unexpected error",
        properties: {
          snapshotId: snapshot.friendlyId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      this.handleSnapshotChangeLock = false;
    }
  }

  private async processEnvOverrides() {
    if (!this.metadataClient) {
      logger.log("No metadata client, skipping env overrides");
      return;
    }

    const overrides = await this.metadataClient.getEnvOverrides();

    if (!overrides) {
      logger.log("No env overrides, skipping");
      return;
    }

    logger.log("Processing env overrides", { env: overrides });

    if (overrides.TRIGGER_SUCCESS_EXIT_CODE) {
      this.successExitCode = overrides.TRIGGER_SUCCESS_EXIT_CODE;
    }

    if (overrides.TRIGGER_FAILURE_EXIT_CODE) {
      this.failureExitCode = overrides.TRIGGER_FAILURE_EXIT_CODE;
    }

    if (overrides.TRIGGER_HEARTBEAT_INTERVAL_SECONDS) {
      this.heartbeatIntervalSeconds = overrides.TRIGGER_HEARTBEAT_INTERVAL_SECONDS;
      this.runHeartbeat.updateInterval(this.heartbeatIntervalSeconds * 1000);
    }

    if (overrides.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS) {
      this.snapshotPollIntervalSeconds = overrides.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS;
      this.snapshotPoller.updateInterval(this.snapshotPollIntervalSeconds * 1000);
    }

    if (overrides.TRIGGER_WORKER_INSTANCE_NAME) {
      this.workerInstanceName = overrides.TRIGGER_WORKER_INSTANCE_NAME;
    }

    if (
      overrides.TRIGGER_SUPERVISOR_API_PROTOCOL ||
      overrides.TRIGGER_SUPERVISOR_API_DOMAIN ||
      overrides.TRIGGER_SUPERVISOR_API_PORT
    ) {
      const protocol =
        overrides.TRIGGER_SUPERVISOR_API_PROTOCOL ?? env.TRIGGER_SUPERVISOR_API_PROTOCOL;
      const domain = overrides.TRIGGER_SUPERVISOR_API_DOMAIN ?? env.TRIGGER_SUPERVISOR_API_DOMAIN;
      const port = overrides.TRIGGER_SUPERVISOR_API_PORT ?? env.TRIGGER_SUPERVISOR_API_PORT;

      this.workerApiUrl = `${protocol}://${domain}:${port}`;

      this.httpClient.updateApiUrl(this.workerApiUrl);
    }

    if (overrides.TRIGGER_RUNNER_ID) {
      this.runnerId = overrides.TRIGGER_RUNNER_ID;
      this.httpClient.updateRunnerId(this.runnerId);
    }
  }

  private async startAndExecuteRunAttempt({
    runFriendlyId,
    snapshotFriendlyId,
    dequeuedAt,
    podScheduledAt,
    isWarmStart = false,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    dequeuedAt?: Date;
    podScheduledAt?: Date;
    isWarmStart?: boolean;
  }) {
    if (!this.socket) {
      console.warn("[ManagedRunController] Starting run without socket connection");
    }

    this.subscribeToRunNotifications({
      run: { friendlyId: runFriendlyId },
      snapshot: { friendlyId: snapshotFriendlyId },
    });

    const attemptStartedAt = Date.now();

    const start = await this.httpClient.startRunAttempt(runFriendlyId, snapshotFriendlyId, {
      isWarmStart,
    });

    if (!start.success) {
      console.error("[ManagedRunController] Failed to start run", { error: start.error });

      this.sendDebugLog({
        runId: runFriendlyId,
        message: "failed to start run attempt",
        properties: {
          error: start.error,
        },
      });

      this.waitForNextRun();
      return;
    }

    const attemptDuration = Date.now() - attemptStartedAt;

    const { run, snapshot, execution, envVars } = start.data;

    logger.debug("[ManagedRunController] Started run", {
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
    ]
      .concat(
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
      )
      .concat(
        podScheduledAt
          ? [
              {
                name: "start",
                event: "pod_scheduled",
                timestamp: podScheduledAt.getTime(),
                duration: 0,
              },
            ]
          : []
      ) satisfies TaskRunExecutionMetrics;

    const taskRunEnv = {
      ...gatherProcessEnv(),
      ...envVars,
    };

    try {
      return await this.executeRun({ run, snapshot, envVars: taskRunEnv, execution, metrics });
    } catch (error) {
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

      const completionResult = await this.httpClient.completeRunAttempt(
        run.friendlyId,
        this.snapshotFriendlyId ?? snapshot.friendlyId,
        { completion }
      );

      if (!completionResult.success) {
        console.error("Failed to submit completion after error", {
          error: completionResult.error,
        });

        this.sendDebugLog({
          runId: run.friendlyId,
          message: "completion: failed to submit after error",
          properties: {
            error: completionResult.error,
          },
        });

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

  private waitForNextRunLock = false;

  /** This will kill the child process before spinning up a new one. It will never throw,
   *  but may exit the process on any errors or when no runs are available after the
   *  configured duration. */
  private async waitForNextRun() {
    if (this.waitForNextRunLock) {
      console.warn("waitForNextRun: already in progress");
      return;
    }

    this.waitForNextRunLock = true;
    const previousRunId = this.runFriendlyId;

    try {
      logger.debug("waitForNextRun: waiting for next run");

      this.enterWarmStartPhase();

      // Kill the run process
      await this.taskRunProcess?.kill("SIGKILL");

      if (!this.warmStartClient) {
        console.error("waitForNextRun: warm starts disabled, shutting down");
        this.exitProcess(this.successExitCode);
      }

      if (this.taskRunProcess) {
        logger.debug("waitForNextRun: eagerly recreating task run process with options");
        this.taskRunProcess = new TaskRunProcess({
          ...this.taskRunProcess.options,
          isWarmStart: true,
        }).initialize();
      } else {
        logger.debug(
          "waitForNextRun: no existing task run process, so we can't eagerly recreate it"
        );
      }

      // Check the service is up and get additional warm start config
      const connect = await this.warmStartClient.connect();

      if (!connect.success) {
        console.error("waitForNextRun: failed to connect to warm start service", {
          warmStartUrl: env.TRIGGER_WARM_START_URL,
          error: connect.error,
        });
        this.exitProcess(this.successExitCode);
      }

      const connectionTimeoutMs =
        connect.data.connectionTimeoutMs ?? env.TRIGGER_WARM_START_CONNECTION_TIMEOUT_MS;
      const keepaliveMs = connect.data.keepaliveMs ?? env.TRIGGER_WARM_START_KEEPALIVE_MS;

      console.log("waitForNextRun: connected to warm start service", {
        connectionTimeoutMs,
        keepaliveMs,
      });

      if (previousRunId) {
        this.sendDebugLog({
          runId: previousRunId,
          message: "warm start: received config",
          properties: {
            connectionTimeoutMs,
            keepaliveMs,
          },
        });
      }

      if (!connectionTimeoutMs || !keepaliveMs) {
        console.error("waitForNextRun: warm starts disabled after connect", {
          connectionTimeoutMs,
          keepaliveMs,
        });
        this.exitProcess(this.successExitCode);
      }

      const nextRun = await this.warmStartClient.warmStart({
        workerInstanceName: this.workerInstanceName,
        connectionTimeoutMs,
        keepaliveMs,
      });

      if (!nextRun) {
        console.error("waitForNextRun: warm start failed, shutting down");
        this.exitProcess(this.successExitCode);
      }

      console.log("waitForNextRun: got next run", { nextRun });

      this.startAndExecuteRunAttempt({
        runFriendlyId: nextRun.run.friendlyId,
        snapshotFriendlyId: nextRun.snapshot.friendlyId,
        dequeuedAt: nextRun.dequeuedAt,
        isWarmStart: true,
      }).finally(() => {});
      return;
    } catch (error) {
      console.error("waitForNextRun: unexpected error", { error });
      this.exitProcess(this.failureExitCode);
    } finally {
      this.waitForNextRunLock = false;
    }
  }

  private exitProcess(code?: number): never {
    logger.log("Exiting process", { code });
    if (this.taskRunProcess?.isPreparedForNextRun) {
      this.taskRunProcess.forceExit();
    }
    process.exit(code);
  }

  createSocket() {
    const wsUrl = new URL("/workload", this.workerApiUrl);

    this.socket = io(wsUrl.href, {
      transports: ["websocket"],
      extraHeaders: {
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: env.TRIGGER_DEPLOYMENT_ID,
        [WORKLOAD_HEADERS.RUNNER_ID]: env.TRIGGER_RUNNER_ID,
      },
    });
    this.socket.on("run:notify", async ({ version, run }) => {
      console.log("[ManagedRunController] Received run notification", { version, run });

      this.sendDebugLog({
        runId: run.friendlyId,
        message: "run:notify received by runner",
      });

      if (!this.runFriendlyId) {
        logger.debug("[ManagedRunController] Ignoring notification, no local run ID", {
          runId: run.friendlyId,
          currentRunId: this.runFriendlyId,
          currentSnapshotId: this.snapshotFriendlyId,
        });
        return;
      }

      if (run.friendlyId !== this.runFriendlyId) {
        console.log("[ManagedRunController] Ignoring notification for different run", {
          runId: run.friendlyId,
          currentRunId: this.runFriendlyId,
          currentSnapshotId: this.snapshotFriendlyId,
        });

        this.sendDebugLog({
          runId: run.friendlyId,
          message: "run:notify: ignoring notification for different run",
          properties: {
            currentRunId: this.runFriendlyId,
            currentSnapshotId: this.snapshotFriendlyId,
            notificationRunId: run.friendlyId,
          },
        });
        return;
      }

      // Reset the (fallback) snapshot poll interval so we don't do unnecessary work
      this.snapshotPoller.resetCurrentInterval();

      const latestSnapshot = await this.httpClient.getRunExecutionData(this.runFriendlyId);

      if (!latestSnapshot.success) {
        console.error("Failed to get latest snapshot data", latestSnapshot.error);

        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "run:notify: failed to get latest snapshot data",
          properties: {
            currentRunId: this.runFriendlyId,
            currentSnapshotId: this.snapshotFriendlyId,
            error: latestSnapshot.error,
          },
        });
        return;
      }

      await this.handleSnapshotChange(latestSnapshot.data.execution);
    });
    this.socket.on("connect", () => {
      console.log("[ManagedRunController] Connected to supervisor");

      // This should handle the case where we reconnect after being restored
      if (this.state.phase === "RUN") {
        const { run, snapshot } = this.state;
        this.subscribeToRunNotifications({ run, snapshot });
      }
    });
    this.socket.on("connect_error", (error) => {
      console.error("[ManagedRunController] Connection error", { error });
    });
    this.socket.on("disconnect", (reason, description) => {
      console.log("[ManagedRunController] Disconnected from supervisor", { reason, description });
    });
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
    this.snapshotPoller.start();

    if (!this.taskRunProcess || !this.taskRunProcess.isPreparedForNextRun) {
      this.taskRunProcess = new TaskRunProcess({
        workerManifest: this.workerManifest,
        env: envVars,
        serverWorker: {
          id: "unmanaged",
          contentHash: env.TRIGGER_CONTENT_HASH,
          version: env.TRIGGER_DEPLOYMENT_VERSION,
          engine: "V2",
        },
        machine: execution.machine,
      }).initialize();
    }

    logger.log("executing task run process", {
      attemptId: execution.attempt.id,
      runId: execution.run.id,
    });

    const completion = await this.taskRunProcess.execute({
      payload: {
        execution,
        traceContext: execution.run.traceContext ?? {},
        metrics,
      },
      messageId: run.friendlyId,
      env: envVars,
    });

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

    const completionResult = await this.httpClient.completeRunAttempt(
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

      this.sendDebugLog({
        runId: run.friendlyId,
        message: "completion: failed to submit",
        properties: {
          error: completionResult.error,
        },
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
    logger.debug("[ManagedRunController] Handling completion result", { completion, result });

    const { attemptStatus, snapshot: completionSnapshot, run } = result;

    try {
      this.updateRunPhase(run, completionSnapshot);
    } catch (error) {
      console.error("Failed to update run phase after completion", { error });

      this.waitForNextRun();
      return;
    }

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

  sendDebugLog({
    runId,
    message,
    date,
    properties,
  }: {
    runId: string;
    message: string;
    date?: Date;
    properties?: WorkloadDebugLogRequestBody["properties"];
  }) {
    this.httpClient.sendDebugLog(runId, {
      message,
      time: date ?? new Date(),
      properties: {
        ...properties,
        runnerId: this.runnerId,
        workerName: this.workerInstanceName,
      },
    });
  }

  async cancelAttempt(runId: string) {
    logger.log("cancelling attempt", { runId });

    await this.taskRunProcess?.cancel();
  }

  async start() {
    logger.debug("[ManagedRunController] Starting up");

    // Websocket notifications are only an optimisation so we don't need to wait for a successful connection
    this.createSocket();

    // If we have run and snapshot IDs, we can start an attempt immediately
    if (env.TRIGGER_RUN_ID && env.TRIGGER_SNAPSHOT_ID) {
      this.startAndExecuteRunAttempt({
        runFriendlyId: env.TRIGGER_RUN_ID,
        snapshotFriendlyId: env.TRIGGER_SNAPSHOT_ID,
        dequeuedAt: new Date(),
        podScheduledAt: env.TRIGGER_POD_SCHEDULED_AT_MS,
      }).finally(() => {});
      return;
    }

    // ..otherwise we need to wait for a run
    this.waitForNextRun();
    return;
  }

  async stop() {
    logger.debug("[ManagedRunController] Shutting down");

    if (this.taskRunProcess) {
      await this.taskRunProcess.cleanup(true);
    }

    this.runHeartbeat.stop();
    this.snapshotPoller.stop();

    this.socket.close();
  }
}

const workerManifest = await loadWorkerManifest();

const prodWorker = new ManagedRunController({ workerManifest });
await prodWorker.start();

function gatherProcessEnv(): Record<string, string> {
  const $env = {
    NODE_ENV: env.NODE_ENV,
    NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS,
    OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  };

  // Filter out undefined values
  return Object.fromEntries(
    Object.entries($env).filter(([key, value]) => value !== undefined)
  ) as Record<string, string>;
}

async function loadWorkerManifest() {
  const manifest = await readJSONFile("./index.json");
  return WorkerManifest.parse(manifest);
}
