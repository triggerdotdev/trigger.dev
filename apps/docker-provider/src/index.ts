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
import { HttpReply, getTextBody } from "@trigger.dev/core-apps";

const DEBUG = ["1", "true"].includes(process.env.DEBUG ?? "") || false;
const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || 8000);
const MACHINE_NAME = process.env.MACHINE_NAME || "local";

const PLATFORM_HOST = process.env.PLATFORM_HOST || "127.0.0.1";
const PLATFORM_WS_PORT = process.env.PLATFORM_WS_PORT || 5080;
const PLATFORM_SECRET = process.env.PLATFORM_SECRET || "provider-secret";

const REGISTRY_FQDN = process.env.REGISTRY_FQDN || "localhost:5000";
const REPO_NAME = process.env.REPO_NAME || "test";

function createLogger(prefix: string) {
  return (...args: any[]) => console.log(prefix, ...args);
}

const logger = createLogger(`[${MACHINE_NAME}]`);

const debug = (...args: any[]) => {
  if (!DEBUG) {
    return args[0];
  }
  logger("DEBUG", ...args);
  return args[0];
};

interface TaskOperations {
  create: (...args: any[]) => Promise<any>;
  restore: (...args: any[]) => Promise<any>;
  delete: (...args: any[]) => Promise<any>;
  get: (...args: any[]) => Promise<any>;
  index: (...args: any[]) => Promise<any>;
}

class DockerTaskOperations implements TaskOperations {
  #localOnly = true;

  constructor(
    private registryFQDN: string,
    private repoName: string
  ) {}

  async index(opts: { contentHash: string; imageTag: string }) {
    if (!this.#localOnly) {
      throw new Error("remote indexing not implemented yet");
    }

    const containerName = this.#getIndexContainerName(opts.contentHash);
    const { stdout, stderr, exitCode } =
      await $`docker run --rm -e COORDINATOR_PORT=8020 -e INDEX_TASKS=true --network=host --pull=never --name=${containerName} ${opts.imageTag}`;
    debug({ stdout, stderr });

    if (exitCode !== 0) {
      throw new Error("docker run command failed");
    }
  }

  async create(opts: { attemptId: string; image: string; machine: Machine }) {
    const containerName = this.#getRunContainerName(opts.attemptId);
    const { stdout, stderr, exitCode } =
      await $`docker run --rm -e COORDINATOR_PORT=8020 -e TRIGGER_ATTEMPT_ID=${opts.attemptId} --network=host --pull=never --name=${containerName} ${opts.image}`;
    debug({ stdout, stderr });

    if (exitCode !== 0) {
      throw new Error("docker run command failed");
    }
  }

  async restore(opts: {
    runId: string;
    image: string;
    name: string;
    checkpointId: string;
    machine: Machine;
  }) {
    logger("noop: restore");
  }

  async delete(opts: { runId: string }) {
    logger("noop: delete");
  }

  async get(opts: { runId: string }) {
    logger("noop: get");
  }

  #getIndexContainerName(contentHash: string) {
    return `task-index-${contentHash}`;
  }

  #getRunContainerName(runId: string) {
    return `task-run-${runId}`;
  }

  #getImageFromRunId(runId: string) {
    if (this.#localOnly) {
      return `${this.registryFQDN}/${this.repoName}:${runId}`;
    } else {
      return `${this.repoName}:${runId}`;
    }
  }

  #getRestoreImage(runId: string, checkpointId: string) {
    return this.#getImageFromRunId(checkpointId);
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

    const logger = createLogger(`[shared-queue][${socket.id ?? "NO_ID"}]`);

    socket.on("connect_error", (err) => {
      logger(`connect_error: ${err.message}`);
    });

    socket.on("connect", () => {
      logger("connect");
    });

    socket.on("disconnect", () => {
      logger("disconnect");
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
          logger("received SERVER_READY", payload);
          // FIXME: create new schema without worker req
          await sender.send("READY_FOR_TASKS", {
            backgroundWorkerId: "placeholder",
          });
        },
        BACKGROUND_WORKER_MESSAGE: async (payload) => {
          logger("received BACKGROUND_WORKER_MESSAGE", payload);
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

    const logger = createLogger(`[platform][${socket.id ?? "NO_ID"}]`);

    socket.on("connect_error", (err) => {
      logger(`connect_error: ${err.message}`);
    });

    socket.on("connect", () => {
      logger("connect");
    });

    socket.on("disconnect", () => {
      logger("disconnect");
    });

    socket.on("GET", async (message) => {
      logger("[GET]", message);
      this.tasks.get({ runId: message.name });
    });

    socket.on("DELETE", async (message, callback) => {
      logger("[DELETE]", message);
      callback({
        message: "delete request received",
      });
      this.tasks.delete({ runId: message.name });
    });

    socket.on("INDEX", async (message) => {
      logger("[INDEX]", message);
      try {
        await this.tasks.index({
          contentHash: message.contentHash,
          imageTag: message.imageTag,
        });
        // callback({ success: true })
      } catch (error) {
        logger("index task failed");
        debug(error);
        // callback({ success: false })
      }
    });

    socket.on("INDEX_COMPLETE", async (message) => {
      logger("[INDEX_COMPLETE]", message);
      // await this.tasks.completeIndex({
      //   contentHash: message.contentHash,
      //   imageTag: message.imageTag,
      // })
    });

    socket.on("INVOKE", async (message) => {
      logger("[INVOKE]", message);
      await this.tasks.create({
        attemptId: message.name,
        image: message.name,
        machine: message.machine,
      });
    });

    socket.on("RESTORE", async (message) => {
      logger("[RESTORE]", message);
      await this.tasks.restore({
        runId: message.image,
        name: message.name,
        image: message.image,
        checkpointId: message.baseImage,
        machine: message.machine,
      });
    });

    socket.on("HEALTH", async (message) => {
      logger("[HEALTH]", message);
    });

    return socket;
  }

  #createHttpServer() {
    const httpServer = createServer(async (req, res) => {
      logger(`[${req.method}]`, req.url);

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

          await this.tasks.restore({
            runId: image,
            name: `${image}-restore`,
            image,
            checkpointId: baseImageTag,
            machine: {
              cpu: "1",
              memory: "100Mi",
            },
          });

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
      logger("server listening on port", this.options.port);
    });

    return httpServer;
  }

  listen() {
    this.#httpServer.listen(this.options.port, this.options.host ?? "0.0.0.0");
  }
}

const provider = new DockerProvider({
  port: HTTP_SERVER_PORT,
  tasks: new DockerTaskOperations(REGISTRY_FQDN, REPO_NAME),
});

provider.listen();
