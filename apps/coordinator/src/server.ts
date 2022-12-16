import {
  HostRPCSchema,
  Logger,
  ServerRPCSchema,
  ZodRPC,
} from "internal-bridge";
import {
  InternalApiClient,
  platformCatalog,
  PlatformCatalog,
  TriggerMetadataSchema,
  ZodSubscriber,
} from "internal-platform";
import { v4 } from "uuid";
import { WebSocket } from "ws";
import { z } from "zod";
import { TriggerServerConnection } from "./connection";
import { env } from "./env";
import { pulsarClient } from "./pulsarClient";

export class TriggerServer {
  #connection?: TriggerServerConnection;
  #serverRPC?: ZodRPC<typeof HostRPCSchema, typeof ServerRPCSchema>;
  #isConnected = false;
  #retryIntervalMs: number = 3000;
  #logger: Logger;
  #socket: WebSocket;
  #organizationId?: string;
  #isInitialized = false;
  #triggerSubscriber?: ZodSubscriber<PlatformCatalog>;
  #apiClient: InternalApiClient;
  #workflowId?: string;
  #apiKey: string;

  constructor(socket: WebSocket, apiKey: string) {
    this.#socket = socket;
    this.#apiKey = apiKey;
    this.#apiClient = new InternalApiClient(apiKey, env.PLATFORM_API_URL);
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

    try {
      const whoamiResponse = await this.#apiClient.whoami();

      this.#logger.debug(
        `Client authenticated for org ${whoamiResponse.organizationId}, sending message...`
      );

      this.#organizationId = whoamiResponse.organizationId;

      const authenticatedMessage = JSON.stringify({
        type: "MESSAGE",
        data: "AUTHENTICATED",
        id: v4(),
      });

      this.#socket.send(authenticatedMessage);

      this.#logger.debug("Server initialized");
    } catch (error) {
      this.#logger.debug("Client not authenticated, sending error...");

      this.#socket.close(4001, `Unauthorized: ${error}}`);
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

    if (!this.#connection) {
      throw new Error(
        "Cannot initialize host without a connection to the host machine"
      );
    }

    try {
      // TODO: do this in a better/safer way
      const parsedTrigger = TriggerMetadataSchema.parse(data.trigger);

      // register the workflow with the platform
      const response = await this.#apiClient.registerWorkflow({
        id: data.workflowId,
        name: data.workflowName,
        trigger: parsedTrigger,
        package: {
          name: data.packageName,
          version: data.packageVersion,
        },
      });

      this.#workflowId = response.id;

      this.#logger.debug("Initializing pub sub...");

      this.#triggerSubscriber = new ZodSubscriber<PlatformCatalog>({
        schema: platformCatalog,
        client: pulsarClient,
        config: {
          topic: `persistent://public/default/workflow-triggers`,
          subscription: `coordinator-${this.#workflowId}`,
          subscriptionType: "Shared",
          subscriptionInitialPosition: "Earliest",
        },
        handlers: {
          TRIGGER_WORKFLOW: async (id, data, properties) => {
            this.#logger.debug("Received trigger", id, data, properties);
            // If the API keys don't match, then we should ignore it
            // This ensures the workflow is triggered for the correct environment
            if (properties["x-api-key"] !== this.#apiKey) {
              return true;
            }

            // If the workflow id is not the same as the workflow id
            // that we are listening for, then we should ignore it
            if (properties["x-workflow-id"] !== this.#workflowId) {
              return true;
            }

            this.#logger.info("Triggering workflow", id, data, properties);

            // Send the trigger to the host machine

            // this.#serverRPC?.send("TRIGGER_WORKFLOW", {
            //   id,
            //   data,
            //   properties,
            // });

            return true;
          },
        },
      });

      const result = await this.#triggerSubscriber.initialize();

      if (!result) {
        this.#logger.debug("Pub sub failed to initialize");
        return false;
      }

      this.#logger.info("Pub sub initialized");

      this.#isInitialized = true;

      return true;
    } catch (error) {
      this.#logger.error("Failed to initialize workflow", error);

      return false;
    }
  }

  async #closePubSub() {
    if (this.#triggerSubscriber) {
      await this.#triggerSubscriber.close();
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
