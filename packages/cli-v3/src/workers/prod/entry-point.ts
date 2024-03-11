import {
  CoordinatorToProdWorkerMessages,
  ProdWorkerToCoordinatorMessages,
  TaskResource,
  ZodSocketConnection,
} from "@trigger.dev/core/v3";
import { HttpReply, getTextBody, SimpleLogger, getRandomPortNumber } from "@trigger.dev/core-apps";
import { createServer } from "node:http";
import { ProdBackgroundWorker } from "./backgroundWorker";
import { UncaughtExceptionError } from "../common/errors";

const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || getRandomPortNumber());
const COORDINATOR_HOST = process.env.COORDINATOR_HOST || "127.0.0.1";
const COORDINATOR_PORT = Number(process.env.COORDINATOR_PORT || 50080);
const MACHINE_NAME = process.env.MACHINE_NAME || "local";
const POD_NAME = process.env.POD_NAME || "some-pod";
const SHORT_HASH = process.env.TRIGGER_CONTENT_HASH!.slice(0, 9);

const logger = new SimpleLogger(`[${MACHINE_NAME}][${SHORT_HASH}]`);

class ProdWorker {
  private apiUrl = process.env.TRIGGER_API_URL!;
  private apiKey = process.env.TRIGGER_SECRET_KEY!;
  private contentHash = process.env.TRIGGER_CONTENT_HASH!;
  private projectDir = process.env.TRIGGER_PROJECT_DIR!;
  private projectRef = process.env.TRIGGER_PROJECT_REF!;
  private envId = process.env.TRIGGER_ENV_ID!;
  private attemptId = process.env.TRIGGER_ATTEMPT_ID || "index-only";
  private deploymentId = process.env.TRIGGER_DEPLOYMENT_ID!;

  private executing = false;
  private completed = false;

  #httpPort: number;
  #backgroundWorker: ProdBackgroundWorker;
  #httpServer: ReturnType<typeof createServer>;
  #coordinatorSocket: ZodSocketConnection<
    typeof ProdWorkerToCoordinatorMessages,
    typeof CoordinatorToProdWorkerMessages
  >;

