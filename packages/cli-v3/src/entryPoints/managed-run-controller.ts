import { logger } from "../utilities/logger.js";
import { OnWaitMessage, TaskRunProcess } from "../executions/taskRunProcess.js";
import { env as stdEnv } from "std-env";
import { z } from "zod";
import { randomUUID } from "crypto";
import { readJSONFile } from "../utilities/fileSystem.js";
import {
  CompleteRunAttemptResult,
  DequeuedMessage,
  HeartbeatService,
  RunExecutionData,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import {
  WORKLOAD_HEADERS,
  WorkloadClientToServerEvents,
  WorkloadHttpClient,
  WorkloadServerToClientEvents,
  type WorkloadRunAttemptStartResponseBody,
} from "@trigger.dev/core/v3/workers";
import { assertExhaustive } from "../utilities/assertExhaustive.js";
import { setTimeout as sleep } from "timers/promises";
import { io, Socket } from "socket.io-client";

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
  TRIGGER_WORKER_API_URL: z.string().url(),
  TRIGGER_WORKLOAD_CONTROLLER_ID: z.string().default(`controller_${randomUUID()}`),
  TRIGGER_ENV_ID: z.string(),
  TRIGGER_RUN_ID: z.string().optional(), // This is only useful for cold starts
  TRIGGER_SNAPSHOT_ID: z.string().optional(), // This is only useful for cold starts
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url(),
  TRIGGER_WARM_START_URL: z.string().optional(),
  TRIGGER_WARM_START_CONNECTION_TIMEOUT_MS: z.coerce.number().default(30_000),
  TRIGGER_WARM_START_TOTAL_DURATION_MS: z.coerce.number().default(300_000),
  TRIGGER_MACHINE_CPU: z.string().default("0"),
  TRIGGER_MACHINE_MEMORY: z.string().default("0"),
  TRIGGER_WORKER_INSTANCE_NAME: z.string(),
  TRIGGER_RUNNER_ID: z.string(),
});

const env = Env.parse(stdEnv);

logger.loggerLevel = "debug";

type ManagedRunControllerOptions = {
  workerManifest: WorkerManifest;
  heartbeatIntervalSeconds?: number;
};

type Run = {
  friendlyId: string;
};

