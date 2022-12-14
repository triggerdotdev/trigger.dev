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
import { env } from "./env";
import { ZodPubSub } from "./zodPubSub";
import {
  coordinatorCatalog,
  CoordinatorCatalog,
  platformCatalog,
  PlatformCatalog,
} from "internal-messages";
import { pulsarClient } from "./pulsarClient";

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
  #pubSub?: ZodPubSub<PlatformCatalog, CoordinatorCatalog>;

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
    await this.#closePubSub();
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
      await this.#closePubSub();
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
          return true;
        },
        INITIALIZE_HOST: async (data) => {
          // Initialize workflow
          const success = await this.#initializeWorkflow(data);

          if (success) {
            return { type: "success" as const };
          } else {
            return {
              type: "error" as const,
              message: "Failed to connect to the Pulsar cluster",
            };
          }
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

  async #initializeWorkflow(
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

    this.#logger.debug("Initializing pub sub...");

    this.#pubSub = new ZodPubSub<PlatformCatalog, CoordinatorCatalog>({
      subscriberSchema: platformCatalog,
      publisherSchema: coordinatorCatalog,
      client: pulsarClient,
      subscriberConfig: {
        topic: `persistent://public/default/workflows-${this.#organizationId}-${
          data.workflowId
        }`,
        subscription: `coordinator`,
        subscriptionType: "Exclusive",
      },
      publisherConfig: {
        topic: `workflows-meta`,
      },
      handlers: {
        TRIGGER_WORKFLOW: async (id, data, properties) => {
          return true;
        },
      },
    });

    const result = await this.#pubSub.initialize();

    if (!result) {
      this.#logger.debug("Pub sub failed to initialize");
      return false;
    }

    this.#logger.debug("Pub sub initialized");

    this.#isInitialized = true;

    return true;
  }

  async #closePubSub() {
    if (this.#pubSub) {
      await this.#pubSub.close();
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
  env: string;
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

  return performAuthorizationRequest(apiKey);
}

async function performAuthorizationRequest(
  apiKey: string
): Promise<AuthorizationResponse> {
  const response = await fetch(env.AUTHORIZATION_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (response.ok) {
    const body = await response.json();

    return {
      authorized: true,
      organizationId: body.organizationId,
      env: body.env,
    };
  }

  if (response.status === 401) {
    const errorBody = await response.json();

    return { authorized: false, reason: errorBody.error };
  }

  return {
    authorized: false,
    reason: `[${response.status}] Something went wrong: ${response.statusText}`,
  };
}
