import { createServer } from "node:http";
import { $ } from "execa";
import { io, Socket } from "socket.io-client";
import {
  clientWebsocketMessages,
  Machine,
  MessageCatalogToSocketIoEvents,
  ProviderClientToServerEvents,
  ProviderServerToClientEvents,
  serverWebsocketMessages,
  ZodMessageHandler,
  ZodMessageSender,
} from "@trigger.dev/core/v3";
import { HttpReply, SimpleLogger, getTextBody } from "@trigger.dev/core-apps";

const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || 8000);
const MACHINE_NAME = process.env.MACHINE_NAME || "local";

const PLATFORM_HOST = process.env.PLATFORM_HOST || "127.0.0.1";
const PLATFORM_WS_PORT = process.env.PLATFORM_WS_PORT || 5080;
const PLATFORM_SECRET = process.env.PLATFORM_SECRET || "provider-secret";

const logger = new SimpleLogger(`[${MACHINE_NAME}]`);

interface TaskOperations {
  create: (...args: any[]) => Promise<any>;
  restore: (...args: any[]) => Promise<any>;
  delete: (...args: any[]) => Promise<any>;
  get: (...args: any[]) => Promise<any>;
  index: (...args: any[]) => Promise<any>;
}

class DockerTaskOperations implements TaskOperations {
  async index(opts: { contentHash: string; imageTag: string }) {
    const containerName = this.#getIndexContainerName(opts.contentHash);

    const { exitCode } = logger.debug(
      await $`docker run --rm -e COORDINATOR_PORT=8020 -e POD_NAME=${containerName} -e INDEX_TASKS=true --network=host --pull=never --name=${containerName} ${opts.imageTag}`
    );

    if (exitCode !== 0) {
      throw new Error("docker run command failed");
    }
  }

  async create(opts: { attemptId: string; image: string; machine: Machine }) {
    const containerName = this.#getRunContainerName(opts.attemptId);

    const { exitCode } = logger.debug(
      await $`docker run -d -e COORDINATOR_PORT=8020 -e POD_NAME=${containerName} -e TRIGGER_ATTEMPT_ID=${opts.attemptId} --network=host --pull=never --name=${containerName} ${opts.image}`
    );

    if (exitCode !== 0) {
      throw new Error("docker run command failed");
    }
  }

  async restore(opts: {
    attemptId: string;
    runId: string;
    image: string;
    name: string;
    checkpointId: string;
    machine: Machine;
  }) {
    const containerName = this.#getRunContainerName(opts.attemptId);

    const { exitCode } = logger.debug(
      await $`docker start --checkpoint=${opts.checkpointId} ${containerName}`
    );

    if (exitCode !== 0) {
      throw new Error("docker start command failed");
    }
  }

  async delete(opts: { runId: string }) {
    logger.log("noop: delete");
  }

  async get(opts: { runId: string }) {
    logger.log("noop: get");
  }

  #getIndexContainerName(contentHash: string) {
    return `task-index-${contentHash}`;
  }

  #getRunContainerName(attemptId: string) {
    return `task-run-${attemptId}`;
  }
}

interface Provider {
  tasks: TaskOperations;
}

type DockerProviderOptions = {
  tasks: DockerTaskOperations;
  host?: string;
  port: number;
};

class DockerProvider implements Provider {
  tasks: DockerTaskOperations;

  #httpServer: ReturnType<typeof createServer>;
  #platformSocket: Socket<ProviderServerToClientEvents, ProviderClientToServerEvents>;

  constructor(private options: DockerProviderOptions) {
    this.tasks = options.tasks;
    this.#httpServer = this.#createHttpServer();
    this.#platformSocket = this.#createPlatformSocket();
    this.#createSharedQueueSocket();
  }

  #createSharedQueueSocket() {
    const socket: Socket<
      MessageCatalogToSocketIoEvents<typeof serverWebsocketMessages>,
      MessageCatalogToSocketIoEvents<typeof clientWebsocketMessages>
    > = io(`ws://${PLATFORM_HOST}:${PLATFORM_WS_PORT}/shared-queue`, {
      transports: ["websocket"],
      auth: {
        token: PLATFORM_SECRET,
      },
    });

    const logger = new SimpleLogger(`[shared-queue][${socket.id ?? "NO_ID"}]`);

    socket.on("connect_error", (err) => {
      logger.error(`connect_error: ${err.message}`);
    });

