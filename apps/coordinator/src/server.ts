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
  #organizationId?: string;
  #isInitialized = false;
  #messageBroker?: WorkflowMessageBroker;

  constructor(socket: WebSocket, apiKey: string) {
    this.#socket = socket;
    this.#apiKey = apiKey;
    this.#logger = new Logger("trigger.dev", "info");

    process.on("beforeExit", () => this.close.bind(this));
  }

  async listen(instanceId?: string) {
    await this.#initializeConnection(instanceId);
    this.#initializeRPC();
    this.#initializeServer();
  }

  async close() {
    this.#closeConnection();
    await this.#closeMessageBroker();
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

      this.#closeConnection();
      await this.#closeMessageBroker();
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

    const authorizationResponse = await authorizeApiKey(this.#apiKey);

    if (authorizationResponse.authorized) {
      this.#logger.debug(
        `Client authenticated for org ${authorizationResponse.organizationId}, sending message...`
      );

      this.#organizationId = authorizationResponse.organizationId;

      const authenticatedMessage = JSON.stringify({
        type: "MESSAGE",
        data: "AUTHENTICATED",
        id: v4(),
      });

      this.#socket.send(authenticatedMessage);

      this.#logger.debug("Server initialized");
    } else {
      this.#logger.debug("Client not authenticated, sending error...");

      this.#socket.close(
        4001,
        `Unauthorized: ${authorizationResponse.reason}}`
      );
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

    if (!this.#organizationId) {
      throw new Error("Cannot initialize host without an organizationId");
    }

    this.#logger.debug("Initializing message broker...");

    this.#messageBroker = new WorkflowMessageBroker({
      id: data.workflowId,
      orgId: this.#organizationId,
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

  async #closeMessageBroker() {
    if (this.#messageBroker) {
      await this.#messageBroker.close();
    }
  }

  #closeConnection() {
    this.#isConnected = false;
    this.#connection?.close();
    this.#connection = undefined;
    this.#serverRPC = undefined;
  }
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

type AuthorizationSuccess = {
  authorized: true;
  organizationId: string;
};

type AuthorizationFailure = {
  authorized: false;
  reason?: string;
};

type AuthorizationResponse = AuthorizationSuccess | AuthorizationFailure;

async function authorizeApiKey(
  apiKey: string | undefined
): Promise<AuthorizationResponse> {
  if (!apiKey || typeof apiKey !== "string") {
    return { authorized: false, reason: "Missing API key" };
  }

  if (apiKey === "trigger_123") {
    return { authorized: true, organizationId: "123" };
  }

  return { authorized: false, reason: "Invalid API key" };
}
