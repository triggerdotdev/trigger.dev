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
import { ManagedRunLogger, RunLogger, SendDebugLogOptions } from "./logger.js";
import { EnvObject } from "std-env";
import { RunExecution } from "./execution.js";
import { TaskRunProcessProvider } from "./taskRunProcessProvider.js";
import { tryCatch } from "@trigger.dev/core/utils";

type ManagedRunControllerOptions = {
  workerManifest: WorkerManifest;
  env: EnvObject;
};

export type SupervisorSocket = Socket<WorkloadServerToClientEvents, WorkloadClientToServerEvents>;

export class ManagedRunController {
  private readonly env: RunnerEnv;
  private readonly workerManifest: WorkerManifest;
  private readonly httpClient: WorkloadHttpClient;
  private readonly warmStartClient: WarmStartClient | undefined;
  private socket: SupervisorSocket;
  private readonly logger: RunLogger;
  private readonly taskRunProcessProvider: TaskRunProcessProvider;

  private warmStartCount = 0;
  private restoreCount = 0;

  private notificationCount = 0;
  private lastNotificationAt: Date | null = null;

  private currentExecution: RunExecution | null = null;

  private processKeepAliveEnabled: boolean;
  private processKeepAliveMaxExecutionCount: number;

  constructor(opts: ManagedRunControllerOptions) {
    const env = new RunnerEnv(opts.env);
    this.env = env;

    this.workerManifest = opts.workerManifest;
    this.processKeepAliveEnabled = opts.workerManifest.processKeepAlive?.enabled ?? false;
    this.processKeepAliveMaxExecutionCount =
      opts.workerManifest.processKeepAlive?.maxExecutionsPerProcess ?? 100;

    this.httpClient = new WorkloadHttpClient({
      workerApiUrl: this.workerApiUrl,
      runnerId: this.runnerId,
      deploymentId: env.TRIGGER_DEPLOYMENT_ID,
      deploymentVersion: env.TRIGGER_DEPLOYMENT_VERSION,
      projectRef: env.TRIGGER_PROJECT_REF,
    });

    this.logger = new ManagedRunLogger({
      httpClient: this.httpClient,
      env,
    });

    // Create the TaskRunProcessProvider
    this.taskRunProcessProvider = new TaskRunProcessProvider({
      workerManifest: this.workerManifest,
      env: this.env,
      logger: this.logger,
      processKeepAliveEnabled: this.processKeepAliveEnabled,
      processKeepAliveMaxExecutionCount: this.processKeepAliveMaxExecutionCount,
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
      notificationCount: this.notificationCount,
      lastNotificationAt: this.lastNotificationAt,
      ...this.taskRunProcessProvider.metrics,
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
      // If we have an existing execution that isn't prepared for the next run, kill it
      if (this.currentExecution && !this.currentExecution.canExecute) {
        this.sendDebugLog({
          runId: runFriendlyId,
          message: "killing existing execution before starting new run",
        });
        await this.currentExecution.kill().catch(() => {});
        this.currentExecution = null;
      }

      // Remove all run notification listeners just to be safe
      this.socket.removeAllListeners("run:notify");

      if (!this.currentExecution || !this.currentExecution.canExecute) {
        this.currentExecution = new RunExecution({
          workerManifest: this.workerManifest,
          env: this.env,
          httpClient: this.httpClient,
          logger: this.logger,
          supervisorSocket: this.socket,
          taskRunProcessProvider: this.taskRunProcessProvider,
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

    if (metrics?.execution?.restoreCount) {
      this.restoreCount += metrics.execution.restoreCount;
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
          message: "waitForNextRun: eagerly creating fresh execution for next run",
        });

        const previousTaskRunEnv = this.currentExecution.taskRunEnv;

        // Create a fresh execution for the next run
        this.currentExecution = new RunExecution({
          workerManifest: this.workerManifest,
          env: this.env,
          httpClient: this.httpClient,
          logger: this.logger,
          supervisorSocket: this.socket,
          taskRunProcessProvider: this.taskRunProcessProvider,
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

    this.currentExecution?.kill().catch(() => {});
    this.taskRunProcessProvider.cleanup();

    process.exit(code);
  }

  createSupervisorSocket(): SupervisorSocket {
    const wsUrl = new URL("/workload", this.workerApiUrl);

    const socket: SupervisorSocket = io(wsUrl.href, {
      transports: ["websocket"],
      extraHeaders: {
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: this.env.TRIGGER_DEPLOYMENT_ID,
        [WORKLOAD_HEADERS.RUNNER_ID]: this.env.TRIGGER_RUNNER_ID,
      },
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

    socket.on("disconnect", async (reason, description) => {
      const parseDescription = ():
        | {
            description: string;
            context?: string;
          }
        | undefined => {
        if (!description) {
          return undefined;
        }

        if (description instanceof Error) {
          return {
            description: description.toString(),
          };
        }

        return {
          description: description.description,
          context: description.context ? String(description.context) : undefined,
        };
      };

      if (this.currentExecution) {
        const currentEnv = {
          workerInstanceName: this.env.TRIGGER_WORKER_INSTANCE_NAME,
          runnerId: this.env.TRIGGER_RUNNER_ID,
          supervisorApiUrl: this.env.TRIGGER_SUPERVISOR_API_URL,
        };

        await this.currentExecution.processEnvOverrides("socket disconnected");

        const newEnv = {
          workerInstanceName: this.env.TRIGGER_WORKER_INSTANCE_NAME,
          runnerId: this.env.TRIGGER_RUNNER_ID,
          supervisorApiUrl: this.env.TRIGGER_SUPERVISOR_API_URL,
        };

        this.sendDebugLog({
          runId: this.runFriendlyId,
          message: "Socket disconnected from supervisor - processed env overrides",
          properties: { reason, ...parseDescription(), currentEnv, newEnv },
        });

        return;
      }

      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "Socket disconnected from supervisor",
        properties: { reason, ...parseDescription() },
      });
    });

    return socket;
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

    // Cancel the current execution
    const [error] = await tryCatch(this.currentExecution?.cancel());

    if (error) {
      this.sendDebugLog({
        runId: this.runFriendlyId,
        message: "Error during shutdown",
        properties: { error: String(error) },
      });
    }

    // Cleanup the task run process provider
    this.taskRunProcessProvider.cleanup();

    // Close the socket
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