  constructor(
    port: number,
    private host = "0.0.0.0"
  ) {
    this.#coordinatorSocket = this.#createCoordinatorSocket();

    this.#backgroundWorker = new ProdBackgroundWorker("worker.js", {
      projectDir: this.projectDir,
      env: {
        TRIGGER_API_URL: this.apiUrl,
        TRIGGER_SECRET_KEY: this.apiKey,
        OTEL_EXPORTER_OTLP_ENDPOINT:
          process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
      },
      contentHash: this.contentHash,
    });
    this.#backgroundWorker.onTaskHeartbeat.attach((attemptFriendlyId) => {
      this.#coordinatorSocket.send("TASK_HEARTBEAT", { attemptFriendlyId });
    });
    this.#backgroundWorker.onWaitForBatch.attach((message) => {
      this.#coordinatorSocket.send("WAIT_FOR_BATCH", message);
    });
    this.#backgroundWorker.onWaitForDuration.attach(async (message) => {
      const { success } = await this.#coordinatorSocket.sendWithAck("WAIT_FOR_DURATION", message);
      logger.log("WAIT_FOR_DURATION", { success });
    });
    this.#backgroundWorker.onWaitForTask.attach((message) => {
      this.#coordinatorSocket.send("WAIT_FOR_TASK", message);
    });

    this.#httpPort = port;
    this.#httpServer = this.#createHttpServer();
  }

  #createCoordinatorSocket() {
    logger.log("connecting to coordinator", {
      host: COORDINATOR_HOST,
      port: COORDINATOR_PORT,
      deploymentId: this.deploymentId,
      podName: POD_NAME,
      machineName: MACHINE_NAME,
      contentHash: this.contentHash,
      projectRef: this.projectRef,
      attemptId: this.attemptId,
      envId: this.envId,
    });

    const coordinatorConnection = new ZodSocketConnection({
      namespace: "prod-worker",
      host: COORDINATOR_HOST,
      port: COORDINATOR_PORT,
      clientMessages: ProdWorkerToCoordinatorMessages,
      serverMessages: CoordinatorToProdWorkerMessages,
      extraHeaders: {
        "x-machine-name": MACHINE_NAME,
        "x-pod-name": POD_NAME,
        "x-trigger-content-hash": this.contentHash,
        "x-trigger-project-ref": this.projectRef,
        "x-trigger-attempt-id": this.attemptId,
        "x-trigger-env-id": this.envId,
        "x-trigger-deployment-id": this.deploymentId,
      },
      handlers: {
        RESUME: async (message) => {
          for (let i = 0; i < message.completions.length; i++) {
            const completion = message.completions[i];
            const execution = message.executions[i];

            if (!completion || !execution) continue;

            this.#backgroundWorker.taskRunCompletedNotification(completion, execution);
          }
        },
        EXECUTE_TASK_RUN: async (message) => {
          if (this.executing || this.completed) {
            return {
              success: false,
            };
          }

          this.executing = true;
          const completion = await this.#backgroundWorker.executeTaskRun(message.executionPayload);

          logger.log("completed", completion);

          this.completed = true;
          this.executing = false;

          setTimeout(() => {
            process.exit(0);
          }, 2000);

          // TODO: replace ack with emit
          return {
            success: true,
            completion,
          };
        },
      },
      onConnection: async (socket, handler, sender, logger) => {
        if (process.env.INDEX_TASKS === "true") {
          try {
            const taskResources = await this.#initializeWorker();

            const { success } = await socket.emitWithAck("INDEX_TASKS", {
              version: "v1",
              deploymentId: this.deploymentId,
              ...taskResources,
            });

            if (success) {
              logger("indexing done, shutting down..");
              process.exit(0);
            } else {
              logger("indexing failure, shutting down..");
              process.exit(1);
            }
          } catch (e) {
            if (e instanceof UncaughtExceptionError) {
              logger("uncaught exception", e.originalError.message);

              socket.emit("INDEXING_FAILED", {
                version: "v1",
                deploymentId: this.deploymentId,
                error: {
                  name: e.originalError.name,
                  message: e.originalError.message,
                  stack: e.originalError.stack,
                },
              });
            } else if (e instanceof Error) {
              logger("error", e.message);

              socket.emit("INDEXING_FAILED", {
                version: "v1",
                deploymentId: this.deploymentId,
                error: {
                  name: e.name,
                  message: e.message,
                  stack: e.stack,
                },
              });
            } else if (typeof e === "string") {
              logger("string error", e);

              socket.emit("INDEXING_FAILED", {
                version: "v1",
                deploymentId: this.deploymentId,
                error: {
                  name: "Error",
                  message: e,
                },
              });
            } else {
              logger("unknown error", e);

              socket.emit("INDEXING_FAILED", {
                version: "v1",
                deploymentId: this.deploymentId,
                error: {
                  name: "Error",
                  message: "Unknown error",
                },
              });
            }

            setTimeout(() => {
              process.exit(1);
            }, 200);
          }
        } else {
          socket.emit("READY_FOR_EXECUTION", {
            version: "v1",
            attemptId: this.attemptId,
          });
        }
      },
    });

    return coordinatorConnection;
  }

  #createHttpServer() {
    const httpServer = createServer(async (req, res) => {
      logger.log(`[${req.method}]`, req.url);

      const reply = new HttpReply(res);

      switch (req.url) {
        case "/complete":
          setTimeout(() => process.exit(0), 1000);
          return reply.text("ok");

        case "/date":
          const date = new Date();
          return reply.text(date.toString());

        case "/fail":
          setTimeout(() => process.exit(1), 1000);
          return reply.text("ok");

        case "/health":
          return reply.text("ok");

        case "/whoami":
          return reply.text(this.contentHash);

        case "/wait":
          const { success } = await this.#coordinatorSocket.sendWithAck("WAIT_FOR_DURATION", {
            version: "v1",
            ms: 60_000,
          });
          logger.log("WAIT_FOR_DURATION", { success });
          // this is required when C/Ring established connections
          this.#coordinatorSocket.close();
          return reply.text("sent WAIT");

        case "/connect":
          this.#coordinatorSocket.connect();
          return reply.empty();

        case "/close":
          this.#coordinatorSocket.sendWithAck("LOG", {
            version: "v1",
            text: "close without delay",
          });
          this.#coordinatorSocket.close();
          return reply.empty();

        case "/close-delay":
          this.#coordinatorSocket.sendWithAck("LOG", {
            version: "v1",
            text: "close with delay",
          });
          setTimeout(() => {
            this.#coordinatorSocket.close();
          }, 200);
          return reply.empty();

        case "/log":
          this.#coordinatorSocket.sendWithAck("LOG", {
            version: "v1",
            text: await getTextBody(req),
          });
          return reply.empty();

        case "/preStop":
          logger.log("should do preStop stuff, e.g. checkpoint and graceful shutdown");
          return reply.text("got preStop request");

        case "/ready":
          this.#coordinatorSocket.send("READY_FOR_EXECUTION", {
            version: "v1",
            attemptId: this.attemptId,
          });
          return reply.empty();

        default:
          return reply.empty(404);
      }
    });

    httpServer.on("clientError", (err, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    httpServer.on("listening", () => {
      logger.log("http server listening on port", this.#httpPort);
    });

    httpServer.on("error", (error) => {
      // @ts-expect-error
      if (error.code != "EADDRINUSE") {
        return;
      }

      logger.error(`port ${this.#httpPort} already in use, retrying with random port..`);

      this.#httpPort = getRandomPortNumber();

      setTimeout(() => {
        this.start();
      }, 100);
    });

    return httpServer;
  }

  async #initializeWorker() {
    // Make an API call for the env vars
    // Don't use ApiClient again
    // Pass those into this.#backgroundWorker.initialize()
    const envVars = await this.#fetchEnvironmentVariables();

    await this.#backgroundWorker.initialize({ env: envVars });

    let packageVersion: string | undefined;

    const taskResources: Array<TaskResource> = [];

    if (!this.#backgroundWorker.tasks) {
      throw new Error(`Background Worker started without tasks`);
    }

    for (const task of this.#backgroundWorker.tasks) {
      taskResources.push({
        id: task.id,
        filePath: task.filePath,
        exportName: task.exportName,
      });

      packageVersion = task.packageVersion;
    }

    if (!packageVersion) {
      throw new Error(`Background Worker started without package version`);
    }

    return {
      packageVersion,
      tasks: taskResources,
    };
  }

  async #fetchEnvironmentVariables(): Promise<Record<string, string>> {
    const response = await fetch(`${this.apiUrl}/api/v1/projects/${this.projectRef}/envvars`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      return {};
    }

    const data = await response.json();

    return data?.variables ?? {};
  }

  start() {
    this.#httpServer.listen(this.#httpPort, this.host);
  }
}

const prodWorker = new ProdWorker(HTTP_SERVER_PORT);
prodWorker.start();
