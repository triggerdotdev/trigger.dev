import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { $ } from "execa";
import { Namespace } from "socket.io";
import { Server } from "socket.io";
import { Socket, io } from "socket.io-client";
import { DefaultEventsMap } from "socket.io/dist/typed-events";
import {
  CoordinatorToPlatformEvents,
  CoordinatorToProdWorkerEvents,
  PlatformToCoordinatorEvents,
  ProdWorkerSocketData,
  ProdWorkerToCoordinatorEvents,
  CliApiClient,
} from "@trigger.dev/core/v3";
import { HttpReply, getTextBody, SimpleLogger, getRandomPortNumber } from "@trigger.dev/core-apps";

import { collectDefaultMetrics, register, Gauge } from "prom-client";
collectDefaultMetrics();

const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || 8020);
const NODE_NAME = process.env.NODE_NAME || "coordinator";
const REGISTRY_FQDN = process.env.REGISTRY_FQDN || "localhost:5000";
const REPO_NAME = process.env.REPO_NAME || "checkpoints";
const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH || "/checkpoints";
const REGISTRY_TLS_VERIFY = process.env.REGISTRY_TLS_VERIFY === "false" ? "false" : "true";

const PLATFORM_ENABLED = ["1", "true"].includes(process.env.PLATFORM_ENABLED ?? "true");
const PLATFORM_HOST = process.env.PLATFORM_HOST || "127.0.0.1";
const PLATFORM_WS_PORT = process.env.PLATFORM_WS_PORT || 3030;
const PLATFORM_SECRET = process.env.PLATFORM_SECRET || "coordinator-secret";

const logger = new SimpleLogger(`[${NODE_NAME}]`);

class Checkpointer {
  #initialized = false;
  #canCheckpoint = false;
  #dockerMode = true;

  #logger = new SimpleLogger("[checkptr]");

  async initialize() {
    if (this.#initialized) {
      return;
    }

    try {
      await $`criu --version`;
    } catch (error) {
      this.#logger.error("No checkpoint support: Missing CRIU binary");
      this.#canCheckpoint = false;
      this.#initialized = true;
      return;
    }

    if (this.#dockerMode) {
      try {
        await $`docker checkpoint`;
      } catch (error) {
        this.#logger.error(
          "No checkpoint support: Docker needs to have experimental features enabled"
        );
        this.#canCheckpoint = false;
        this.#initialized = true;
        return;
      }
    }

    this.#logger.log(
      `Full checkpoint support with docker ${this.#dockerMode ? "enabled" : "disabled"}`
    );

    this.#initialized = true;
    this.#canCheckpoint = true;
  }

  async checkpointAndPush(podName: string) {
    await this.initialize();

    if (!this.#canCheckpoint) {
      return;
    }

    try {
      const { path } = await this.#checkpointContainer(podName);
      const { tag } = await this.#buildImage(path, podName);
      const { destination } = await this.#pushImage(tag);

      if (this.#dockerMode) {
        this.#logger.log("checkpoint created:", { podName, path });
      } else {
        this.#logger.log("checkpointed and pushed image to:", destination);
      }

      return {
        path,
        tag,
        destination: this.#dockerMode ? path : destination,
        docker: this.#dockerMode,
      };
    } catch (error) {
      this.#logger.error("checkpoint failed", error);
      return;
    }
  }

  async #checkpointContainer(podName: string) {
    await this.initialize();

    if (!this.#canCheckpoint) {
      throw new Error("No checkpoint support");
    }

    if (this.#dockerMode) {
      this.#logger.log("Checkpointing:", podName);

      const path = randomUUID();

      try {
        this.#logger.debug(await $`docker checkpoint create --leave-running ${podName} ${path}`);
      } catch (error: any) {
        this.#logger.error(error.stderr);
      }

      return { path };
    }

    const containerId = this.#logger.debug(
      // @ts-expect-error
      await $`crictl ps`
        .pipeStdout($({ stdin: "pipe" })`grep ${podName}`)
        .pipeStdout($({ stdin: "pipe" })`cut -f1 ${"-d "}`)
    );

    if (!containerId.stdout) {
      throw new Error("could not find container id");
    }

    const exportPath = `${CHECKPOINT_PATH}/${podName}.tar`;

    this.#logger.debug(await $`crictl checkpoint --export=${exportPath} ${containerId}`);

    return {
      path: exportPath,
    };
  }

  async #buildImage(checkpointPath: string, tag: string) {
    await this.initialize();

    if (!this.#canCheckpoint) {
      throw new Error("No checkpoint support");
    }

    if (this.#dockerMode) {
      // Nothing to do here
      return { tag };
    }

    const container = this.#logger.debug(await $`buildah from scratch`);
    this.#logger.debug(await $`buildah add ${container} ${checkpointPath} /`);
    this.#logger.debug(
      await $`buildah config --annotation=io.kubernetes.cri-o.annotations.checkpoint.name=counter ${container}`
    );
    this.#logger.debug(await $`buildah commit ${container} ${REGISTRY_FQDN}/${REPO_NAME}:${tag}`);
    this.#logger.debug(await $`buildah rm ${container}`);

    return {
      tag,
    };
  }

  async #pushImage(tag: string) {
    await this.initialize();

    if (!this.#canCheckpoint) {
      throw new Error("No checkpoint support");
    }

    if (this.#dockerMode) {
      // Nothing to do here
      return { destination: "" };
    }

    const destination = `${REGISTRY_FQDN}/${REPO_NAME}:${tag}`;
    this.#logger.debug(await $`buildah push --tls-verify=${REGISTRY_TLS_VERIFY} ${destination}`);

    return {
      destination,
    };
  }
}

