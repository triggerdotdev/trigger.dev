import { createServer } from "node:http";
import { $ } from "execa";
import { nanoid } from "nanoid";
import { Server } from "socket.io";
import {
  CoordinatorToPlatformMessages,
  CoordinatorToProdWorkerMessages,
  PlatformToCoordinatorMessages,
  ProdWorkerSocketData,
  ProdWorkerToCoordinatorMessages,
  ZodNamespace,
  ZodSocketConnection,
} from "@trigger.dev/core/v3";
import { HttpReply, getTextBody, SimpleLogger } from "@trigger.dev/core-apps";

import { collectDefaultMetrics, register, Gauge } from "prom-client";
collectDefaultMetrics();

const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || 8020);
const NODE_NAME = process.env.NODE_NAME || "coordinator";
const REGISTRY_HOST = process.env.REGISTRY_HOST || "localhost:5000";
const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH || "/checkpoints";
const REGISTRY_TLS_VERIFY = process.env.REGISTRY_TLS_VERIFY === "false" ? "false" : "true";

const PLATFORM_ENABLED = ["1", "true"].includes(process.env.PLATFORM_ENABLED ?? "true");
const PLATFORM_HOST = process.env.PLATFORM_HOST || "127.0.0.1";
const PLATFORM_WS_PORT = process.env.PLATFORM_WS_PORT || 3030;
const PLATFORM_SECRET = process.env.PLATFORM_SECRET || "coordinator-secret";

const logger = new SimpleLogger(`[${NODE_NAME}]`);

type CheckpointerInitializeReturn = {
  canCheckpoint: boolean;
  willSimulate: boolean;
};

type CheckpointAndPushOptions = {
  runId: string;
  leaveRunning?: boolean;
  projectRef: string;
  deploymentVersion: string;
};

type CheckpointData = {
  location: string;
  docker: boolean;
};

class Checkpointer {
  #initialized = false;
  #canCheckpoint = false;
  #dockerMode = !process.env.KUBERNETES_PORT;

  #logger = new SimpleLogger("[checkptr]");
  #abortControllers = new Map<string, AbortController>();

  constructor(private opts = { forceSimulate: false }) {}

  async initialize(): Promise<CheckpointerInitializeReturn> {
    if (this.#initialized) {
      return this.#getInitializeReturn();
    }

    this.#logger.log(`${this.#dockerMode ? "Docker" : "Kubernetes"} mode`);

    if (this.#dockerMode) {
      try {
        await $`criu --version`;
      } catch (error) {
        this.#logger.error("No checkpoint support: Missing CRIU binary");
        this.#logger.error("Will simulate instead");
        this.#canCheckpoint = false;
        this.#initialized = true;

        return this.#getInitializeReturn();
      }

      try {
        await $`docker checkpoint`;
      } catch (error) {
        this.#logger.error(
          "No checkpoint support: Docker needs to have experimental features enabled"
        );
        this.#logger.error("Will simulate instead");
        this.#canCheckpoint = false;
        this.#initialized = true;

        return this.#getInitializeReturn();
      }
    } else {
      try {
        await $`buildah login --get-login ${REGISTRY_HOST}`;
      } catch (error) {
        this.#logger.error(`No checkpoint support: Not logged in to registry ${REGISTRY_HOST}`);
        this.#canCheckpoint = false;
        this.#initialized = true;

        return this.#getInitializeReturn();
      }
    }

