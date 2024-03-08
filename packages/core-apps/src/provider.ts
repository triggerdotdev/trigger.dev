import { createServer } from "node:http";
import {
  ClientToSharedQueueMessages,
  clientWebsocketMessages,
  PlatformToProviderMessages,
  ProviderToPlatformMessages,
  SharedQueueToClientMessages,
  ZodMessageSender,
  ZodSocketConnection,
} from "@trigger.dev/core/v3";
import { getRandomPortNumber, HttpReply, getTextBody } from "./http";
import { SimpleLogger } from "./logger";

const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || getRandomPortNumber());
const MACHINE_NAME = process.env.MACHINE_NAME || "local";

const PLATFORM_HOST = process.env.PLATFORM_HOST || "127.0.0.1";
const PLATFORM_WS_PORT = process.env.PLATFORM_WS_PORT || 3030;
const PLATFORM_SECRET = process.env.PLATFORM_SECRET || "provider-secret";

const logger = new SimpleLogger(`[${MACHINE_NAME}]`);

export interface TaskOperations {
  create: (...args: any[]) => Promise<any>;
  restore: (...args: any[]) => Promise<any>;
  delete: (...args: any[]) => Promise<any>;
  get: (...args: any[]) => Promise<any>;
  index: (...args: any[]) => Promise<any>;
}

type ProviderShellOptions = {
  tasks: TaskOperations;
  host?: string;
  port?: number;
};

interface Provider {
  tasks: TaskOperations;
}

export class ProviderShell implements Provider {
  tasks: TaskOperations;

  #httpPort: number;
  #httpServer: ReturnType<typeof createServer>;
  #platformSocket: ZodSocketConnection<
    typeof ProviderToPlatformMessages,
    typeof PlatformToProviderMessages
  >;

  constructor(private options: ProviderShellOptions) {
    this.tasks = options.tasks;
    this.#httpPort = options.port ?? HTTP_SERVER_PORT;
    this.#httpServer = this.#createHttpServer();
    this.#platformSocket = this.#createPlatformSocket();
    this.#createSharedQueueSocket();
  }

  #createSharedQueueSocket() {
    const sharedQueueConnection = new ZodSocketConnection({
      namespace: "shared-queue",
      host: PLATFORM_HOST,
      port: Number(PLATFORM_WS_PORT),
      clientMessages: ClientToSharedQueueMessages,
      serverMessages: SharedQueueToClientMessages,
      authToken: PLATFORM_SECRET,
      handlers: {
        SERVER_READY: async (message) => {
          // TODO: create new schema without worker requirement
          await sender.send("READY_FOR_TASKS", {
            backgroundWorkerId: "placeholder",
          });
        },
        BACKGROUND_WORKER_MESSAGE: async (message) => {
          if (message.data.type === "SCHEDULE_ATTEMPT") {
            this.tasks.create({
              envId: message.data.envId,
              attemptId: message.data.id,
              image: message.data.image,
              machine: {},
            });
          }
        },
      },
    });

    const sender = new ZodMessageSender({
      schema: clientWebsocketMessages,
      sender: async (message) => {
        return new Promise((resolve, reject) => {
          try {
            const { type, ...payload } = message;
            sharedQueueConnection.socket.emit(type, payload as any);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      },
    });

    return sharedQueueConnection;
  }

  #createPlatformSocket() {
    const platformConnection = new ZodSocketConnection({
      namespace: "provider",
      host: PLATFORM_HOST,
      port: Number(PLATFORM_WS_PORT),
      clientMessages: ProviderToPlatformMessages,
      serverMessages: PlatformToProviderMessages,
      authToken: PLATFORM_SECRET,
      extraHeaders: {
        "x-trigger-provider-type": "docker",
      },
      handlers: {
        DELETE: async (message) => {
          this.tasks.delete({ runId: message.name });

          return {
            message: "delete request received",
          };
        },
        GET: async (message) => {
          this.tasks.get({ runId: message.name });
        },
        HEALTH: async (message) => {
          return {
            status: "ok",
          };
        },
        INDEX: async (message) => {
          try {
            await this.tasks.index({
              contentHash: message.contentHash,
              imageTag: message.imageTag,
              envId: message.envId,
              apiKey: message.apiKey,
              apiUrl: message.apiUrl,
            });
          } catch (error) {
            logger.error("task index failed", error);
          }
        },
        RESTORE: async (message) => {},
      },
    });

    return platformConnection;
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
            envId: "placeholder",
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
      logger.log("server listening on port", this.#httpPort);
    });

    return httpServer;
  }

  listen() {
    this.#httpServer.listen(this.#httpPort, this.options.host ?? "0.0.0.0");
  }
}
