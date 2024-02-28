import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { $ } from "execa";
import { Namespace } from "socket.io";
import { WebSocket } from "partysocket";
import { Server } from "socket.io";
import { Socket, io } from "socket.io-client";
import { DefaultEventsMap } from "socket.io/dist/typed-events";
import {
  CoordinatorToPlatformEvents,
  CoordinatorToProdWorkerEvents,
  CoordinatorToDemoTaskEvents,
  PlatformToCoordinatorEvents,
  ProdWorkerSocketData,
  ProdWorkerToCoordinatorEvents,
  DemoTaskSocketData,
  DemoTaskToCoordinatorEvents,
  CliApiClient,
} from "@trigger.dev/core/v3";
import { HttpReply, getTextBody } from "@trigger.dev/core-apps";

import { collectDefaultMetrics, register, Gauge } from "prom-client";
collectDefaultMetrics();

const DEBUG = ["1", "true"].includes(process.env.DEBUG ?? "") || false;
const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || 8000);
const NODE_NAME = process.env.NODE_NAME || "coordinator";
const REGISTRY_FQDN = process.env.REGISTRY_FQDN || "localhost:5000";
const REPO_NAME = process.env.REPO_NAME || "checkpoints";
const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH || "/checkpoints";
const REGISTRY_TLS_VERIFY = process.env.REGISTRY_TLS_VERIFY === "false" ? "false" : "true";

const PLATFORM_ENABLED = ["1", "true"].includes(process.env.PLATFORM_ENABLED ?? "") || false;
const PLATFORM_HOST = process.env.PLATFORM_HOST || "127.0.0.1";
const PLATFORM_WS_PORT = process.env.PLATFORM_WS_PORT || 5080;
const PLATFORM_SECRET = process.env.PLATFORM_SECRET || "coordinator-secret";

function createLogger(prefix: string) {
  return (...args: any[]) => console.log(prefix, ...args);
}

const debug = <TFirstArg>(firstArg: TFirstArg, ...otherArgs: any[]) => {
  if (!DEBUG) {
    return firstArg;
  }
  logger("DEBUG", firstArg, ...otherArgs);
  return firstArg;
};

const logger = createLogger(`[${NODE_NAME}]`);

class Checkpointer {
  #initialized = false;
  #canCheckpoint = false;
  #dockerMode = true;

  #logger = createLogger("[checkptr]");

