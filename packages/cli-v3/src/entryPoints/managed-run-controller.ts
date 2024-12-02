import { logger } from "../utilities/logger.js";
import { TaskRunProcess } from "../executions/taskRunProcess.js";
import { env as stdEnv } from "std-env";
import { z } from "zod";
import { CLOUD_API_URL } from "../consts.js";
import { randomUUID } from "crypto";
import { readJSONFile } from "../utilities/fileSystem.js";
import { HeartbeatService, WorkerManifest } from "@trigger.dev/core/v3";
import { WorkloadHttpClient, type WorkloadRunAttemptStartResponseBody } from "@trigger.dev/worker";
import { assertExhaustive } from "../utilities/assertExhaustive.js";
import { setTimeout as wait } from "timers/promises";

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
  private readonly heartbeatService: HeartbeatService;
  private readonly heartbeatIntervalSeconds: number;

  private runId?: string;
  private snapshotId?: string;

  constructor(opts: ManagedRunControllerOptions) {
    logger.debug("[ManagedRunController] Creating controller", { env });

    this.workerManifest = opts.workerManifest;
    // TODO: This should be dynamic and set by (or at least overridden by) the managed worker / platform
    this.heartbeatIntervalSeconds = opts.heartbeatIntervalSeconds || 30;

    this.runId = env.TRIGGER_RUN_ID;
    this.snapshotId = env.TRIGGER_SNAPSHOT_ID;

    this.httpClient = new WorkloadHttpClient({
      workerApiUrl: env.TRIGGER_WORKER_API_URL,
      deploymentId: env.TRIGGER_DEPLOYMENT_ID,
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

  private async startAndExecuteRunAttempt() {
    if (!this.runId || !this.snapshotId) {
      logger.debug("[ManagedRunController] Missing run ID or snapshot ID", {
        runId: this.runId,
        snapshotId: this.snapshotId,
      });
      process.exit(1);
    }

    const start = await this.httpClient.startRunAttempt(this.runId, this.snapshotId);

    if (!start.success) {
      console.error("[ManagedRunController] Failed to start run", { error: start.error });
      process.exit(1);
    }

    logger.debug("[ManagedRunController] Started run", {
      runId: start.data.run.id,
      snapshot: start.data.snapshot.id,
    });

    const { run, snapshot, execution, envVars } = start.data;

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

      const completionResult = await this.httpClient.completeRunAttempt(run.id, snapshot.id, {
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

      logger.log("completed run", completionResult.data.result);
    }
  }

  async start() {
    logger.debug("[ManagedRunController] Starting up");

    // TODO: remove this after testing
    setTimeout(() => {
      // exit after 5 minutes
      console.error("[ManagedRunController] Exiting after 5 minutes");
      process.exit(1);
    }, 60 * 5000);

    this.heartbeatService.start();

    this.startAndExecuteRunAttempt();
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

    const completionResult = await this.httpClient.completeRunAttempt(run.id, snapshot.id, {
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

    this.snapshotId = completionResult.data.result.snapshot.id;

    if (attemptStatus === "RUN_FINISHED") {
      logger.debug("Run finished, shutting down");
      process.exit(0);
    }

    if (attemptStatus === "RUN_PENDING_CANCEL") {
      logger.debug("Run pending cancel, shutting down");
      process.exit(0);
    }

    if (attemptStatus === "RETRY_QUEUED") {
      logger.debug("Retry queued, shutting down");
      process.exit(0);
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

  async stop() {
    logger.debug("[ManagedRunController] Shutting down");

    if (this.taskRunProcess) {
      await this.taskRunProcess.cleanup(true);
    }

    this.heartbeatService.stop();
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