type Snapshot = {
  friendlyId: string;
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

  private state:
    | {
        phase: "RUN";
        run: Run;
        snapshot: Snapshot;
      }
    | {
        phase: "IDLE" | "WARM_START";
      };

  private enterIdlePhase() {
    this.state = { phase: "IDLE" };
  }

  private enterRunPhase(run: Run, snapshot: Snapshot) {
    this.state = { phase: "RUN", run, snapshot };
  }

  private updateSnapshot(snapshot: Snapshot) {
    if (this.state.phase !== "RUN") {
      throw new Error(`Invalid phase for updating snapshot: ${this.state.phase}`);
    }

    this.state.snapshot = snapshot;
  }

  private enterWarmStartPhase() {
    this.state = { phase: "WARM_START" };
    this.snapshotPollService.stop();
  }

  private get runFriendlyId() {
    if (this.state.phase !== "RUN") {
      return undefined;
    }

    return this.state.run.friendlyId;
  }

  private get snapshotFriendlyId() {
    if (this.state.phase !== "RUN") {
      return undefined;
    }

    return this.state.snapshot.friendlyId;
  }

  constructor(opts: ManagedRunControllerOptions) {
    logger.debug("[ManagedRunController] Creating controller", { env });

    this.workerManifest = opts.workerManifest;
    // TODO: This should be dynamic and set by (or at least overridden by) the managed worker / platform
    this.heartbeatIntervalSeconds = opts.heartbeatIntervalSeconds || 30;
    this.snapshotPollIntervalSeconds = 5;

    if (env.TRIGGER_RUN_ID) {
      if (!env.TRIGGER_SNAPSHOT_ID) {
        throw new Error("Missing snapshot ID");
      }

      this.state = {
        phase: "RUN",
        run: { friendlyId: env.TRIGGER_RUN_ID },
        snapshot: { friendlyId: env.TRIGGER_SNAPSHOT_ID },
      };
    } else {
      this.enterIdlePhase();
    }

    this.httpClient = new WorkloadHttpClient({
      workerApiUrl: env.TRIGGER_WORKER_API_URL,
      deploymentId: env.TRIGGER_DEPLOYMENT_ID,
      runnerId: env.TRIGGER_RUNNER_ID,
    });

    this.snapshotPollService = new HeartbeatService({
      heartbeat: async () => {
        if (!this.runFriendlyId) {
          logger.debug("[ManagedRunController] Skipping snapshot poll, no run ID");
          return;
        }

        console.debug("[ManagedRunController] Polling for latest snapshot");

        const response = await this.httpClient.getRunExecutionData(this.runFriendlyId);

        if (!response.success) {
          console.error("[ManagedRunController] Snapshot poll failed", { error: response.error });
          return;
        }

        const { snapshot } = response.data.execution;

        if (snapshot.friendlyId === this.snapshotFriendlyId) {
          console.debug("[ManagedRunController] Snapshot not changed", {
            snapshotId: this.snapshotFriendlyId,
          });
          return;
        }

        console.log("Snapshot changed", {
          oldSnapshotId: this.snapshotFriendlyId,
          newSnapshotId: snapshot.friendlyId,
        });

        this.updateSnapshot(snapshot);

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
        if (!this.runFriendlyId || !this.snapshotFriendlyId) {
          logger.debug("[ManagedRunController] Skipping heartbeat, no run ID or snapshot ID");
          return;
        }

        console.debug("[ManagedRunController] Sending heartbeat");

        const response = await this.httpClient.heartbeatRun(
          this.runFriendlyId,
          this.snapshotFriendlyId,
          {
            cpu: 0,
            memory: 0,
          }
        );

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
    console.log("Got latest snapshot", { snapshot, currentSnapshotId: this.snapshotFriendlyId });

    this.updateSnapshot(snapshot);

    switch (snapshot.executionStatus) {
      case "PENDING_CANCEL": {
        try {
          await this.cancelAttempt(run.friendlyId);
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
        break;
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
          break;
        }

        // TODO: Make this configurable and add wait debounce
        await sleep(200);

        if (snapshot.friendlyId !== this.snapshotFriendlyId) {
          console.debug("Snapshot changed after suspend threshold, abort", {
            oldSnapshotId: snapshot.friendlyId,
            newSnapshotId: this.snapshotFriendlyId,
          });
          break;
        }

        if (!this.runFriendlyId || !this.snapshotFriendlyId) {
          console.error("Missing run ID or snapshot ID after suspension, abort", {
            runId: this.runFriendlyId,
            snapshotId: this.snapshotFriendlyId,
          });
          break;
        }

        const suspendResult = await this.httpClient.suspendRun(
          this.runFriendlyId,
          this.snapshotFriendlyId
        );

        if (!suspendResult.success) {
          console.error("Failed to suspend run, staying alive 🎶", { error: suspendResult.error });
          break;
        }

        console.log("Suspending, any day now 🚬", { suspendResult: suspendResult.data });

        break;
      }
      case "SUSPENDED": {
        console.log("Run was suspended, kill the process and wait for more runs", {
          run,
          snapshot,
        });

        // Kill the run process
        await this.taskRunProcess?.kill("SIGKILL");

        // Warm start
        this.waitForNextRun();

        break;
      }
      case "PENDING_EXECUTING": {
        console.log("Run is pending execution", { run, snapshot });

        if (completedWaitpoints.length === 0) {
          console.log("No waitpoints to complete, nothing to do");
          break;
        }

        // There are waitpoints to complete so we've been restored after being suspended
        // Let's reconnect the websocket first
        // TODO: fix joining run notifications room on reconnect
        this.socket?.disconnect();
        this.socket?.connect();

        await sleep(1000);

        // We need to let the platform know we're ready to continue
        const continuationResult = await this.httpClient.continueRunExecution(
          run.friendlyId,
          snapshot.friendlyId
        );

        if (!continuationResult.success) {
          console.error("Failed to continue execution", { error: continuationResult.error });

          // Kill the run process
          await this.taskRunProcess?.kill("SIGKILL");

          // Warm start
          this.waitForNextRun();

          break;
        }

        break;
      }
      case "EXECUTING": {
        console.log("Run is now executing", { run, snapshot });

        if (completedWaitpoints.length > 0) {
          console.log("Processing completed waitpoints", { completedWaitpoints });
          completedWaitpoints.forEach((waitpoint) => {
            this.taskRunProcess?.waitpointCompleted(waitpoint);
          });
        }

        break;
      }
      default: {
        console.log("Status change not handled yet", { status: snapshot.executionStatus });
        // assertExhaustive(snapshot.executionStatus);
        break;
      }
    }
  }

  private async startAndExecuteRunAttempt(isWarmStart = false) {
    if (!this.runFriendlyId || !this.snapshotFriendlyId) {
      logger.debug("[ManagedRunController] Missing run ID or snapshot ID", {
        runId: this.runFriendlyId,
        snapshotId: this.snapshotFriendlyId,
      });
      process.exit(1);
    }

    if (!this.socket) {
      console.warn("[ManagedRunController] Starting run without socket connection");
    }

    this.socket?.emit("run:start", {
      version: "1",
      run: { friendlyId: this.runFriendlyId },
      snapshot: { friendlyId: this.snapshotFriendlyId },
    });

    const start = await this.httpClient.startRunAttempt(
      this.runFriendlyId,
      this.snapshotFriendlyId,
      {
        isWarmStart,
      }
    );

    if (!start.success) {
      console.error("[ManagedRunController] Failed to start run", { error: start.error });
      process.exit(1);
    }

    const { run, snapshot, execution, envVars } = start.data;

    logger.debug("[ManagedRunController] Started run", {
      runId: run.friendlyId,
      snapshot: snapshot.friendlyId,
    });

    this.updateSnapshot(snapshot);

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
        this.runFriendlyId,
        this.snapshotFriendlyId,
        { completion }
      );

      if (!completionResult.success) {
        console.error("Failed to submit completion after error", {
          error: completionResult.error,
        });
        process.exit(1);
      }

      logger.log("Attempt completion submitted after error", completionResult.data.result);

      try {
        await this.handleCompletionResult(completion, completionResult.data.result);
      } catch (error) {
        console.error("Failed to handle completion result after error", { error });
        process.exit(1);
      }
    }
  }

  private async waitForNextRun() {
    logger.debug("[ManagedRunController] Waiting for next run");

    this.enterWarmStartPhase();

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
            "x-trigger-worker-instance-name": env.TRIGGER_WORKER_INSTANCE_NAME,
          },
        },
        {
          timeoutMs: env.TRIGGER_WARM_START_CONNECTION_TIMEOUT_MS,
          totalDurationMs: env.TRIGGER_WARM_START_TOTAL_DURATION_MS,
        }
      );

      if (!res.ok) {
        console.error("Failed to poll for next run", { error: res.error });
        process.exit(0);
      }

      const nextRun = DequeuedMessage.parse(res.data);

      console.log("Got next run", { nextRun });

      this.enterRunPhase(nextRun.run, nextRun.snapshot);

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
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: env.TRIGGER_DEPLOYMENT_ID,
        [WORKLOAD_HEADERS.RUNNER_ID]: env.TRIGGER_RUNNER_ID,
      },
    });
    this.socket.on("run:notify", async ({ version, run }) => {
      console.log("[ManagedRunController] Received run notification", { version, run });

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
        return;
      }

      const latestSnapshot = await this.httpClient.getRunExecutionData(this.runFriendlyId);

      if (!latestSnapshot.success) {
        console.error("Failed to get latest snapshot data", latestSnapshot.error);
        return;
      }

      await this.handleSnapshotChange(latestSnapshot.data.execution);
    });
    this.socket.on("connect", () => {
      console.log("[ManagedRunController] Connected to supervisor");
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
  }: WorkloadRunAttemptStartResponseBody) {
    this.snapshotPollService.start();

    this.taskRunProcess = new TaskRunProcess({
      workerManifest: this.workerManifest,
      env: envVars,
      serverWorker: {
        id: "unmanaged",
        contentHash: env.TRIGGER_CONTENT_HASH,
        version: env.TRIGGER_DEPLOYMENT_VERSION,
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
      console.error("Missing run ID or snapshot ID after execution", {
        runId: this.runFriendlyId,
        snapshotId: this.snapshotFriendlyId,
      });
      process.exit(1);
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
      process.exit(1);
    }

    logger.log("Attempt completion submitted", completionResult.data.result);

    try {
      await this.handleCompletionResult(completion, completionResult.data.result);
    } catch (error) {
      console.error("Failed to handle completion result", { error });
      process.exit(1);
    }
  }

  private async handleCompletionResult(
    completion: TaskRunExecutionResult,
    result: CompleteRunAttemptResult
  ) {
    logger.debug("[ManagedRunController] Handling completion result", { completion, result });

    const { attemptStatus, snapshot: completionSnapshot } = result;

    this.updateSnapshot(completionSnapshot);

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

      this.startAndExecuteRunAttempt();
      return;
    }

    assertExhaustive(attemptStatus);
  }

  private async handleWait({ wait }: OnWaitMessage) {
    if (!this.runFriendlyId || !this.snapshotFriendlyId) {
      logger.debug("[ManagedRunController] Ignoring wait, no run ID or snapshot ID");
      return;
    }

    switch (wait.type) {
      case "DATETIME": {
        logger.log("Waiting for duration", { wait });

        const waitpoint = await this.httpClient.waitForDuration(
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
  }

  async stop() {
    logger.debug("[ManagedRunController] Shutting down");

    if (this.taskRunProcess) {
      await this.taskRunProcess.cleanup(true);
    }

    this.heartbeatService.stop();
    this.snapshotPollService.stop();

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
