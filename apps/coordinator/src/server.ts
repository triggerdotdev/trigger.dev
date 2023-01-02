import {
  HostRPCSchema,
  Logger,
  ServerRPCSchema,
  ZodRPC,
} from "internal-bridge";
import {
  coordinatorCatalog,
  CoordinatorCatalog,
  InternalApiClient,
  platformCatalog,
  PlatformCatalog,
  ZodPublisher,
  ZodSubscriber,
} from "internal-platform";
import { v4 } from "uuid";
import { WebSocket } from "ws";
import { z, ZodError } from "zod";
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
  #triggerPublisher?: ZodPublisher<CoordinatorCatalog>;
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
        INITIALIZE_DELAY: async (data) => {
          if (!this.#triggerPublisher) {
            // TODO: need to recover from this issue by trying to reconnect
            return false;
          }

          if (!this.#organizationId) {
            // TODO: this should never really happen
            throw new Error(
              "Cannot complete workflow run without an organization ID"
            );
          }

          if (!this.#workflowId) {
            // TODO: this should never really happen
            throw new Error("Cannot send log without a workflow ID");
          }

          const response = await this.#triggerPublisher.publish(
            "INITIALIZE_DELAY",
            {
              id: data.waitId,
              delay: data.delay,
            },
            {
              "x-api-key": this.#apiKey,
              "x-workflow-id": this.#workflowId,
              "x-workflow-run-id": data.id,
            }
          );

          return !!response;
        },
        SEND_REQUEST: async (data) => {
          if (!this.#triggerPublisher) {
            // TODO: need to recover from this issue by trying to reconnect
            return false;
          }

          if (!this.#organizationId) {
            // TODO: this should never really happen
            throw new Error(
              "Cannot complete workflow run without an organization ID"
            );
          }

          if (!this.#workflowId) {
            // TODO: this should never really happen
            throw new Error("Cannot send log without a workflow ID");
          }

          const response = await this.#triggerPublisher.publish(
            "SEND_INTEGRATION_REQUEST",
            {
              id: data.requestId,
              service: data.service,
              endpoint: data.endpoint,
              params: data.params,
            },
            {
              "x-api-key": this.#apiKey,
              "x-workflow-id": this.#workflowId,
              "x-workflow-run-id": data.id,
            }
          );

          return !!response;
        },
        SEND_EVENT: async (data) => {
          if (!this.#triggerPublisher) {
            // TODO: need to recover from this issue by trying to reconnect
            return false;
          }

          if (!this.#organizationId) {
            // TODO: this should never really happen
            throw new Error(
              "Cannot complete workflow run without an organization ID"
            );
          }

          if (!this.#workflowId) {
            // TODO: this should never really happen
            throw new Error("Cannot send log without a workflow ID");
          }

          const response = await this.#triggerPublisher.publish(
            "TRIGGER_CUSTOM_EVENT",
            {
              id: data.id,
              event: data.event,
            },
            {
              "x-api-key": this.#apiKey,
              "x-workflow-id": this.#workflowId,
            }
          );

          return !!response;
        },
        SEND_LOG: async (data) => {
          if (!this.#triggerPublisher) {
            // TODO: need to recover from this issue by trying to reconnect
            return false;
          }

          if (!this.#organizationId) {
            // TODO: this should never really happen
            throw new Error(
              "Cannot complete workflow run without an organization ID"
            );
          }

          if (!this.#workflowId) {
            // TODO: this should never really happen
            throw new Error("Cannot send log without a workflow ID");
          }

          const response = await this.#triggerPublisher.publish(
            "LOG_MESSAGE",
            {
              id: data.id,
              log: {
                level: data.log.level,
                message: data.log.message,
                properties: safeJsonParse(data.log.properties),
              },
            },
            {
              "x-api-key": this.#apiKey,
              "x-workflow-id": this.#workflowId,
            }
          );

          return !!response;
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
        SEND_WORKFLOW_ERROR: async (data) => {
          if (!this.#triggerPublisher) {
            // TODO: need to recover from this issue by trying to reconnect
            return false;
          }

          if (!this.#organizationId) {
            // TODO: this should never really happen
            throw new Error(
              "Cannot complete workflow run without an organization ID"
            );
          }

          const response = await this.#triggerPublisher.publish(
            "FAIL_WORKFLOW_RUN",
            data,
            {
              "x-api-key": this.#apiKey,
              "x-workflow-id": data.workflowId,
            }
          );

          return !!response;
        },
        COMPLETE_WORKFLOW_RUN: async (data) => {
          if (!this.#triggerPublisher) {
            // TODO: need to recover from this issue by trying to reconnect
            return false;
          }

          if (!this.#organizationId) {
            // TODO: this should never really happen
            throw new Error(
              "Cannot complete workflow run without an organization ID"
            );
          }

          const response = await this.#triggerPublisher.publish(
            "COMPLETE_WORKFLOW_RUN",
            data,
            {
              "x-api-key": this.#apiKey,
              "x-workflow-id": data.workflowId,
            }
          );

          return !!response;
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
      // register the workflow with the platform
      const response = await this.#apiClient.registerWorkflow({
        id: data.workflowId,
        name: data.workflowName,
        trigger: data.trigger,
        package: {
          name: data.packageName,
          version: data.packageVersion,
        },
      });

      this.#workflowId = response.id;

      this.#logger.debug("Initializing platform subscriber...");

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
          RESOLVE_INTEGRATION_REQUEST: async (id, data, properties) => {
            this.#logger.debug(
              "Received finish integration request",
              id,
              data,
              properties
            );

            if (!this.#serverRPC) {
              throw new Error(
                "Cannot finish integration request without an RPC connection"
              );
            }

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

            const success = await this.#serverRPC.send("RESOLVE_REQUEST", {
              id: data.id,
              output: data.output,
              meta: {
                workflowId: properties["x-workflow-id"],
                organizationId: properties["x-org-id"],
                environment: properties["x-env"],
                apiKey: properties["x-api-key"],
                runId: properties["x-workflow-run-id"],
              },
            });

            return success;
          },
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

            this.#logger.info("Triggering workflow", data, properties);

            // Send the trigger to the host machine

            // TODO - call this TRIGGER_WORKFLOW and then have the host machine create a new run
            this.#serverRPC?.send("TRIGGER_WORKFLOW", {
              id: data.id,
              trigger: data,
              meta: {
                workflowId: properties["x-workflow-id"],
                organizationId: properties["x-org-id"],
                environment: properties["x-env"],
                apiKey: properties["x-api-key"],
              },
            });

            try {
              const messageId = await this.#triggerPublisher?.publish(
                "START_WORKFLOW_RUN",
                {
                  id: data.id,
                },
                {
                  "x-workflow-id": properties["x-workflow-id"],
                  "x-api-key": properties["x-api-key"],
                }
              );

              return !!messageId;
            } catch (error) {
              this.#logger.error(
                "Failed to notify platform that workflow run started",
                error
              );
              return false;
            }
          },
        },
      });

      const result = await this.#triggerSubscriber.initialize();

      if (!result) {
        this.#logger.debug("Platform subscriber failed to initialize");
        return false;
      }

      this.#logger.info("Platform subscriber initialized");

      this.#logger.info("Initializing coordinator publisher...");

      this.#triggerPublisher = new ZodPublisher<CoordinatorCatalog>({
        schema: coordinatorCatalog,
        client: pulsarClient,
        config: {
          topic: `persistent://public/default/coordinator-events`,
        },
      });

      const result2 = await this.#triggerPublisher.initialize();

      if (!result2) {
        this.#logger.info("Coordinator publisher failed to initialize");
        await this.#closePubSub();
        return false;
      }

      this.#logger.info("Coordinator publisher initialized");

      this.#isInitialized = true;

      return true;
    } catch (error) {
      if (error instanceof ZodError) {
        this.#logger.error(
          `Failed to initialize workflow because the trigger is invalid: ${JSON.stringify(
            data.trigger
          )}`,
          error.issues
        );
      } else {
        this.#logger.error(
          "Failed to initialize workflow for some unknown reason",
          error
        );
      }

      return false;
    }
  }

  async #closePubSub() {
    if (this.#triggerSubscriber) {
      await this.#triggerSubscriber.close();
    }

    if (this.#triggerPublisher) {
      await this.#triggerPublisher.close();
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

function safeJsonParse(json?: string) {
  if (!json) {
    return undefined;
  }

  try {
    return JSON.parse(json);
  } catch (error) {
    return undefined;
  }
}
