import { v4 } from "uuid";
import { z } from "zod";
import { TimeoutError, TriggerServerConnection } from "./connection";
import { WebSocket } from "ws";
import {
  ZodRPC,
  ServerRPCSchema,
  HostRPCSchema,
  Logger,
} from "internal-bridge";
import { WorkflowMessageBroker } from "./messageBroker";

export class TriggerServer {
  #connection?: TriggerServerConnection;
  #serverRPC?: ZodRPC<typeof HostRPCSchema, typeof ServerRPCSchema>;
  #isConnected = false;
  #retryIntervalMs: number = 3000;
  #logger: Logger;
  #socket: WebSocket;
  #apiKey: string;
  #isInitialized = false;
  #messageBroker?: WorkflowMessageBroker;

  constructor(socket: WebSocket, apiKey: string) {
    this.#socket = socket;
    this.#apiKey = apiKey;
    this.#logger = new Logger("trigger.dev", "info");
  }

  async listen(instanceId?: string) {
    await this.#initializeConnection(instanceId);
    this.#initializeRPC();
    this.#initializeServer();
  }

  async #initializeConnection(instanceId?: string) {
    const id = instanceId ?? v4();

    this.#logger.debug("Initializing connection...", id);

    const connection = new TriggerServerConnection(this.#socket, { id });

    connection.onClose.attach(async ([code, reason]) => {
      console.error(`Could not connect to host (code ${code})`);

      if (reason) {
        console.error(reason);
      }
    });

    this.#logger.debug("Connection initialized", id);

    this.#connection = connection;
    this.#isConnected = true;
  }

  async #initializeRPC() {
    if (!this.#connection) {
      throw new Error("Cannot initialize RPC without a connection");
    }

    const serverRPC = new ZodRPC({
      connection: this.#connection,
      sender: HostRPCSchema,
      receiver: ServerRPCSchema,
      handlers: {
        SEND_LOG: async (data) => {
          console.log("SEND_LOG", data);

          return true;
        },
        INITIALIZE_HOST: async (data) => {
          console.log("INITIALIZE_HOST", data);

          this.#initializeHost(data);

          // Create a new Workflow connection

          return { type: "success" as const };
        },
      },
    });

    this.#serverRPC = serverRPC;
  }

  async #initializeServer() {
    if (!this.#connection) {
      throw new Error("Cannot initialize host without a connection");
    }

    if (!this.#serverRPC) {
      throw new Error("Cannot initialize host without an RPC connection");
    }

    this.#logger.debug("Checking authorized to use messagingClient");

    const isAuthorized = await authorized(this.#apiKey);

    if (isAuthorized) {
      this.#logger.debug("Client authenticated, sending message...");

      const authenticatedMessage = JSON.stringify({
        type: "MESSAGE",
        data: "AUTHENTICATED",
        id: v4(),
      });

      this.#socket.send(authenticatedMessage);

      this.#logger.debug("Server initialized");
    } else {
      this.#logger.debug("Client not authenticated, sending error...");

      this.#socket.close(4001, "Unauthorized");
    }
  }

  async #send<MethodName extends keyof typeof HostRPCSchema>(
    methodName: MethodName,
    request: z.input<typeof HostRPCSchema[MethodName]["request"]>
  ) {
    if (!this.#serverRPC) throw new Error("serverRPC not initialized");

    while (true) {
      try {
        return await this.#serverRPC.send(methodName, request);
      } catch (err) {
        if (err instanceof TimeoutError) {
          this.#logger.debug(
            `RPC call timed out, retrying in ${Math.round(
              this.#retryIntervalMs / 1000
            )}s...`
          );
          this.#logger.debug(err);

          await sleep(this.#retryIntervalMs);
        } else {
          throw err;
        }
      }
    }
  }

  async #initializeHost(
    data: z.infer<typeof ServerRPCSchema["INITIALIZE_HOST"]["request"]>
  ) {
    if (this.#isInitialized) {
      throw new Error(
        "Host already initialized, attempting to initialize again"
      );
    }

    this.#logger.debug("Initializing message broker...");

    this.#messageBroker = new WorkflowMessageBroker({
      id: data.workflowId,
    });

    await this.#messageBroker.initialize({
      id: data.workflowId,
      name: data.workflowName,
      trigger: {
        id: data.triggerId,
      },
      package: {
        name: data.packageName,
        version: data.packageVersion,
      },
    });
  }
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function authorized(apiKey: string | undefined): Promise<boolean> {
  if (!apiKey || typeof apiKey !== "string") {
    return false;
  }

  return apiKey === "trigger_123";
}
