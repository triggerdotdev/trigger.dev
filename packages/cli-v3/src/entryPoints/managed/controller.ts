import { WorkerManifest } from "@trigger.dev/core/v3";
import {
  WarmStartClient,
  WORKLOAD_HEADERS,
  type WorkloadClientToServerEvents,
  WorkloadHttpClient,
  type WorkloadServerToClientEvents,
} from "@trigger.dev/core/v3/workers";
import { io, type Socket } from "socket.io-client";
import { RunnerEnv } from "./env.js";
import { RunLogger, SendDebugLogOptions } from "./logger.js";
import { EnvObject } from "std-env";
import { RunExecution } from "./execution.js";
import { tryCatch } from "@trigger.dev/core/utils";

type ManagedRunControllerOptions = {
  workerManifest: WorkerManifest;
  env: EnvObject;
};

type SupervisorSocket = Socket<WorkloadServerToClientEvents, WorkloadClientToServerEvents>;

export class ManagedRunController {
  private readonly env: RunnerEnv;
  private readonly workerManifest: WorkerManifest;
  private readonly httpClient: WorkloadHttpClient;
  private readonly warmStartClient: WarmStartClient | undefined;
  private socket: SupervisorSocket;
  private readonly logger: RunLogger;

  private warmStartCount = 0;
  private restoreCount = 0;

  private currentExecution: RunExecution | null = null;

  constructor(opts: ManagedRunControllerOptions) {
    const env = new RunnerEnv(opts.env);
    this.env = env;

    this.workerManifest = opts.workerManifest;

    this.httpClient = new WorkloadHttpClient({
      workerApiUrl: this.workerApiUrl,
      runnerId: this.runnerId,
      deploymentId: env.TRIGGER_DEPLOYMENT_ID,
      deploymentVersion: env.TRIGGER_DEPLOYMENT_VERSION,
      projectRef: env.TRIGGER_PROJECT_REF,
    });

    this.logger = new RunLogger({
      httpClient: this.httpClient,
      env,
    });

    const properties = {
      ...env.raw,
      TRIGGER_POD_SCHEDULED_AT_MS: env.TRIGGER_POD_SCHEDULED_AT_MS.toISOString(),
      TRIGGER_DEQUEUED_AT_MS: env.TRIGGER_DEQUEUED_AT_MS.toISOString(),
    };

    this.sendDebugLog({
      runId: env.TRIGGER_RUN_ID,
      message: "Creating run controller",
      properties,
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

    // Websocket notifications are only an optimisation so we don't need to wait for a successful connection
    this.socket = this.createSupervisorSocket();

    process.on("SIGTERM", async () => {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "Received SIGTERM, stopping worker",
      });
      await this.stop();
    });
  }

  get metrics() {
    return {
      warmStartCount: this.warmStartCount,
      restoreCount: this.restoreCount,
    };
  }

  get runnerId() {
    return this.env.TRIGGER_RUNNER_ID;
  }

  get successExitCode() {
    return this.env.TRIGGER_SUCCESS_EXIT_CODE;
  }

  get failureExitCode() {
    return this.env.TRIGGER_FAILURE_EXIT_CODE;
  }

  get workerApiUrl() {
    return this.env.TRIGGER_SUPERVISOR_API_URL;
  }

  get workerInstanceName() {
    return this.env.TRIGGER_WORKER_INSTANCE_NAME;
  }

  private subscribeToRunNotifications(runFriendlyId: string, snapshotFriendlyId: string) {
    this.socket.emit("run:start", {
      version: "1",
      run: {
        friendlyId: runFriendlyId,
      },
      snapshot: {
        friendlyId: snapshotFriendlyId,
      },
    });
  }

  private unsubscribeFromRunNotifications(runFriendlyId: string, snapshotFriendlyId: string) {
    this.socket.emit("run:stop", {
      version: "1",
      run: {
        friendlyId: runFriendlyId,
      },
      snapshot: {
        friendlyId: snapshotFriendlyId,
      },
    });
  }

  private get runFriendlyId() {
    return this.currentExecution?.runFriendlyId;
  }

  private get snapshotFriendlyId() {
    return this.currentExecution?.currentSnapshotFriendlyId;
  }

  private lockedRunExecution: Promise<void> | null = null;