class TaskCoordinator {
  #httpServer: ReturnType<typeof createServer>;
  #checkpointer = new Checkpointer();

  #prodWorkerNamespace: Namespace<
    ProdWorkerToCoordinatorEvents,
    CoordinatorToProdWorkerEvents,
    DefaultEventsMap,
    ProdWorkerSocketData
  >;
  #platformSocket?: Socket<PlatformToCoordinatorEvents, CoordinatorToPlatformEvents>;

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
        connectedTasksTotal.set(this.#prodWorkerNamespace.sockets.size);
      },
    });
    register.registerMetric(connectedTasksTotal);
  }

  #createPlatformSocket() {
    if (!PLATFORM_ENABLED) {
      console.log("INFO: platform connection disabled");
      return;
    }

    const socket: Socket<PlatformToCoordinatorEvents, CoordinatorToPlatformEvents> = io(
      `ws://${PLATFORM_HOST}:${PLATFORM_WS_PORT}/coordinator`,
      {
        transports: ["websocket"],
        auth: {
          token: PLATFORM_SECRET,
        },
      }
    );

    const logger = new SimpleLogger(`[platform][${socket.id ?? "NO_ID"}]`);

    socket.on("connect", () => {
      logger.log("connect");
    });

    socket.on("connect_error", (err) => {
      logger.error(`connect_error: ${err.message}`);
    });

    socket.on("disconnect", () => {
      logger.log("disconnect");
    });

    socket.on("RESUME", async (message) => {
      logger.log("[RESUME]", message);

      const taskSocket = await this.#getAttemptSocket(message.attemptId);

      if (!taskSocket) {
        logger.log("Socket for attempt not found", { attemptId: message.attemptId });
        return;
      }

      taskSocket.emit("RESUME", message);
    });

    return socket;
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
    const namespace: Namespace<
      ProdWorkerToCoordinatorEvents,
      CoordinatorToProdWorkerEvents,
      DefaultEventsMap,
      ProdWorkerSocketData
    > = io.of("/prod-worker");

    namespace.on("connection", async (socket) => {
      const logger = new SimpleLogger(`[task][${socket.id}]`);

      this.#platformSocket?.emit("LOG", {
        version: "v1",
        taskId: socket.data.taskId,
        text: "connected",
      });

      logger.log("connected");

      socket.on("disconnect", (reason, description) => {
        logger.log("disconnect", { reason, description });

        this.#platformSocket?.emit("LOG", {
          version: "v1",
          taskId: socket.data.taskId,
          text: "disconnect",
        });
      });

      socket.on("error", (error) => {
        logger.error({ error });
      });

      socket.on("LOG", (message, callback) => {
        logger.log("[LOG]", message.text);

        callback();

        this.#platformSocket?.emit("LOG", {
          version: "v1",
          taskId: socket.data.taskId,
          text: message.text,
        });
      });

      socket.on("READY_FOR_EXECUTION", async (message) => {
        logger.log("[READY_FOR_EXECUTION]", message);

        this.#platformSocket?.emit("READY", {
          version: "v1",
          taskId: socket.data.taskId,
        });

        const executionAck = await this.#platformSocket?.emitWithAck("READY_FOR_EXECUTION", {
          version: "v1",
          attemptId: message.attemptId,
        });

        if (!executionAck) {
          logger.error("no execution ack", { attemptId: socket.data.attemptId });
          return;
        }

        if (!executionAck.success) {
          logger.error("execution unsuccessful", { attemptId: socket.data.attemptId });
          return;
        }

        // FIXME: shouldn't wait for completion here
        const completionAck = await socket.emitWithAck("EXECUTE_TASK_RUN", {
          version: "v1",
          payload: executionAck.payload,
        });

        logger.log("completed task", { completionId: completionAck.completion.id });

        this.#platformSocket?.emit("TASK_RUN_COMPLETED", {
          version: "v1",
          execution: executionAck.payload.execution,
          completion: completionAck.completion,
        });
      });

      socket.on("TASK_HEARTBEAT", (message) => {
        logger.log("[TASK_HEARTBEAT]", message);

        this.#platformSocket?.emit("TASK_HEARTBEAT", message);
      });

      socket.on("WAIT_FOR_BATCH", (message) => {
        logger.log("[WAIT_FOR_BATCH]", message);

        // this.#checkpointer.checkpointAndPush(socket.data.podName);
      });

      socket.on("WAIT_FOR_DURATION", async (message, callback) => {
        logger.log("[WAIT_FOR_DURATION]", message);

        const checkpoint = await this.#checkpointer.checkpointAndPush(socket.data.podName);

        if (!checkpoint) {
          logger.error("Failed to checkpoint", { podName: socket.data.podName });
          callback({ success: false });
          return;
        }

        this.#platformSocket?.emit("CHECKPOINT_CREATED", {
          version: "v1",
          attemptId: socket.data.attemptId,
          docker: checkpoint.docker,
          location: checkpoint.destination,
          reason: "WAIT_FOR_DURATION",
        });

        callback({ success: true });
      });

      socket.on("WAIT_FOR_TASK", (message) => {
        logger.log("[WAIT_FOR_TASK]", message);

        // this.#checkpointer.checkpointAndPush(socket.data.podName);
      });

      socket.on("INDEX_TASKS", async (message, callback) => {
        logger.log("[INDEX_TASKS]", message);

        const environmentClient = new CliApiClient(socket.data.apiUrl, socket.data.apiKey);

        // TODO: should do this via socket instead
        const createResponse = await environmentClient.createBackgroundWorker(
          socket.data.projectRef,
          {
            localOnly: false,
            metadata: {
              cliPackageVersion: socket.data.cliPackageVersion,
              contentHash: socket.data.contentHash,
              packageVersion: message.packageVersion,
              tasks: message.tasks,
            },
          }
        );

        logger.log("created background worker", createResponse);

        callback({ success: createResponse.success });
      });
    });

    // auth middleware
    namespace.use(async (socket, next) => {
      const logger = new SimpleLogger(`[task][${socket.id}][auth]`);

      const { auth } = socket.handshake;

      if (!("apiKey" in auth)) {
        logger.error("no api key");
        return socket.disconnect(true);
      }

      if (!("apiUrl" in auth)) {
        logger.error("no api url");
        return socket.disconnect(true);
      }

      // TODO: remove this section once worker creation via socket
      async function validateApiKey(apiKey: string, apiUrl: string) {
        return true;
      }
      if (!(await validateApiKey(auth.apiKey, auth.apiUrl))) {
        logger.error("invalid api key");
        return socket.disconnect(true);
      }
      socket.data.apiKey = auth.apiKey;
      socket.data.apiUrl = auth.apiUrl;

      function setSocketDataFromHeader(dataKey: keyof typeof socket.data, headerName: string) {
        const value = socket.handshake.headers[headerName];
        if (!value) {
          logger.error(`missing required header: ${headerName}`);
          throw new Error("missing header");
        }
        socket.data[dataKey] = Array.isArray(value) ? value[0] : value;
      }

      try {
        setSocketDataFromHeader("contentHash", "x-trigger-content-hash");
        setSocketDataFromHeader("cliPackageVersion", "x-trigger-cli-package-version");
        setSocketDataFromHeader("projectRef", "x-trigger-project-ref");
        setSocketDataFromHeader("attemptId", "x-trigger-attempt-id");
        setSocketDataFromHeader("podName", "x-pod-name");
      } catch (error) {
        return socket.disconnect(true);
      }

      logger.log("success", socket.data);

      next();
    });

    return namespace;
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
          await this.#checkpointer.checkpointAndPush(body);
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
