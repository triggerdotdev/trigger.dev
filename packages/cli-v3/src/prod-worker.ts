import {
  CoordinatorToProdWorkerEvents,
  ProdWorkerToCoordinatorEvents,
  TaskResource,
} from "@trigger.dev/core/v3";
import { HttpReply, getTextBody, SimpleLogger, getRandomPortNumber } from "@trigger.dev/core-apps";
import { createServer } from "node:http";
import { io, Socket } from "socket.io-client";
import { ProdBackgroundWorker } from "./prod/backgroundWorker";

const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || getRandomPortNumber());
const COORDINATOR_HOST = process.env.COORDINATOR_HOST || "127.0.0.1";
const COORDINATOR_PORT = Number(process.env.COORDINATOR_PORT || 50080);
const MACHINE_NAME = process.env.MACHINE_NAME || "local";
const POD_NAME = process.env.POD_NAME || "some-pod";
const SHORT_HASH = process.env.TRIGGER_CONTENT_HASH!.slice(0, 9);

const logger = new SimpleLogger(`[${MACHINE_NAME}][${SHORT_HASH}]`);

class ProdWorker {
  private apiUrl = process.env.TRIGGER_API_URL!;
  private apiKey = process.env.TRIGGER_API_KEY!;
  private contentHash = process.env.TRIGGER_CONTENT_HASH!;
  private projectDir = process.env.TRIGGER_PROJECT_DIR!;
  private projectRef = process.env.TRIGGER_PROJECT_REF!;
  private envId = process.env.TRIGGER_ENV_ID!;
  private cliPackageVersion = process.env.TRIGGER_CLI_PACKAGE_VERSION!;
  private attemptId = process.env.TRIGGER_ATTEMPT_ID || "index-only";

  private executing = false;
  private completed = false;

  #httpPort: number;
  #backgroundWorker: ProdBackgroundWorker;
  #httpServer: ReturnType<typeof createServer>;
  #coordinatorSocket: Socket<CoordinatorToProdWorkerEvents, ProdWorkerToCoordinatorEvents>;