  private async startRunExecution({
    runFriendlyId,
    snapshotFriendlyId,
    dequeuedAt,
    podScheduledAt,
    isWarmStart,
    previousRunId,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    dequeuedAt?: Date;
    podScheduledAt?: Date;
    isWarmStart?: boolean;
    previousRunId?: string;
  }) {
    this.sendDebugLog({
      runId: runFriendlyId,
      message: "startAndExecuteRunAttempt()",
      properties: { previousRunId },
    });

    if (this.lockedRunExecution) {
      this.sendDebugLog({
        runId: runFriendlyId,
        message: "startAndExecuteRunAttempt: execution already locked",
      });
      return;
    }

    const execution = async () => {
      if (!this.currentExecution || !this.currentExecution.isPreparedForNextRun) {
        this.currentExecution = new RunExecution({
          workerManifest: this.workerManifest,
          env: this.env,
          httpClient: this.httpClient,
          logger: this.logger,
        });
      }

      // Subscribe to run notifications
      this.subscribeToRunNotifications(runFriendlyId, snapshotFriendlyId);

      // We're prepared for the next run so we can start executing
      await this.currentExecution.execute({
        runFriendlyId,
        snapshotFriendlyId,
        dequeuedAt,
        podScheduledAt,
        isWarmStart,
      });
    };

    this.lockedRunExecution = execution();

    const [error] = await tryCatch(this.lockedRunExecution);

    if (error) {
      this.sendDebugLog({
        runId: runFriendlyId,
        message: "Error during execution",
        properties: { error: error.message },
      });
    }

    const metrics = this.currentExecution?.metrics;

    if (metrics?.restoreCount) {
      this.restoreCount += metrics.restoreCount;
    }

    this.lockedRunExecution = null;
    this.unsubscribeFromRunNotifications(runFriendlyId, snapshotFriendlyId);
    this.waitForNextRun();
  }

  private waitForNextRunLock = false;