    this.#logger.log(
      `Full checkpoint support${
        this.#dockerMode && this.opts.forceSimulate ? " with forced simulation enabled." : "!"
      }`
    );

    this.#initialized = true;
    this.#canCheckpoint = true;

    return this.#getInitializeReturn();
  }

  #getInitializeReturn(): CheckpointerInitializeReturn {
    return {
      canCheckpoint: this.#canCheckpoint,
      willSimulate: this.#dockerMode && (!this.#canCheckpoint || this.opts.forceSimulate),
    };
  }

  #getImageRef(projectRef: string, deploymentVersion: string, shortCode: string) {
    return `${REGISTRY_HOST}/trigger/${projectRef}:${deploymentVersion}.prod-${shortCode}`;
  }

  #getExportLocation(projectRef: string, deploymentVersion: string, shortCode: string) {
    const basename = `${projectRef}-${deploymentVersion}-${shortCode}`;

    if (this.#dockerMode) {
      return basename;
    } else {
      return `${CHECKPOINT_PATH}/${basename}.tar`;
    }
  }

  async checkpointAndPush(opts: CheckpointAndPushOptions): Promise<CheckpointData | undefined> {
    const start = performance.now();
    logger.log(`checkpointAndPush() start`, { start, opts });

    const result = await this.#checkpointAndPush(opts);

    const end = performance.now();
    logger.log(`checkpointAndPush() end`, {
      start,
      end,
      diff: end - start,
      opts,
      success: !!result,
    });

    return result;
  }

  isCheckpointing(runId: string) {
    return this.#abortControllers.has(runId);
  }

  cancelCheckpoint(runId: string) {
    const controller = this.#abortControllers.get(runId);

    if (!controller) {
      logger.debug("Nothing to cancel", { runId });
      return;
    }

    controller.abort("cancelCheckpointing()");
    this.#abortControllers.delete(runId);
  }

  async #checkpointAndPush(opts: CheckpointAndPushOptions): Promise<CheckpointData | undefined> {
    await this.initialize();

    if (!this.#dockerMode && !this.#canCheckpoint) {
      this.#logger.error("No checkpoint support. Simulation requires docker.");
      return;
    }

    if (this.#abortControllers.has(opts.runId)) {
      logger.error("Checkpoint procedure already in progress", { opts });
      return;
    }

    const controller = new AbortController();
    this.#abortControllers.set(opts.runId, controller);

    const $$ = $({ signal: controller.signal });

    try {
      const shortCode = nanoid(8);
      const imageRef = this.#getImageRef(opts.projectRef, opts.deploymentVersion, shortCode);
      const exportLocation = this.#getExportLocation(
        opts.projectRef,
        opts.deploymentVersion,
        shortCode
      );

      this.#logger.log("Checkpointing:", { opts });

      const containterName = this.#getRunContainerName(opts.runId);

      // Create checkpoint (docker)
      if (this.#dockerMode) {
        try {
          if (this.opts.forceSimulate || !this.#canCheckpoint) {
            this.#logger.log("Simulating checkpoint");
            this.#logger.debug(await $$`docker pause ${containterName}`);
          } else {
            if (opts.leaveRunning) {
              this.#logger.debug(
                await $$`docker checkpoint create --leave-running ${containterName} ${exportLocation}`
              );
            } else {
              this.#logger.debug(
                await $$`docker checkpoint create ${containterName} ${exportLocation}`
              );
            }
          }
        } catch (error: any) {
          this.#logger.error(error.stderr);
          return;
        }

        this.#logger.log("checkpoint created:", {
          runId: opts.runId,
          location: exportLocation,
        });

        return {
          location: exportLocation,
          docker: true,
        };
      }

      // Create checkpoint (CRI)
      if (!this.#canCheckpoint) {
        throw new Error("No checkpoint support in kubernetes mode.");
      }

      const containerId = this.#logger.debug(
        // @ts-expect-error
        await $$`crictl ps`
          .pipeStdout($$({ stdin: "pipe" })`grep ${containterName}`)
          .pipeStdout($$({ stdin: "pipe" })`cut -f1 ${"-d "}`)
      );

      if (!containerId.stdout) {
        throw new Error("could not find container id");
      }

      this.#logger.debug(await $$`crictl checkpoint --export=${exportLocation} ${containerId}`);

      // Create image from checkpoint
      const container = this.#logger.debug(await $$`buildah from scratch`);
      this.#logger.debug(await $$`buildah add ${container} ${exportLocation} /`);
      this.#logger.debug(
        await $$`buildah config --annotation=io.kubernetes.cri-o.annotations.checkpoint.name=counter ${container}`
      );
      this.#logger.debug(await $$`buildah commit ${container} ${imageRef}`);
      this.#logger.debug(await $$`buildah rm ${container}`);

      // Push checkpoint image
      this.#logger.debug(await $$`buildah push --tls-verify=${REGISTRY_TLS_VERIFY} ${imageRef}`);

      this.#logger.log("Checkpointed and pushed image to:", { location: imageRef });

      try {
        await $$`rm ${exportLocation}`;
        this.#logger.log("Deleted checkpoint archive", { exportLocation });

        // Disabled for now as this will increase restore time by having to pull the image again
        // await $`buildah rmi ${imageRef}`;
        // this.#logger.log("Deleted checkpoint image", { imageRef });
      } catch (error) {
        this.#logger.error("Failed during checkpoint cleanup", { exportLocation });
        this.#logger.debug(error);
      }

      return {
        location: imageRef,
        docker: false,
      };
    } catch (error) {
      this.#logger.error("checkpoint failed", { options: opts, error });
      return;
    } finally {
      this.#abortControllers.delete(opts.runId);
    }
  }

  #getRunContainerName(suffix: string) {
    return `task-run-${suffix}`;
  }
}