  constructor(
    port: number,
    private host = "0.0.0.0"
  ) {
    this.#coordinatorSocket = this.#createCoordinatorSocket();

    this.#backgroundWorker = new ProdBackgroundWorker(this.#getWorkerEntryPath(this.contentHash), {
      projectDir: this.projectDir,
      env: {
        TRIGGER_API_URL: this.apiUrl,
        TRIGGER_API_KEY: this.apiKey,
      },
      contentHash: this.contentHash,
    });
    this.#backgroundWorker.onTaskHeartbeat.attach((attemptFriendlyId) => {
      this.#coordinatorSocket.emit("TASK_HEARTBEAT", { version: "v1", attemptFriendlyId });
    });
    this.#backgroundWorker.onWaitForBatch.attach((message) => {
      this.#coordinatorSocket.emit("WAIT_FOR_BATCH", { version: "v1", ...message });
    });
    this.#backgroundWorker.onWaitForDuration.attach((message) => {
      this.#coordinatorSocket.emit(
        "WAIT_FOR_DURATION",
        { version: "v1", ...message },
        ({ success }) => {
          logger.log("WAIT_FOR_DURATION", { success });
        }
      );
    });
    this.#backgroundWorker.onWaitForTask.attach((message) => {
      this.#coordinatorSocket.emit("WAIT_FOR_TASK", { version: "v1", ...message });
    });

    this.#httpPort = port;
    this.#httpServer = this.#createHttpServer();
  }

  #createCoordinatorSocket() {
    const socket: Socket<CoordinatorToProdWorkerEvents, ProdWorkerToCoordinatorEvents> = io(
      `ws://${COORDINATOR_HOST}:${COORDINATOR_PORT}/prod-worker`,
      {
        transports: ["websocket"],
        extraHeaders: {
          "x-machine-name": MACHINE_NAME,
          "x-pod-name": POD_NAME,
          "x-trigger-content-hash": this.contentHash,
          "x-trigger-cli-package-version": this.cliPackageVersion,
          "x-trigger-project-ref": this.projectRef,
          "x-trigger-attempt-id": this.attemptId,
          "x-trigger-env-id": this.envId,
        },
      }
    );

    const logger = new SimpleLogger(`[coordinator][${socket.id ?? "NO_ID"}]`);

    socket.on("connect_error", (err) => {
      logger.error(`connect_error: ${err.message}`);
    });

    socket.on("connect", async () => {
      logger.log("connect");

      if (process.env.INDEX_TASKS === "true") {
        const taskResources = await this.#initializeWorker();
        const { success } = await socket.emitWithAck("INDEX_TASKS", {
          version: "v1",
          ...taskResources,
        });
        if (success) {
          logger.log("indexing done, shutting down..");
          process.exit(0);
        } else {
          logger.log("indexing failure, shutting down..");
          process.exit(1);
        }
      } else {
        socket.emit("READY_FOR_EXECUTION", {
          version: "v1",
          attemptId: process.env.TRIGGER_ATTEMPT_ID!,
        });
      }
    });

    socket.on("disconnect", () => {
      logger.log("disconnect");
    });

    socket.on("RESUME", async (message) => {
      logger.log("[RESUME]", message);

      for (let i = 0; i < message.completions.length; i++) {
        const completion = message.completions[i];
        const execution = message.executions[i];

        if (!completion || !execution) continue;

        this.#backgroundWorker.taskRunCompletedNotification(completion, execution);
      }
    });

    socket.on("EXECUTE_TASK_RUN", async (message, callback) => {
      logger.log("[EXECUTE_TASK_RUN]", { attempt: message.payload.execution.attempt });

      if (this.executing || this.completed) {
        return;
      }

      this.executing = true;
      const completion = await this.#backgroundWorker.executeTaskRun(message.payload);

      logger.log("completed", completion);

      // TODO: replace ack with emit
      callback({ completion });

      this.completed = true;
      this.executing = false;

      setTimeout(() => {
        process.exit(0);
      }, 1000);
    });

    return socket;
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
          this.#coordinatorSocket.emit(
            "WAIT_FOR_DURATION",
            {
              version: "v1",
              ms: 60_000,
            },
            ({ success }) => {
              logger.log("WAIT_FOR_DURATION", { success });
            }
          );
          // this is required when C/Ring established connections
          this.#coordinatorSocket.close();
          return reply.text("sent WAIT");

        case "/connect":
          this.#coordinatorSocket.connect();
          return reply.empty();

        case "/close":
          this.#coordinatorSocket.emitWithAck("LOG", {
            version: "v1",
            text: "close without delay",
          });
          this.#coordinatorSocket.close();
          return reply.empty();

        case "/close-delay":
          this.#coordinatorSocket.emitWithAck("LOG", {
            version: "v1",
            text: "close with delay",
          });
          setTimeout(() => {
            this.#coordinatorSocket.close();
          }, 200);
          return reply.empty();

        case "/log":
          this.#coordinatorSocket.emitWithAck("LOG", {
            version: "v1",
            text: await getTextBody(req),
          });
          return reply.empty();

        case "/preStop":
          logger.log("should do preStop stuff, e.g. checkpoint and graceful shutdown");
          return reply.text("got preStop request");

        case "/ready":
          this.#coordinatorSocket.emit("READY_FOR_EXECUTION", {
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

  #getWorkerEntryPath(contentHash: string) {
    return `${contentHash}.mjs`;
  }

  async #initializeWorker() {
    await this.#backgroundWorker.initialize();

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

  start() {
    this.#httpServer.listen(this.#httpPort, this.host);
  }
}

const prodWorker = new ProdWorker(HTTP_SERVER_PORT);
prodWorker.start();
