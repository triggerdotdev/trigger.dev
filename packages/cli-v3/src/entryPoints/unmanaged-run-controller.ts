import { logger } from "../utilities/logger.js";
import { TaskRunProcess } from "../executions/taskRunProcess.js";
import { env as stdEnv } from "std-env";
import { z } from "zod";
import { CLOUD_API_URL } from "../consts.js";
import { randomUUID } from "crypto";
import { readJSONFile } from "../utilities/fileSystem.js";
import { WorkerManifest } from "@trigger.dev/core/v3";
import { WorkerSession } from "@trigger.dev/worker";

const Env = z.object({
  TRIGGER_API_URL: z.string().default(CLOUD_API_URL),
  TRIGGER_CONTENT_HASH: z.string(),
  TRIGGER_WORKER_TOKEN: z.string(),
  TRIGGER_WORKER_INSTANCE_NAME: z.string().default(randomUUID()),
  TRIGGER_DEPLOYMENT_ID: z.string(),
  TRIGGER_DEPLOYMENT_VERSION: z.string(),
  NODE_ENV: z.string().default("production"),
  NODE_EXTRA_CA_CERTS: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default("http://0.0.0.0:3030/otel"),
});

const env = Env.parse(stdEnv);

logger.loggerLevel = "debug";
logger.debug("Creating unmanaged worker", { env });

class UnmanagedRunController {
  private readonly session: WorkerSession;
  private taskRunProcess?: TaskRunProcess;

  constructor(private workerManifest: WorkerManifest) {
    this.session = new WorkerSession({
      workerToken: env.TRIGGER_WORKER_TOKEN,
      apiUrl: env.TRIGGER_API_URL,
      instanceName: env.TRIGGER_WORKER_INSTANCE_NAME,
      deploymentId: env.TRIGGER_DEPLOYMENT_ID,
      dequeueIntervalMs: 1000,
    });

    this.session.on("runQueueMessage", async ({ time, message }) => {
      logger.debug("[UnmanagedRunController] Received runQueueMessage", { time, message });

      this.session.emit("requestRunAttemptStart", {
        time: new Date(),
        run: {
          id: message.run.id,
        },
        snapshot: {
          id: message.snapshot.id,
        },
      });
    });

    this.session.on("runAttemptStarted", async ({ time, run, snapshot, execution, envVars }) => {
      const taskRunEnv = {
        ...gatherProcessEnv(),
        ...envVars,
      };

      this.taskRunProcess = new TaskRunProcess({
        workerManifest: this.workerManifest,
        env: taskRunEnv,
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

      try {
        await this.taskRunProcess.initialize();

        logger.log("executing task run process", {
          attemptId: execution.attempt.id,
          runId: execution.run.id,
        });

        const completion = await this.taskRunProcess.execute();

        logger.log("completed", completion);

        try {
          await this.taskRunProcess.cleanup(true);
        } catch (error) {
          console.error("Failed to cleanup task run process, submitting completion anyway", {
            error,
          });
        }

        this.session.emit("runAttemptCompleted", {
          time: new Date(),
          run: {
            id: run.id,
          },
          snapshot: {
            id: snapshot.id,
          },
          completion,
        });
      } catch (error) {
        console.error("Failed to complete lazy attempt", {
          error,
        });

        this.session.emit("runAttemptCompleted", {
          time: new Date(),
          run: {
            id: run.id,
          },
          snapshot: {
            id: snapshot.id,
          },
          completion: {
            id: execution.run.id,
            ok: false,
            retry: undefined,
            error: TaskRunProcess.parseExecuteError(error),
          },
        });
      }
    });

    process.on("SIGTERM", async () => {
      logger.debug("[UnmanagedRunController] Received SIGTERM, stopping worker");
      await this.stop();
    });
  }

  async start() {
    logger.debug("[UnmanagedRunController] Starting up");
    await this.session.start();
  }

  async stop() {
    logger.debug("[UnmanagedRunController] Shutting down");
    await this.session.stop();
  }
}

const workerManifest = await loadWorkerManifest();

const prodWorker = new UnmanagedRunController(workerManifest);
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
