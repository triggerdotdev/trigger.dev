import { createServer } from "node:http";
import {
  ClientToSharedQueueMessages,
  clientWebsocketMessages,
  EnvironmentType,
  MachinePreset,
  PlatformToProviderMessages,
  ProviderToPlatformMessages,
  SharedQueueToClientMessages,
} from "@trigger.dev/core/v3";
import { ZodMessageSender } from "@trigger.dev/core/v3/zodMessageHandler";
import { ZodSocketConnection } from "@trigger.dev/core/v3/zodSocket";
import { getRandomPortNumber, HttpReply, getTextBody } from "./http";
import { SimpleLogger } from "./logger";
import { isExecaChildProcess } from "./checkpoints";
import { setTimeout } from "node:timers/promises";
import { EXIT_CODE_ALREADY_HANDLED } from "./process";

const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || getRandomPortNumber());
const MACHINE_NAME = process.env.MACHINE_NAME || "local";

const PLATFORM_HOST = process.env.PLATFORM_HOST || "127.0.0.1";
const PLATFORM_WS_PORT = process.env.PLATFORM_WS_PORT || 3030;
const PLATFORM_SECRET = process.env.PLATFORM_SECRET || "provider-secret";
const SECURE_CONNECTION = ["1", "true"].includes(process.env.SECURE_CONNECTION ?? "false");

const logger = new SimpleLogger(`[${MACHINE_NAME}]`);

export interface TaskOperationsIndexOptions {
  shortCode: string;
  imageRef: string;
  apiKey: string;
  apiUrl: string;
  // identifiers
  envId: string;
  envType: EnvironmentType;
  orgId: string;
  projectId: string;
  deploymentId: string;
}

export interface TaskOperationsCreateOptions {
  image: string;
  machine: MachinePreset;
  version: string;
  // identifiers
  envId: string;
  envType: EnvironmentType;
  orgId: string;
  projectId: string;
  runId: string;
}

export interface TaskOperationsRestoreOptions {
  imageRef: string;
  checkpointRef: string;
  machine: MachinePreset;
  // identifiers
  envId: string;
  envType: EnvironmentType;
  orgId: string;
  projectId: string;
  runId: string;
  checkpointId: string;
}

export interface TaskOperations {
  init: () => Promise<any>;

  // CRUD
  index: (opts: TaskOperationsIndexOptions) => Promise<any>;
  create: (opts: TaskOperationsCreateOptions) => Promise<any>;
  restore: (opts: TaskOperationsRestoreOptions) => Promise<any>;

  // unimplemented
  delete: (...args: any[]) => Promise<any>;
  get: (...args: any[]) => Promise<any>;
}

type ProviderShellOptions = {
  tasks: TaskOperations;
  type: "docker" | "kubernetes";
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
  platformSocket: ZodSocketConnection<
    typeof ProviderToPlatformMessages,
    typeof PlatformToProviderMessages
  >;

  constructor(private options: ProviderShellOptions) {
    this.tasks = options.tasks;
    this.#httpPort = options.port ?? HTTP_SERVER_PORT;
    this.#httpServer = this.#createHttpServer();
    this.platformSocket = this.#createPlatformSocket();
    this.#createSharedQueueSocket();
  }

  #createSharedQueueSocket() {
    const sharedQueueConnection = new ZodSocketConnection({
      namespace: "shared-queue",
      host: PLATFORM_HOST,
      port: Number(PLATFORM_WS_PORT),
      secure: SECURE_CONNECTION,
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
            try {
              await this.tasks.create({
                image: message.data.image,
                machine: message.data.machine,
                version: message.data.version,
                // identifiers
                envId: message.data.envId,
                envType: message.data.envType,
                orgId: message.data.orgId,
                projectId: message.data.projectId,
                runId: message.data.runId,
              });
            } catch (error) {
              logger.error("create failed", error);
            }
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
      secure: SECURE_CONNECTION,
      clientMessages: ProviderToPlatformMessages,
      serverMessages: PlatformToProviderMessages,
      authToken: PLATFORM_SECRET,
      extraHeaders: {
        "x-trigger-provider-type": this.options.type,
      },
      handlers: {
        INDEX: async (message) => {
          try {
            await this.tasks.index({
              shortCode: message.shortCode,
              imageRef: message.imageTag,
              apiKey: message.apiKey,
              apiUrl: message.apiUrl,
              // identifiers
              envId: message.envId,
              envType: message.envType,
              orgId: message.orgId,
              projectId: message.projectId,
              deploymentId: message.deploymentId,
            });
          } catch (error) {
            if (isExecaChildProcess(error)) {
              logger.error("Index failed", {
                socketMessage: message,
                exitCode: error.exitCode,
                escapedCommand: error.escapedCommand,
                stdout: error.stdout,
                stderr: error.stderr,
              });

              if (error.exitCode === EXIT_CODE_ALREADY_HANDLED) {
                logger.error("Index failure already reported by the worker", {
                  socketMessage: message,
                });

                // Add a brief delay to avoid messaging race conditions
                await setTimeout(2000);
              }

              function normalizeStderr(stderr: string) {
                return stderr
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0)
                  .join("\n");
              }

              return {
                success: false,
                error: {
                  name: "Index error",
                  message: `Crashed with exit code ${error.exitCode}`,
                  stderr: normalizeStderr(error.stderr),
                },
              };
            } else {
              logger.error("Index failed", error);
            }

            if (error instanceof Error) {
              return {
                success: false,
                error: {
                  name: "Provider error",
                  message: error.message,
                  stack: error.stack,
                },
              };
            } else {
              return {
                success: false,
                error: {
                  name: "Provider error",
                  message: "Unknown error",
                },
              };
            }
          }

          return {
            success: true,
          };
        },
        RESTORE: async (message) => {
          if (message.type.toLowerCase() !== this.options.type.toLowerCase()) {
            logger.error(
              `restore failed: ${this.options.type} provider can't restore ${message.type} checkpoints`
            );
            return;
          }

          try {
            await this.tasks.restore({
              checkpointRef: message.location,
              machine: message.machine,
              imageRef: message.imageRef,
              // identifiers
              envId: message.envId,
              envType: message.envType,
              orgId: message.orgId,
              projectId: message.projectId,
              runId: message.runId,
              checkpointId: message.checkpointId,
            });
          } catch (error) {
            logger.error("restore failed", error);
          }
        },
      },
    });

    return platformConnection;
  }

  #createHttpServer() {
    const httpServer = createServer(async (req, res) => {
      logger.log(`[${req.method}]`, req.url);

      const reply = new HttpReply(res);

      try {
        const url = new URL(req.url ?? "", `http://${req.headers.host}`);

        switch (url.pathname) {
          case "/health": {
            return reply.text("ok");
          }
          case "/whoami": {
            return reply.text(`${MACHINE_NAME}`);
          }
          case "/close": {
            this.platformSocket.close();
            return reply.text("platform socket closed");
          }
          case "/delete": {
            const body = await getTextBody(req);

            await this.tasks.delete({ runId: body });

            return reply.text(`sent delete request: ${body}`);
          }
          default: {
            return reply.empty(404);
          }
        }
      } catch (error) {
        logger.error("HTTP server error", { error });
        reply.empty(500);
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

  async listen() {
    this.#httpServer.listen(this.#httpPort, this.options.host ?? "0.0.0.0");
    await this.tasks.init();
  }
}