class TaskCoordinator {
  #httpServer: ReturnType<typeof createServer>;
  #checkpointer = new Checkpointer({ forceSimulate: true });

  #prodWorkerNamespace: ZodNamespace<
    typeof ProdWorkerToCoordinatorMessages,
    typeof CoordinatorToProdWorkerMessages,
    typeof ProdWorkerSocketData
  >;
  #platformSocket?: ZodSocketConnection<
    typeof CoordinatorToPlatformMessages,
    typeof PlatformToCoordinatorMessages
  >;

  #checkpointableTasks = new Map<
    string,
    { resolve: (value: void) => void; reject: (err?: any) => void }
  >();

  constructor(
    private port: number,
    private host = "0.0.0.0"
  ) {
    this.#httpServer = this.#createHttpServer();
    this.#checkpointer.initialize();

    const io = new Server(this.#httpServer);
    this.#prodWorkerNamespace = this.#createProdWorkerNamespace(io);

    this.#platformSocket = this.#createPlatformSocket();

    const connectedTasksTotal = new Gauge({
      name: "daemon_connected_tasks_total", // don't change this without updating dashboard config
      help: "The number of tasks currently connected.",
      collect: () => {
        connectedTasksTotal.set(this.#prodWorkerNamespace.namespace.sockets.size);
      },
    });
    register.registerMetric(connectedTasksTotal);
  }

  #createPlatformSocket() {
    if (!PLATFORM_ENABLED) {
      console.log("INFO: platform connection disabled");
      return;
    }

    const platformConnection = new ZodSocketConnection({
      namespace: "coordinator",
      host: PLATFORM_HOST,
      port: Number(PLATFORM_WS_PORT),
      clientMessages: CoordinatorToPlatformMessages,
      serverMessages: PlatformToCoordinatorMessages,
      authToken: PLATFORM_SECRET,
      handlers: {
        RESUME: async (message) => {
          const taskSocket = await this.#getAttemptSocket(message.attemptId);

          if (!taskSocket) {
            logger.log("Socket for attempt not found", { attemptId: message.attemptId });
            return;
          }

          taskSocket.emit("RESUME", message);
        },
        RESUME_AFTER_DURATION: async (message) => {
          const taskSocket = await this.#getAttemptSocket(message.attemptId);

          if (!taskSocket) {
            logger.log("Socket for attempt not found", { attemptId: message.attemptId });
            return;
          }

          taskSocket.emit("RESUME_AFTER_DURATION", message);
        },
        REQUEST_ATTEMPT_CANCELLATION: async (message) => {
          const taskSocket = await this.#getAttemptSocket(message.attemptId);

          if (!taskSocket) {
            logger.log("Socket for attempt not found", { attemptId: message.attemptId });
            return;
          }

          taskSocket.emit("REQUEST_ATTEMPT_CANCELLATION", message);
        },
      },
    });

    return platformConnection;
  }

  async #getAttemptSocket(attemptId: string) {
    const sockets = await this.#prodWorkerNamespace.fetchSockets();

    for (const socket of sockets) {
      if (socket.data.attemptId === attemptId) {
        return socket;
      }
    }
  }