    socket.on("connect", () => {
      logger.log("connect");
    });

    socket.on("disconnect", () => {
      logger.log("disconnect");
    });

    const sender = new ZodMessageSender({
      schema: clientWebsocketMessages,
      sender: async (message) => {
        return new Promise((resolve, reject) => {
          try {
            const { type, ...payload } = message;
            socket.emit(type, payload as any);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      },
    });

    const handler = new ZodMessageHandler({
      schema: serverWebsocketMessages,
      messages: {
        SERVER_READY: async (payload) => {
          logger.log("received SERVER_READY", payload);

          // TODO: create new schema without worker requirement
          await sender.send("READY_FOR_TASKS", {
            backgroundWorkerId: "placeholder",
          });
        },
        BACKGROUND_WORKER_MESSAGE: async (payload) => {
          logger.log("received BACKGROUND_WORKER_MESSAGE", payload);

          if (payload.data.type === "SCHEDULE_ATTEMPT") {
            this.tasks.create({
              attemptId: payload.data.id,
              image: payload.data.image,
              machine: {},
            });
          }
        },
      },
    });
    handler.registerHandlers(socket);

    return socket;
  }

  #createPlatformSocket() {
    const socket: Socket<ProviderServerToClientEvents, ProviderClientToServerEvents> = io(
      `ws://${PLATFORM_HOST}:${PLATFORM_WS_PORT}/provider`,
      {
        transports: ["websocket"],
        auth: {
          token: PLATFORM_SECRET,
        },
        extraHeaders: {
          "x-trigger-provider-type": "docker",
        },
      }
    );

    const logger = new SimpleLogger(`[platform][${socket.id ?? "NO_ID"}]`);

    socket.on("connect_error", (err) => {
      logger.error(`connect_error: ${err.message}`);
    });

    socket.on("connect", () => {
      logger.log("connect");
    });

    socket.on("disconnect", () => {
      logger.log("disconnect");
    });

    socket.on("GET", async (message) => {
      logger.log("[GET]", message);

      this.tasks.get({ runId: message.name });
    });

    socket.on("DELETE", async (message, callback) => {
      logger.log("[DELETE]", message);

      callback({
        message: "delete request received",
      });

      this.tasks.delete({ runId: message.name });
    });

    socket.on("INDEX", async (message) => {
      logger.log("[INDEX]", message);
      try {
        await this.tasks.index({
          contentHash: message.contentHash,
          imageTag: message.imageTag,
        });
      } catch (error) {
        logger.error("task index failed", error);
      }
    });

    socket.on("INVOKE", async (message) => {
      logger.log("[INVOKE]", message);
      await this.tasks.create({
        attemptId: message.name,
        image: message.name,
        machine: message.machine,
      });
    });

    socket.on("RESTORE", async (message) => {
      logger.log("[RESTORE]", message);
      // await this.tasks.restore({});
    });

    socket.on("HEALTH", async (message) => {
      logger.log("[HEALTH]", message);
    });

    return socket;
  }

  #createHttpServer() {
    const httpServer = createServer(async (req, res) => {
      logger.log(`[${req.method}]`, req.url);

      const reply = new HttpReply(res);

      switch (req.url) {
        case "/health": {
          return reply.text("ok");
        }
        case "/whoami": {
          return reply.text(`${MACHINE_NAME}`);
        }
        case "/close": {
          this.#platformSocket.close();
          return reply.text("platform socket closed");
        }
        case "/delete": {
          const body = await getTextBody(req);

          await this.tasks.delete({ runId: body });

          return reply.text(`sent delete request: ${body}`);
        }
        case "/invoke": {
          const body = await getTextBody(req);

          await this.tasks.create({
            attemptId: body,
            image: body,
            machine: {
              cpu: "1",
              memory: "100Mi",
            },
          });

          return reply.text(`sent restore request: ${body}`);
        }
        case "/restore": {
          const body = await getTextBody(req);

          const items = body.split("&");
          const image = items[0];
          const baseImageTag = items[1] ?? image;

          // await this.tasks.restore({});

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
      logger.log("server listening on port", this.options.port);
    });

    return httpServer;
  }

  listen() {
    this.#httpServer.listen(this.options.port, this.options.host ?? "0.0.0.0");
  }
}

const provider = new DockerProvider({
  port: HTTP_SERVER_PORT,
  tasks: new DockerTaskOperations(),
});

provider.listen();
