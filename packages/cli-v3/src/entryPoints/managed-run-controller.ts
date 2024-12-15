import { logger } from "../utilities/logger.js";
import { OnWaitMessage, TaskRunProcess } from "../executions/taskRunProcess.js";
import { env as stdEnv } from "std-env";
import { z } from "zod";
import { CLOUD_API_URL } from "../consts.js";
import { randomUUID } from "crypto";
import { readJSONFile } from "../utilities/fileSystem.js";
import {
  DequeuedMessage,
  HeartbeatService,
  RunExecutionData,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import {
  WORKLOAD_HEADER_NAME,
  WorkloadClientToServerEvents,
  WorkloadHttpClient,
  WorkloadServerToClientEvents,
  type WorkloadRunAttemptStartResponseBody,
} from "@trigger.dev/worker";
import { assertExhaustive } from "../utilities/assertExhaustive.js";
import { setTimeout as wait } from "timers/promises";
import { io, Socket } from "socket.io-client";

const Env = z.object({
  TRIGGER_API_URL: z.string().url().default(CLOUD_API_URL),
  TRIGGER_CONTENT_HASH: z.string(),
  TRIGGER_WORKER_API_URL: z.string().url(),
  TRIGGER_WORKLOAD_CONTROLLER_ID: z.string().default(randomUUID()),
  TRIGGER_DEPLOYMENT_ID: z.string(),
  TRIGGER_DEPLOYMENT_VERSION: z.string(),
  TRIGGER_ENV_ID: z.string(),
  // This is only useful for cold starts
  TRIGGER_RUN_ID: z.string().optional(),
  // This is only useful for cold starts
  TRIGGER_SNAPSHOT_ID: z.string().optional(),
  NODE_ENV: z.string().default("production"),
  NODE_EXTRA_CA_CERTS: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default("http://0.0.0.0:3030/otel"),
  TRIGGER_WARM_START_URL: z.string().optional(),
  TRIGGER_MACHINE_CPU: z.string().default("0"),
  TRIGGER_MACHINE_MEMORY: z.string().default("0"),
});

const env = Env.parse(stdEnv);

logger.loggerLevel = "debug";

type ManagedRunControllerOptions = {
  workerManifest: WorkerManifest;
  heartbeatIntervalSeconds?: number;
};

class ManagedRunController {
  private taskRunProcess?: TaskRunProcess;

  private workerManifest: WorkerManifest;

  private readonly httpClient: WorkloadHttpClient;

  private socket?: Socket<WorkloadServerToClientEvents, WorkloadClientToServerEvents>;

  private readonly heartbeatService: HeartbeatService;
  private readonly heartbeatIntervalSeconds: number;

  private readonly snapshotPollService: HeartbeatService;
  private readonly snapshotPollIntervalSeconds: number;

  private runId?: string;
  private snapshotId?: string;

  constructor(opts: ManagedRunControllerOptions) {
    logger.debug("[ManagedRunController] Creating controller", { env });

    this.workerManifest = opts.workerManifest;
    // TODO: This should be dynamic and set by (or at least overridden by) the managed worker / platform
    this.heartbeatIntervalSeconds = opts.heartbeatIntervalSeconds || 30;
    this.snapshotPollIntervalSeconds = 5;

    this.runId = env.TRIGGER_RUN_ID;
    this.snapshotId = env.TRIGGER_SNAPSHOT_ID;

    this.httpClient = new WorkloadHttpClient({
      workerApiUrl: env.TRIGGER_WORKER_API_URL,
      deploymentId: env.TRIGGER_DEPLOYMENT_ID,
    });

    this.snapshotPollService = new HeartbeatService({
      heartbeat: async () => {
        if (!this.runId) {
          logger.debug("[ManagedRunController] Skipping snapshot poll, no run ID");
          return;
        }

        console.debug("[ManagedRunController] Polling for latest snapshot");

        const response = await this.httpClient.getRunExecutionData(this.runId);

        if (!response.success) {
          console.error("[ManagedRunController] Snapshot poll failed", { error: response.error });
          return;
        }

        const { snapshot } = response.data.execution;

        if (snapshot.id === this.snapshotId) {
          console.debug("[ManagedRunController] Snapshot not changed", {
            snapshotId: this.snapshotId,
          });
          return;
        }

        console.log("Snapshot changed", {
          oldSnapshotId: this.snapshotId,
          newSnapshotId: snapshot.id,
        });

        this.snapshotId = snapshot.id;

        await this.handleSnapshotChange(response.data.execution);
      },
      intervalMs: this.snapshotPollIntervalSeconds * 1000,
      leadingEdge: false,
      onError: async (error) => {
        console.error("[ManagedRunController] Failed to poll for snapshot", { error });
      },
    });

    this.heartbeatService = new HeartbeatService({
      heartbeat: async () => {
        if (!this.runId || !this.snapshotId) {
          logger.debug("[ManagedRunController] Skipping heartbeat, no run ID or snapshot ID");
          return;
        }

        console.debug("[ManagedRunController] Sending heartbeat");

        const response = await this.httpClient.heartbeatRun(this.runId, this.snapshotId, {
          cpu: 0,
          memory: 0,
        });

        if (!response.success) {
          console.error("[ManagedRunController] Heartbeat failed", { error: response.error });
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

  private async handleSnapshotChange({ run, snapshot, completedWaitpoints }: RunExecutionData) {
    console.log("Got latest snapshot", { snapshot, currentSnapshotId: this.snapshotId });

    this.snapshotId = snapshot.id;

    switch (snapshot.executionStatus) {
      case "PENDING_CANCEL": {
        try {
          await this.cancelAttempt(run.id);
        } catch (error) {
          console.error("Failed to cancel attempt, shutting down", {
            error,
          });
          process.exit(1);
        }
        break;
      }
      case "FINISHED": {
        console.log("Run is finished, shutting down shortly");
        return;
      }
      default: {
        console.log("Status change not handled yet", { status: snapshot.executionStatus });
        // assertExhaustive(snapshot.executionStatus);
        break;
      }
    }

    if (completedWaitpoints.length > 0) {
      console.log("Got completed waitpoints", { completedWaitpoints });
      completedWaitpoints.forEach((waitpoint) => {
        this.taskRunProcess?.waitpointCompleted(waitpoint);
      });
    }
  }

  private async startAndExecuteRunAttempt(isWarmStart = false) {
    if (!this.runId || !this.snapshotId) {
      logger.debug("[ManagedRunController] Missing run ID or snapshot ID", {
        runId: this.runId,
        snapshotId: this.snapshotId,
      });
      process.exit(1);
    }

    if (!this.socket) {
      console.warn("[ManagedRunController] Starting run without socket connection");
    }

    this.socket?.emit("run:start", {
      version: "1",
      run: { id: this.runId },
      snapshot: { id: this.snapshotId },
    });

    const start = await this.httpClient.startRunAttempt(this.runId, this.snapshotId, {
      isWarmStart,
    });

    if (!start.success) {
      console.error("[ManagedRunController] Failed to start run", { error: start.error });
      process.exit(1);
    }

    const { run, snapshot, execution, envVars } = start.data;

    logger.debug("[ManagedRunController] Started run", {
      runId: run.id,
      snapshot: snapshot.id,
    });

    this.runId = run.id;
    this.snapshotId = snapshot.id;

    const taskRunEnv = {
      ...gatherProcessEnv(),
      ...envVars,
    };

    try {
      return await this.executeRun({ run, snapshot, envVars: taskRunEnv, execution });
    } catch (error) {
      console.error("Error while executing attempt", {
        error,
      });

      console.log("Submitting attempt completion", {
        runId: run.id,
        snapshotId: snapshot.id,
        updatedSnapshotId: this.snapshotId,
      });

      const completionResult = await this.httpClient.completeRunAttempt(run.id, this.snapshotId, {
        completion: {
          id: execution.run.id,
          ok: false,
          retry: undefined,
          error: TaskRunProcess.parseExecuteError(error),
        },
      });

      if (!completionResult.success) {
        console.error("Failed to submit completion after error", {
          error: completionResult.error,
        });
        process.exit(1);
      }

      logger.log("Attempt completion submitted", completionResult.data.result);
    } finally {
      this.runId = undefined;
      this.snapshotId = undefined;

      this.waitForNextRun();
    }
  }

  private async waitForNextRun() {
    try {
      const warmStartUrl = new URL(
        "/warm-start",
        env.TRIGGER_WARM_START_URL ?? env.TRIGGER_WORKER_API_URL
      );

      const res = await longPoll<DequeuedMessage>(
        warmStartUrl.href,
        {
          method: "GET",
          headers: {
            "x-trigger-workload-controller-id": env.TRIGGER_WORKLOAD_CONTROLLER_ID,
            "x-trigger-deployment-id": env.TRIGGER_DEPLOYMENT_ID,
            "x-trigger-deployment-version": env.TRIGGER_DEPLOYMENT_VERSION,
            "x-trigger-machine-cpu": env.TRIGGER_MACHINE_CPU,
            "x-trigger-machine-memory": env.TRIGGER_MACHINE_MEMORY,
          },
        },
        {
          timeoutMs: 10_000,
          totalDurationMs: 60_000,
        }
      );

      if (!res.ok) {
        console.error("Failed to poll for next run", { error: res.error });
        process.exit(0);
      }

      const nextRun = DequeuedMessage.parse(res.data);

      console.log("Got next run", { nextRun });

      this.runId = nextRun.run.id;
      this.snapshotId = nextRun.snapshot.id;

      this.startAndExecuteRunAttempt(true);
    } catch (error) {
      console.error("Unexpected error while polling for next run", { error });
      process.exit(1);
    }
  }

  createSocket() {
    const wsUrl = new URL(env.TRIGGER_WORKER_API_URL);
    wsUrl.pathname = "/workload";

    this.socket = io(wsUrl.href, {
      transports: ["websocket"],
      extraHeaders: {
        [WORKLOAD_HEADER_NAME.WORKLOAD_DEPLOYMENT_ID]: env.TRIGGER_DEPLOYMENT_ID,
      },
    });
    this.socket.on("run:notify", async ({ version, run }) => {
      console.log("[ManagedRunController] Received run notification", { version, run });

      if (run.id !== this.runId) {
        console.log("[ManagedRunController] Ignoring notification for different run", {
          runId: run.id,
          currentRunId: this.runId,
          currentSnapshotId: this.snapshotId,
        });
        return;
      }

      const latestSnapshot = await this.httpClient.getRunExecutionData(run.id);

      if (!latestSnapshot.success) {
        console.error("Failed to get latest snapshot data", latestSnapshot.error);
        return;
      }

      await this.handleSnapshotChange(latestSnapshot.data.execution);
    });
    this.socket.on("connect", () => {
      console.log("[ManagedRunController] Connected to platform");
    });
    this.socket.on("connect_error", (error) => {
      console.error("[ManagedRunController] Connection error", { error });
    });
    this.socket.on("disconnect", (reason, description) => {
      console.log("[ManagedRunController] Disconnected from platform", { reason, description });
    });
  }

  private async executeRun({
    run,
    snapshot,
    envVars,
    execution,
  }: WorkloadRunAttemptStartResponseBody) {
    this.taskRunProcess = new TaskRunProcess({
      workerManifest: this.workerManifest,
      env: envVars,
      serverWorker: {
        id: "unmanaged",
        contentHash: env.TRIGGER_CONTENT_HASH,
        version: env.TRIGGER_DEPLOYMENT_VERSION,
      },
      payload: {
        execution,
        traceContext: execution.run.traceContext ?? {},
      },
      messageId: run.id,
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

    if (!this.runId || !this.snapshotId) {
      console.error("Missing run ID or snapshot ID after execution", {
        runId: this.runId,
        snapshotId: this.snapshotId,
      });
      process.exit(1);
    }

    const completionResult = await this.httpClient.completeRunAttempt(run.id, this.snapshotId, {
      completion,
    });

    if (!completionResult.success) {
      console.error("Failed to submit completion", {
        error: completionResult.error,
      });
      process.exit(1);
    }

    logger.log("Completion submitted", completionResult.data.result);

    const { attemptStatus } = completionResult.data.result;

    this.runId = completionResult.data.result.run.id;
    this.snapshotId = completionResult.data.result.snapshot.id;

    if (attemptStatus === "RUN_FINISHED") {
      logger.debug("Run finished");
      return;
    }

    if (attemptStatus === "RUN_PENDING_CANCEL") {
      logger.debug("Run pending cancel");
      return;
    }

    if (attemptStatus === "RETRY_QUEUED") {
      logger.debug("Retry queued");
      return;
    }

    if (attemptStatus === "RETRY_IMMEDIATELY") {
      if (completion.ok) {
        throw new Error("Should retry but completion OK.");
      }

      if (!completion.retry) {
        throw new Error("Should retry but missing retry params.");
      }

      await wait(completion.retry.delay);

      this.startAndExecuteRunAttempt();
      return;
    }

    assertExhaustive(attemptStatus);
  }

  private async handleWait({ wait }: OnWaitMessage) {
    if (!this.runId || !this.snapshotId) {
      logger.debug("[ManagedRunController] Ignoring wait, no run ID or snapshot ID");
      return;
    }

    switch (wait.type) {
      case "DATETIME": {
        logger.log("Waiting for duration", { wait });

        const waitpoint = await this.httpClient.waitForDuration(this.runId, this.snapshotId, {
          date: wait.date,
        });

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

  async cancelAttempt(runId: string) {
    logger.log("cancelling attempt", { runId });

    await this.taskRunProcess?.cancel();
  }

  async start() {
    logger.debug("[ManagedRunController] Starting up");

    // TODO: remove this after testing
    setTimeout(() => {
      console.error("[ManagedRunController] Exiting after 5 minutes");
      process.exit(1);
    }, 60 * 5000);

    this.heartbeatService.start();
    this.createSocket();

    this.startAndExecuteRunAttempt();
    this.snapshotPollService.start();
  }

  async stop() {
    logger.debug("[ManagedRunController] Shutting down");

    if (this.taskRunProcess) {
      await this.taskRunProcess.cleanup(true);
    }

    this.heartbeatService.stop();
    this.socket?.close();
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
        console.log("Request timed out, retrying...");
        continue;
      } else {
        console.error("Error during fetch, retrying...", error);

        // TODO: exponential backoff
        await wait(1000);
        continue;
      }
    }
  }

  return {
    ok: false,
    error: "TotalDurationExceeded",
  };
};