  /**
   *  This will eagerly create a new run execution. It will never throw, but may exit
   *  the process on any errors or when no runs are available after the configured duration.
   */
  private async waitForNextRun() {
    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "waitForNextRun()",
    });

    if (this.waitForNextRunLock) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "waitForNextRun: already in progress, skipping",
      });
      return;
    }

    if (this.lockedRunExecution) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "waitForNextRun: execution locked, skipping",
      });
      return;
    }

    this.waitForNextRunLock = true;

    const previousRunId = this.runFriendlyId;

    try {
      if (!this.warmStartClient) {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "waitForNextRun: warm starts disabled, shutting down",
        });
        this.exitProcess(this.successExitCode);
      }

      if (this.currentExecution?.taskRunEnv) {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "waitForNextRun: eagerly recreating task run process",
        });

        const previousTaskRunEnv = this.currentExecution.taskRunEnv;

        this.currentExecution = new RunExecution({
          workerManifest: this.workerManifest,
          env: this.env,
          httpClient: this.httpClient,
          logger: this.logger,
        }).prepareForExecution({
          taskRunEnv: previousTaskRunEnv,
        });
      }

      // Check the service is up and get additional warm start config
      const connect = await this.warmStartClient.connect();

      if (!connect.success) {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "waitForNextRun: failed to connect to warm start service",
          properties: {
            warmStartUrl: this.env.TRIGGER_WARM_START_URL,
            error: connect.error,
          },
        });
        this.exitProcess(this.successExitCode);
      }

      const connectionTimeoutMs =
        connect.data.connectionTimeoutMs ?? this.env.TRIGGER_WARM_START_CONNECTION_TIMEOUT_MS;
      const keepaliveMs = connect.data.keepaliveMs ?? this.env.TRIGGER_WARM_START_KEEPALIVE_MS;

      const warmStartConfig = {
        connectionTimeoutMs,
        keepaliveMs,
      };

      this.sendDebugLog({
        runId: previousRunId,
        message: "waitForNextRun: connected to warm start service",
        properties: warmStartConfig,
      });

      if (!connectionTimeoutMs || !keepaliveMs) {
        this.sendDebugLog({
          runId: previousRunId,
          message: "waitForNextRun: warm starts disabled after connect",
          properties: warmStartConfig,
        });
        this.exitProcess(this.successExitCode);
      }

      const nextRun = await this.warmStartClient.warmStart({
        workerInstanceName: this.workerInstanceName,
        connectionTimeoutMs,
        keepaliveMs,
      });

      if (!nextRun) {
        this.sendDebugLog({
          runId: previousRunId,
          message: "waitForNextRun: warm start failed, shutting down",
          properties: warmStartConfig,
        });
        this.exitProcess(this.successExitCode);
      }

      this.warmStartCount++;

      this.sendDebugLog({
        runId: previousRunId,
        message: "waitForNextRun: got next run",
        properties: {
          ...warmStartConfig,
          nextRunId: nextRun.run.friendlyId,
        },
      });

      this.startRunExecution({
        runFriendlyId: nextRun.run.friendlyId,
        snapshotFriendlyId: nextRun.snapshot.friendlyId,
        dequeuedAt: nextRun.dequeuedAt,
        isWarmStart: true,
        previousRunId,
      }).finally(() => {});
    } catch (error) {
      this.sendDebugLog({
        runId: previousRunId,
        message: "waitForNextRun: unexpected error",
        properties: { error: error instanceof Error ? error.message : String(error) },
      });
      this.exitProcess(this.failureExitCode);
    } finally {
      this.waitForNextRunLock = false;
    }
  }

  private exitProcess(code?: number): never {
    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "Exiting process",
      properties: { code },
    });

    this.currentExecution?.exit();

    process.exit(code);
  }

  createSupervisorSocket(): SupervisorSocket {
    const wsUrl = new URL("/workload", this.workerApiUrl);

    const socket = io(wsUrl.href, {
      transports: ["websocket"],
      extraHeaders: {
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: this.env.TRIGGER_DEPLOYMENT_ID,
        [WORKLOAD_HEADERS.RUNNER_ID]: this.env.TRIGGER_RUNNER_ID,
      },
    }) satisfies SupervisorSocket;

    socket.on("run:notify", async ({ version, run }) => {
      this.sendDebugLog({
        runId: run.friendlyId,
        message: "run:notify received by runner",
        properties: { version, runId: run.friendlyId },
      });

      if (!this.runFriendlyId) {
        this.sendDebugLog({
          runId: run.friendlyId,
          message: "run:notify: ignoring notification, no local run ID",
          properties: {
            currentRunId: this.runFriendlyId,
            currentSnapshotId: this.snapshotFriendlyId,
          },
        });
        return;
      }

      if (run.friendlyId !== this.runFriendlyId) {
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

      const latestSnapshot = await this.httpClient.getRunExecutionData(this.runFriendlyId);

      if (!latestSnapshot.success) {
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

      const runExecutionData = latestSnapshot.data.execution;

      if (!this.currentExecution) {
        this.sendDebugLog({
          runId: runExecutionData.run.friendlyId,
          message: "handleSnapshotChange: no current execution",
        });
        return;
      }

      const [error] = await tryCatch(this.currentExecution.handleSnapshotChange(runExecutionData));

      if (error) {
        this.sendDebugLog({
          runId: runExecutionData.run.friendlyId,
          message: "handleSnapshotChange: unexpected error",
          properties: { error: error.message },
        });
      }
    });

    socket.on("connect", () => {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "Socket connected to supervisor",
      });

      // This should handle the case where we reconnect after being restored
      if (
        this.runFriendlyId &&
        this.snapshotFriendlyId &&
        this.runFriendlyId !== this.env.TRIGGER_RUN_ID
      ) {
        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "Subscribing to notifications for in-progress run",
        });
        this.subscribeToRunNotifications(this.runFriendlyId, this.snapshotFriendlyId);
      }
    });

    socket.on("connect_error", (error) => {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "Socket connection error",
        properties: { error: error instanceof Error ? error.message : String(error) },
      });
    });

    socket.on("disconnect", (reason, description) => {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "Socket disconnected from supervisor",
        properties: { reason, description: description?.toString() },
      });
    });

    return socket;
  }

  async cancelAttempt(runId: string) {
    this.sendDebugLog({
      runId,
      message: "cancelling attempt",
      properties: { runId },
    });

    await this.currentExecution?.cancel();
  }

  start() {
    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "Starting up",
    });

    // If we have run and snapshot IDs, we can start an attempt immediately
    if (this.env.TRIGGER_RUN_ID && this.env.TRIGGER_SNAPSHOT_ID) {
      this.startRunExecution({
        runFriendlyId: this.env.TRIGGER_RUN_ID,
        snapshotFriendlyId: this.env.TRIGGER_SNAPSHOT_ID,
        dequeuedAt: this.env.TRIGGER_DEQUEUED_AT_MS,
        podScheduledAt: this.env.TRIGGER_POD_SCHEDULED_AT_MS,
      }).finally(() => {});
      return;
    }

    // ..otherwise we need to wait for a run
    this.waitForNextRun();
    return;
  }

  async stop() {
    this.sendDebugLog({
      runId: this.runFriendlyId,
      message: "Shutting down",
    });

    await this.currentExecution?.cancel();
    this.socket.close();
  }

  sendDebugLog(opts: SendDebugLogOptions) {
    this.logger.sendDebugLog({
      ...opts,
      message: `[controller] ${opts.message}`,
      properties: {
        ...opts.properties,
        runnerWarmStartCount: this.warmStartCount,
        runnerRestoreCount: this.restoreCount,
      },
    });
  }
}