  async initialize() {
    if (this.#initialized) {
      return;
    }

    try {
      await $`criu --version`;
    } catch (error) {
      this.#logger("No checkpoint support: Missing CRIU binary");
      this.#canCheckpoint = false;
      this.#initialized = true;
      return;
    }

    try {
      await $`docker checkpoint`;
    } catch (error) {
      this.#logger("No checkpoint support: Docker needs to have experimental features enabled");
      this.#canCheckpoint = false;
      this.#initialized = true;
      return;
    }

    this.#logger(
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

      this.#logger("checkpointed and pushed image to:", destination);

      return {
        path,
        tag,
        destination,
        docker: this.#dockerMode,
      };
    } catch (error) {
      this.#logger("checkpoint failed", error);
      return;
    }
  }

  async #checkpointContainer(podName: string) {
    await this.initialize();

    if (!this.#canCheckpoint) {
      throw new Error("No checkpoint support");
    }

    if (this.#dockerMode) {
      this.#logger("Checkpointing:", podName);

      const path = randomUUID();

      try {
        debug(await $`docker checkpoint create ${podName} ${path}`);
      } catch (error: any) {
        this.#logger(error.stderr);
      }

      return { path };
    }

    const containerId = debug(
      // @ts-expect-error
      await $`crictl ps`
        .pipeStdout($({ stdin: "pipe" })`grep ${podName}`)
        .pipeStdout($({ stdin: "pipe" })`cut -f1 ${"-d "}`)
    );

    if (!containerId.stdout) {
      throw new Error("could not find container id");
    }

    const exportPath = `${CHECKPOINT_PATH}/${podName}.tar`;

    debug(await $`crictl checkpoint --export=${exportPath} ${containerId}`);

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

    const container = debug(await $`buildah from scratch`);
    debug(await $`buildah add ${container} ${checkpointPath} /`);
    debug(
      await $`buildah config --annotation=io.kubernetes.cri-o.annotations.checkpoint.name=counter ${container}`
    );
    debug(await $`buildah commit ${container} ${REGISTRY_FQDN}/${REPO_NAME}:${tag}`);
    debug(await $`buildah rm ${container}`);

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
    debug(await $`buildah push --tls-verify=${REGISTRY_TLS_VERIFY} ${destination}`);

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
  #demoTaskNamespace: Namespace<
    DemoTaskToCoordinatorEvents,
    CoordinatorToDemoTaskEvents,
    DefaultEventsMap,
    DemoTaskSocketData
  >;
  #platformSocket?: Socket<PlatformToCoordinatorEvents, CoordinatorToPlatformEvents>;
  #platformWebSocket?: WebSocket;

  constructor(
    private port: number,
    private host = "0.0.0.0"
  ) {
    this.#httpServer = this.#createHttpServer();
    this.#checkpointer.initialize();

    const io = new Server(this.#httpServer, {
      // connectionStateRecovery: {
      //   maxDisconnectionDuration: 2 * 60 * 1000,
      //   skipMiddlewares: false,
      // },
    });

    this.#demoTaskNamespace = this.#createDemoTaskNamespace(io);
    this.#prodWorkerNamespace = this.#createProdWorkerNamespace(io);

    this.#platformSocket = this.#createPlatformSocket();

    const connectedTasksTotal = new Gauge({
      name: "daemon_connected_tasks_total",
      help: "The number of tasks currently connected via websocket.",
      collect: () => {
        connectedTasksTotal.set(this.#demoTaskNamespace.sockets.size);
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

    const logger = createLogger(`[platform][${socket.id ?? "NO_ID"}]`);

    socket.on("connect", () => {
      logger("connect");
    });

    socket.on("connect_error", (err) => {
      logger(`connect_error: ${err.message}`);
    });

    socket.on("disconnect", () => {
      logger("disconnect");
    });

    socket.on("INVOKE", async (message) => {
      logger("[INVOKE]", message);

      const taskSocket = await this.#getTaskSocket(message.taskId);

      if (!taskSocket) {
        return;
      }

      taskSocket.emit("INVOKE", {
        version: message.version,
        payload: message.payload,
        context: message.context,
      });
    });

    socket.on("RESUME", async (message) => {
      logger("[RESUME]", message);

      const taskSocket = await this.#getAttemptSocket(message.attemptId);

      if (!taskSocket) {
        logger("Socket for attempt not found", { attemptId: message.attemptId });
        return;
      }

      taskSocket.emit("RESUME", message);
    });

    socket.on("RESUME_WITH", async (message) => {
      logger("[RESUME_WITH]", message);

      const taskSocket = await this.#getTaskSocket(message.taskId);

      if (!taskSocket) {
        return;
      }

      taskSocket.emit("RESUME_WITH", {
        version: message.version,
        data: message.data,
      });
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

  async #getTaskSocket(taskId: string) {
    const sockets = await this.#demoTaskNamespace.fetchSockets();

    for (const socket of sockets) {
      if (socket.data.taskId === taskId) {
        return socket;
      }
    }
  }

  #createDemoTaskNamespace(io: Server) {
    const namespace: Namespace<
      DemoTaskToCoordinatorEvents,
      CoordinatorToDemoTaskEvents,
      DefaultEventsMap,
      DemoTaskSocketData
    > = io.of("/task");

    namespace.on("connection", async (socket) => {
      const logger = createLogger(`[task][${socket.id}]`);

      this.#platformSocket?.emit("LOG", {
        version: "v1",
        taskId: socket.data.taskId,
        text: "connected",
      });

      logger("connected");

      socket.on("disconnect", (reason, description) => {
        logger("disconnect", { reason, description });

        this.#platformSocket?.emit("LOG", {
          version: "v1",
          taskId: socket.data.taskId,
          text: "disconnect",
        });
      });

      socket.on("error", (error) => {
        logger({ error });
      });

      socket.on("LOG", (message) => {
        logger("[LOG]", message.text);
        this.#platformSocket?.emit("LOG", {
          version: "v1",
          taskId: socket.data.taskId,
          text: message.text,
        });
      });

      socket.on("READY", (message) => {
        logger("[READY]", message);
        this.#platformSocket?.emit("READY", {
          version: "v1",
          taskId: socket.data.taskId,
        });
      });

      socket.on("WAIT_FOR_DURATION", (message) => {
        logger("[WAIT_FOR_DURATION]", message.seconds);
        this.#checkpointer.checkpointAndPush(socket.data.taskId);
      });

      socket.on("WAIT_FOR_EVENT", (message) => {
        logger("[WAIT_FOR_EVENT]", message.name);
        this.#checkpointer.checkpointAndPush(socket.data.taskId);
      });
    });

    // auth middleware
    namespace.use((socket, next) => {
      const logger = createLogger(`[task][${socket.id}][auth]`);

      const { auth } = socket.handshake;

      if (!("token" in auth)) {
        logger("no token");
        return socket.disconnect(true);
      }

      if (auth.token !== "task-secret") {
        logger("invalid token");
        return socket.disconnect(true);
      }

      const taskId = socket.handshake.headers["x-task-id"];
      if (!taskId) {
        logger("no task id");
        return socket.disconnect(true);
      }
      socket.data.taskId = Array.isArray(taskId) ? taskId[0] : taskId;

      logger("success", { taskId: socket.data.taskId });

      next();
    });

    return namespace;
  }

  #createProdWorkerNamespace(io: Server) {
    const namespace: Namespace<
      ProdWorkerToCoordinatorEvents,
      CoordinatorToProdWorkerEvents,
      DefaultEventsMap,
      ProdWorkerSocketData
    > = io.of("/prod-worker");

    namespace.on("connection", async (socket) => {
      const logger = createLogger(`[task][${socket.id}]`);

      this.#platformSocket?.emit("LOG", {
        version: "v1",
        taskId: socket.data.taskId,
        text: "connected",
      });

      logger("connected");

      socket.on("disconnect", (reason, description) => {
        logger("disconnect", { reason, description });

        this.#platformSocket?.emit("LOG", {
          version: "v1",
          taskId: socket.data.taskId,
          text: "disconnect",
        });
      });

      socket.on("error", (error) => {
        logger({ error });
      });

      socket.on("LOG", (message, callback) => {
        logger("[LOG]", message.text);
        callback();
        this.#platformSocket?.emit("LOG", {
          version: "v1",
          taskId: socket.data.taskId,
          text: message.text,
        });
      });

      socket.on("READY_FOR_EXECUTION", async (message) => {
        socket.data.attemptId = message.attemptId;

        logger("[READY_FOR_EXECUTION]", message);
        this.#platformSocket?.emit("READY", {
          version: "v1",
          taskId: socket.data.taskId,
        });

        const executionAck = await this.#platformSocket?.emitWithAck("READY_FOR_EXECUTION", {
          version: "v1",
          attemptId: message.attemptId,
        });

        if (!executionAck) {
          logger("no execution ack");
          return;
        }

        if (!executionAck.success) {
          logger("execution ack unsuccessful");
          return;
        }

        // FIXME: shouldn't wait for completion here
        const completionAck = await socket.emitWithAck("EXECUTE_TASK_RUN", {
          version: "v1",
          payload: executionAck.payload,
        });

        logger("completed task", { completionId: completionAck.completion.id });

        this.#platformSocket?.emit("TASK_RUN_COMPLETED", {
          version: "v1",
          execution: executionAck.payload.execution,
          completion: completionAck.completion,
        });
      });

      socket.on("TASK_HEARTBEAT", (message) => {
        logger("[TASK_HEARTBEAT]", message);
        this.#platformSocket?.emit("TASK_HEARTBEAT", message);
      });

      socket.on("WAIT_FOR_BATCH", (message) => {
        logger("[WAIT_FOR_BATCH]", message);
        // this.#checkpointer.checkpointAndPush(socket.data.podName);
      });

      socket.on("WAIT_FOR_DURATION", (message) => {
        logger("[WAIT_FOR_DURATION]", message);
        // this.#checkpointer.checkpointAndPush(socket.data.podName);
      });

      socket.on("WAIT_FOR_TASK", (message) => {
        logger("[WAIT_FOR_TASK]", message);
        // this.#checkpointer.checkpointAndPush(socket.data.podName);
      });

      socket.on("INDEX_TASKS", async (message, callback) => {
        logger("[INDEX_TASKS]", message);

        const environmentClient = new CliApiClient(socket.data.apiUrl, socket.data.apiKey);

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

        logger({ createResponse });
        callback({ success: createResponse.success });
      });
    });

    // auth middleware
    namespace.use(async (socket, next) => {
      const logger = createLogger(`[task][${socket.id}][auth]`);

      const { auth } = socket.handshake;

      if (!("apiKey" in auth)) {
        logger("no api key");
        return socket.disconnect(true);
      }

      if (!("apiUrl" in auth)) {
        logger("no api url");
        return socket.disconnect(true);
      }

      async function validateApiKey(apiKey: string, apiUrl: string) {
        return true;
      }

      if (!(await validateApiKey(auth.apiKey, auth.apiUrl))) {
        logger("invalid api key");
        return socket.disconnect(true);
      }
      socket.data.apiKey = auth.apiKey;
      socket.data.apiUrl = auth.apiUrl;

      function setSocketDataFromHeader(dataKey: keyof typeof socket.data, headerName: string) {
        const value = socket.handshake.headers[headerName];
        if (!value) {
          logger(`missing required header: ${headerName}`);
          throw new Error("missing header");
        }
        socket.data[dataKey] = Array.isArray(value) ? value[0] : value;
      }

      try {
        setSocketDataFromHeader("contentHash", "x-trigger-content-hash");
        setSocketDataFromHeader("cliPackageVersion", "x-trigger-cli-package-version");
        setSocketDataFromHeader("projectRef", "x-trigger-project-ref");
        setSocketDataFromHeader("podName", "x-pod-name");
      } catch (error) {
        return socket.disconnect(true);
      }

      logger("success", socket.data);

      next();
    });

    return namespace;
  }

  #createHttpServer() {
    const httpServer = createServer(async (req, res) => {
      logger(`[${req.method}]`, req.url);

      const reply = new HttpReply(res);

      switch (req.url) {
        case "/health": {
          return reply.text("ok");
        }
        case "/metrics": {
          return res
            .writeHead(200, { "Content-Type": register.contentType })
            .end(await register.metrics());
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
      logger("server listening on port", HTTP_SERVER_PORT);
    });

    return httpServer;
  }

  listen() {
    this.#httpServer.listen(this.port, this.host);
  }
}

const coordinator = new TaskCoordinator(HTTP_SERVER_PORT);
coordinator.listen();