  #createProdWorkerNamespace(io: Server) {
    const provider = new ZodNamespace({
      io,
      name: "prod-worker",
      clientMessages: ProdWorkerToCoordinatorMessages,
      serverMessages: CoordinatorToProdWorkerMessages,
      socketData: ProdWorkerSocketData,
      postAuth: async (socket, next, logger) => {
        function setSocketDataFromHeader(dataKey: keyof typeof socket.data, headerName: string) {
          const value = socket.handshake.headers[headerName];
          if (!value) {
            logger.error("missing required header", { headerName });
            throw new Error("missing header");
          }
          0;
          socket.data[dataKey] = Array.isArray(value) ? value[0] : value;
        }

        try {
          setSocketDataFromHeader("podName", "x-pod-name");
          setSocketDataFromHeader("contentHash", "x-trigger-content-hash");
          setSocketDataFromHeader("projectRef", "x-trigger-project-ref");
          setSocketDataFromHeader("runId", "x-trigger-run-id");
          setSocketDataFromHeader("attemptId", "x-trigger-attempt-id");
          setSocketDataFromHeader("envId", "x-trigger-env-id");
          setSocketDataFromHeader("deploymentId", "x-trigger-deployment-id");
          setSocketDataFromHeader("deploymentVersion", "x-trigger-deployment-version");
        } catch (error) {
          logger.error("setSocketDataFromHeader error", { error });
          socket.disconnect(true);
          return;
        }

        logger.debug("success", socket.data);

        next();
      },
      onConnection: async (socket, handler, sender) => {
        const logger = new SimpleLogger(`[prod-worker][${socket.id}]`);

        this.#platformSocket?.send("LOG", {
          metadata: {
            projectRef: socket.data.projectRef,
            attemptId: socket.data.attemptId,
          },
          text: "connected",
        });

        socket.on("LOG", (message, callback) => {
          logger.log("[LOG]", message.text);

          callback();

          this.#platformSocket?.send("LOG", {
            version: "v1",
            metadata: { attemptId: socket.data.attemptId },
            text: message.text,
          });
        });

        socket.on("READY_FOR_EXECUTION", async (message) => {
          logger.log("[READY_FOR_EXECUTION]", message);

          try {
            const executionAck = await this.#platformSocket?.sendWithAck(
              "READY_FOR_EXECUTION",
              message
            );

            if (!executionAck) {
              logger.error("no execution ack", { attemptId: socket.data.attemptId });

              socket.emit("REQUEST_EXIT", {
                version: "v1",
              });

              return;
            }

            if (!executionAck.success) {
              logger.error("failed to get execution payload", { attemptId: socket.data.attemptId });

              socket.emit("REQUEST_EXIT", {
                version: "v1",
              });

              return;
            }

            socket.emit("EXECUTE_TASK_RUN", {
              version: "v1",
              executionPayload: executionAck.payload,
            });
          } catch (error) {
            logger.error("Error", { error });
          }
        });

        socket.on("READY_FOR_RESUME", async (message) => {
          logger.log("[READY_FOR_RESUME]", message);
          this.#platformSocket?.send("READY_FOR_RESUME", message);
        });

        socket.on("TASK_RUN_COMPLETED", async ({ completion, execution }, callback) => {
          logger.log("completed task", { completionId: completion.id });

          type CheckpointData = {
            docker: boolean;
            location: string;
          };

          const confirmCompletion = ({
            didCheckpoint,
            shouldExit,
            checkpoint,
          }: {
            didCheckpoint: boolean;
            shouldExit: boolean;
            checkpoint?: CheckpointData;
          }) => {
            this.#platformSocket?.send("TASK_RUN_COMPLETED", {
              version: "v1",
              execution,
              completion,
              checkpoint,
            });
            callback({ didCheckpoint, shouldExit });
          };

          if (completion.ok) {
            confirmCompletion({ didCheckpoint: false, shouldExit: true });
            return;
          }

          if (
            completion.error.type === "INTERNAL_ERROR" &&
            completion.error.code === "TASK_RUN_CANCELLED"
          ) {
            confirmCompletion({ didCheckpoint: false, shouldExit: true });
            return;
          }

          if (completion.retry === undefined) {
            confirmCompletion({ didCheckpoint: false, shouldExit: true });
            return;
          }

          const { canCheckpoint, willSimulate } = await this.#checkpointer.initialize();

          const willCheckpointAndRestore = canCheckpoint || willSimulate;

          if (!willCheckpointAndRestore) {
            confirmCompletion({ didCheckpoint: false, shouldExit: false });
            return;
          }

          const checkpoint = await this.#checkpointer.checkpointAndPush({
            runId: socket.data.runId,
            projectRef: socket.data.projectRef,
            deploymentVersion: socket.data.deploymentVersion,
          });

          if (!checkpoint) {
            logger.error("Failed to checkpoint", { runId: socket.data.runId });
            confirmCompletion({ didCheckpoint: false, shouldExit: false });
            return;
          }

          confirmCompletion({ didCheckpoint: true, shouldExit: false, checkpoint });

          if (!checkpoint.docker) {
            socket.emit("REQUEST_EXIT", {
              version: "v1",
            });
          }
        });

        socket.on("READY_FOR_CHECKPOINT", async (message) => {
          logger.log("[READY_FOR_CHECKPOINT]", message);

          const checkpointable = this.#checkpointableTasks.get(socket.data.runId);

          if (!checkpointable) {
            logger.error("No checkpoint scheduled", { runId: socket.data.runId });
            return;
          }

          checkpointable.resolve();
        });

        socket.on("CANCEL_CHECKPOINT", async (message) => {
          logger.log("[CANCEL_CHECKPOINT]", message);

          const checkpointWait = this.#checkpointableTasks.get(socket.data.runId);

          if (checkpointWait) {
            // Stop waiting for task to reach checkpointable state
            checkpointWait.reject("Checkpoint cancelled");
          }

          // Cancel checkpointing procedure
          this.#checkpointer.cancelCheckpoint(socket.data.runId);
        });

        socket.on("WAIT_FOR_DURATION", async (message, callback) => {
          logger.log("[WAIT_FOR_DURATION]", message);

          if (this.#checkpointableTasks.has(socket.data.runId)) {
            logger.error("Checkpoint already in progress", { runId: socket.data.runId });
            callback({ willCheckpointAndRestore: false });
            return;
          }

          const { canCheckpoint, willSimulate } = await this.#checkpointer.initialize();

          const willCheckpointAndRestore = canCheckpoint || willSimulate;

          callback({ willCheckpointAndRestore });

          if (!willCheckpointAndRestore) {
            return;
          }

          const isCheckpointable = new Promise((resolve, reject) => {
            // We set a reasonable timeout to prevent waiting forever
            setTimeout(reject, 10_000);

            this.#checkpointableTasks.set(socket.data.runId, { resolve, reject });
          });

          try {
            await isCheckpointable;
          } catch (error) {
            logger.error("Error while waiting for checkpointable state", { error });
            // TODO: We may want to cancel the task as it's unlikely to recover
            return;
          } finally {
            this.#checkpointableTasks.delete(socket.data.runId);
          }

          const checkpoint = await this.#checkpointer.checkpointAndPush({
            runId: socket.data.runId,
            projectRef: socket.data.projectRef,
            deploymentVersion: socket.data.deploymentVersion,
          });

          if (!checkpoint) {
            // The task container will keep running until the wait duration has elapsed
            logger.error("Failed to checkpoint", { runId: socket.data.runId });
            return;
          }

          if (!checkpoint.docker) {
            socket.emit("REQUEST_EXIT", {
              version: "v1",
            });
          }

          this.#platformSocket?.send("CHECKPOINT_CREATED", {
            version: "v1",
            attemptFriendlyId: message.attemptFriendlyId,
            docker: checkpoint.docker,
            location: checkpoint.location,
            reason: {
              type: "WAIT_FOR_DURATION",
              ms: message.ms,
              now: message.now,
            },
          });
        });

        socket.on("WAIT_FOR_TASK", async (message, callback) => {
          logger.log("[WAIT_FOR_TASK]", message);

          const { canCheckpoint, willSimulate } = await this.#checkpointer.initialize();

          const willCheckpointAndRestore = canCheckpoint || willSimulate;

          callback({ willCheckpointAndRestore });

          if (!willCheckpointAndRestore) {
            return;
          }

          const checkpoint = await this.#checkpointer.checkpointAndPush({
            runId: socket.data.runId,
            projectRef: socket.data.projectRef,
            deploymentVersion: socket.data.deploymentVersion,
          });

          if (!checkpoint) {
            logger.error("Failed to checkpoint", { runId: socket.data.runId });
            return;
          }

          if (!checkpoint.docker) {
            socket.emit("REQUEST_EXIT", {
              version: "v1",
            });
          }

          this.#platformSocket?.send("CHECKPOINT_CREATED", {
            version: "v1",
            attemptFriendlyId: message.attemptFriendlyId,
            docker: checkpoint.docker,
            location: checkpoint.location,
            reason: {
              type: "WAIT_FOR_TASK",
              id: message.id,
            },
          });
        });

        socket.on("WAIT_FOR_BATCH", async (message, callback) => {
          logger.log("[WAIT_FOR_BATCH]", message);

          const { canCheckpoint, willSimulate } = await this.#checkpointer.initialize();

          const willCheckpointAndRestore = canCheckpoint || willSimulate;

          callback({ willCheckpointAndRestore });

          if (!willCheckpointAndRestore) {
            return;
          }

          const checkpoint = await this.#checkpointer.checkpointAndPush({
            runId: socket.data.runId,
            projectRef: socket.data.projectRef,
            deploymentVersion: socket.data.deploymentVersion,
          });

          if (!checkpoint) {
            logger.error("Failed to checkpoint", { runId: socket.data.runId });
            return;
          }

          if (!checkpoint.docker) {
            socket.emit("REQUEST_EXIT", {
              version: "v1",
            });
          }

          this.#platformSocket?.send("CHECKPOINT_CREATED", {
            version: "v1",
            attemptFriendlyId: message.attemptFriendlyId,
            docker: checkpoint.docker,
            location: checkpoint.location,
            reason: {
              type: "WAIT_FOR_BATCH",
              id: message.id,
            },
          });
        });

        socket.on("INDEX_TASKS", async (message, callback) => {
          logger.log("[INDEX_TASKS]", message);

          const workerAck = await this.#platformSocket?.sendWithAck("CREATE_WORKER", {
            version: "v1",
            projectRef: socket.data.projectRef,
            envId: socket.data.envId,
            deploymentId: message.deploymentId,
            metadata: {
              contentHash: socket.data.contentHash,
              packageVersion: message.packageVersion,
              tasks: message.tasks,
            },
          });

          if (!workerAck) {
            logger.debug("no worker ack while indexing", message);
          }

          callback({ success: !!workerAck?.success });
        });

        socket.on("INDEXING_FAILED", async (message) => {
          logger.log("[INDEXING_FAILED]", message);

          this.#platformSocket?.send("INDEXING_FAILED", {
            version: "v1",
            deploymentId: message.deploymentId,
            error: message.error,
          });
        });
      },
      onDisconnect: async (socket, handler, sender, logger) => {
        this.#platformSocket?.send("LOG", {
          metadata: {
            projectRef: socket.data.projectRef,
            attemptId: socket.data.attemptId,
          },
          text: "disconnect",
        });
      },
      handlers: {
        TASK_HEARTBEAT: async (message) => {
          this.#platformSocket?.send("TASK_HEARTBEAT", message);
        },
      },
    });

    return provider;
  }

  #createHttpServer() {
    const httpServer = createServer(async (req, res) => {
      logger.log(`[${req.method}]`, req.url);

      const reply = new HttpReply(res);

      switch (req.url) {
        case "/health": {
          return reply.text("ok");
        }
        case "/metrics": {
          return reply.text(await register.metrics(), 200, register.contentType);
        }
        case "/whoami": {
          return reply.text(NODE_NAME);
        }
        case "/checkpoint": {
          const body = await getTextBody(req);
          // await this.#checkpointer.checkpointAndPush(body);
          return reply.text(`sent restore request: ${body}`);
        }
        default: {
          return reply.empty(404);
        }
      }
    });

    httpServer.on("clientError", (err, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    httpServer.on("listening", () => {
      logger.log("server listening on port", HTTP_SERVER_PORT);
    });

    return httpServer;
  }

  listen() {
    this.#httpServer.listen(this.port, this.host);
  }
}

const coordinator = new TaskCoordinator(HTTP_SERVER_PORT);
coordinator.listen();
