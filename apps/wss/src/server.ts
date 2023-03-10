import { Evt } from "evt";
import {
  HostRPCSchema,
  Logger,
  ServerRPCSchema,
  ZodRPC,
} from "internal-bridge";
import {
  CommandCatalog,
  InternalApiClient,
  TriggerCatalog,
  triggerCatalog,
  ZodPublisher,
  ZodSubscriber,
} from "internal-platform";
import { Topics } from "internal-pulsar";
import { v4 } from "uuid";
import { WebSocket } from "ws";
import { z, ZodError } from "zod";
import { TriggerServerConnection } from "./connection";
import { env } from "./env";
import { pulsarClient } from "./pulsarClient";
import { WorkflowRunController } from "./runController";

export class TriggerServer {
  #connection?: TriggerServerConnection;
  #serverRPC?: ZodRPC<typeof HostRPCSchema, typeof ServerRPCSchema>;
  #isConnected = false;
  #retryIntervalMs: number = 3000;
  #logger: Logger;
  #socket: WebSocket;
  #organizationId?: string;
  #isInitialized = false;
  #triggerSubscriber?: ZodSubscriber<TriggerCatalog>;
  #commandPublisher: ZodPublisher<CommandCatalog>;
  #apiClient: InternalApiClient;
  #workflowId?: string;
  #apiKey: string;
  #runControllers = new Map<string, WorkflowRunController>();
  #closedByServer = false;
  onClose: Evt<void>;
  id: string;

  constructor(
    socket: WebSocket,
    apiKey: string,
    publisher: ZodPublisher<CommandCatalog>
  ) {
    this.#socket = socket;
    this.#apiKey = apiKey;
    this.#apiClient = new InternalApiClient(apiKey, env.PLATFORM_API_URL);
    this.#logger = new Logger("trigger.dev server");
    this.onClose = new Evt();
    this.#commandPublisher = publisher;
    this.id = v4();
  }

  async listen() {
    await this.#initializeConnection();
    this.#initializeRPC();
    this.#initializeServer();
  }

  async close() {
    if (!this.#isConnected) {
      return;
    }

    this.#closedByServer = true;
    return this.#close();
  }

  async #close() {
    this.#isConnected = false;

    await this.#closePubSub();

    if (this.#closedByServer) {
      this.#closeConnection();
    }

    this.onClose.post();
  }

  async #initializeConnection() {
    this.#logger.debug("Initializing connection...", this.id);

    const connection = new TriggerServerConnection(this.#socket, {
      id: this.id,
    });

    connection.onClose.attach(async ([code, reason]) => {
      if (!this.#isConnected) {
        return;
      }

      this.#closedByServer = false;

      this.#logger.log(`Connection with host was closed (${code})`, this.id);

      if (reason) {
        this.#logger.error(reason);
      }

      await this.close();
    });

    this.#logger.debug("Connection initialized", this.id);

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
        INITIALIZE_DELAY: async (request) => {
          const runController = this.#runControllers.get(request.runId);

          if (!runController) {
            // TODO: need to recover from this issue by trying to reconnect
            return false;
          }

          const response = await runController.publish("INITIALIZE_DELAY", {
            key: request.key,
            wait: request.wait,
          });

          return !!response;
        },
        SEND_REQUEST: async (request) => {
          const runController = this.#runControllers.get(request.runId);

          if (!runController) {
            // TODO: need to recover from this issue by trying to reconnect
            return false;
          }

          const response = await runController.publish(
            "SEND_INTEGRATION_REQUEST",
            {
              key: request.key,
              request: request.request,
            }
          );

          return !!response;
        },
        SEND_FETCH: async (request) => {
          const runController = this.#runControllers.get(request.runId);

          if (!runController) {
            // TODO: need to recover from this issue by trying to reconnect
            return false;
          }

          const response = await runController.publish("SEND_FETCH_REQUEST", {
            key: request.key,
            fetch: request.fetch,
          });

          return !!response;
        },
        INITIALIZE_RUN_ONCE: async (request) => {
          const runController = this.#runControllers.get(request.runId);

          if (!runController) {
            // TODO: need to recover from this issue by trying to reconnect
            return false;
          }

          const response = await runController.publish("INITIALIZE_RUN_ONCE", {
            key: request.key,
            runOnce: request.runOnce,
          });

          return !!response;
        },
        COMPLETE_RUN_ONCE: async (request) => {
          const runController = this.#runControllers.get(request.runId);

          if (!runController) {
            // TODO: need to recover from this issue by trying to reconnect
            return false;
          }

          const response = await runController.publish("COMPLETE_RUN_ONCE", {
            key: request.key,
            runOnce: request.runOnce,
          });

          return !!response;
        },
        SEND_EVENT: async (request) => {
          const runController = this.#runControllers.get(request.runId);

          if (!runController) {
            // TODO: need to recover from this issue by trying to reconnect
            return false;
          }

          const response = await runController.publish("TRIGGER_CUSTOM_EVENT", {
            key: request.key,
            event: request.event,
          });

          return !!response;
        },
        SEND_LOG: async (request) => {
          this.#logger.debug("Received SEND_LOG", request);

          const runController = this.#runControllers.get(request.runId);

          if (!runController) {
            this.#logger.debug(
              "Aborting SEND_LOG because there are is no runController for ",
              request.runId
            );

            return false;
          }

          const response = await runController.publish("LOG_MESSAGE", {
            key: request.key,
            log: {
              level: request.log.level,
              message: request.log.message,
              properties: safeJsonParse(request.log.properties),
            },
          });

          return !!response;
        },
        SEND_WORKFLOW_ERROR: async (request) => {
          const runController = this.#runControllers.get(request.runId);

          if (!runController) {
            return false;
          }

          const response = await runController.publish("WORKFLOW_RUN_ERROR", {
            error: request.error,
          });

          return !!response;
        },
        START_WORKFLOW_RUN: async (request) => {
          const runController = this.#runControllers.get(request.runId);

          if (!runController) {
            return false;
          }

          const response = await runController.publish("WORKFLOW_RUN_STARTED", {
            id: request.runId,
          });

          return !!response;
        },
        COMPLETE_WORKFLOW_RUN: async (request) => {
          const runController = this.#runControllers.get(request.runId);

          if (!runController) {
            return false;
          }

          const response = await runController.publish(
            "WORKFLOW_RUN_COMPLETE",
            {
              output: request.output,
            }
          );

          return !!response;
        },
        INITIALIZE_HOST: async (data) => {
          // Initialize workflow
          const response = await this.#initializeWorkflow(data);

          if (response) {
            return { type: "success" as const };
          } else {
            return {
              type: "error" as const,
              message: "Failed to connect to the Pulsar cluster",
            };
          }
        },
        INITIALIZE_HOST_V2: async (data) => {
          // Initialize workflow
          const response = await this.#initializeWorkflow(data);

          if (response) {
            return { type: "success" as const, data: response };
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
      this.#logger.debug(
        "Client not authenticated, sending unauthorized error",
        {
          error,
        }
      );

      this.#socket.close(
        4001,
        "Could not authenticate to the server because the API key is invalid"
      );
    }
  }

  async #initializeWorkflow(
    data: z.infer<(typeof ServerRPCSchema)["INITIALIZE_HOST_V2"]["request"]>
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
        triggerTTL: data.triggerTTL,
        metadata: data.metadata ? JSON.stringify(data.metadata) : undefined,
      });

      this.#workflowId = response.workflow.id;

      this.#logger.debug("Initializing trigger subscriber...");

      this.#triggerSubscriber = new ZodSubscriber({
        schema: triggerCatalog,
        client: pulsarClient,
        config: {
          topic: Topics.triggers,
          subscription: `websocketserver-${this.#workflowId}-${this.#apiKey}`,
          subscriptionType: "Shared",
          subscriptionInitialPosition: "Latest",
        },
        handlers: {
          TRIGGER_WORKFLOW: async (id, data, properties, messageAttributes) => {
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

            if (!this.#serverRPC) {
              throw new Error(
                "Cannot trigger workflow without an RPC connection"
              );
            }

            if (!this.#commandPublisher) {
              throw new Error(
                "Cannot trigger workflow without a trigger publisher"
              );
            }

            const runAttempt =
              typeof properties["x-attempt"] === "string"
                ? Number(properties["x-attempt"])
                : 0;

            if (
              properties["x-ttl"] &&
              messageAttributes.eventTimestamp &&
              runAttempt === 0
            ) {
              const ttl = properties["x-ttl"];
              const eventTimestamp = messageAttributes.eventTimestamp;
              const now = Date.now();
              const elapsedMilliseconds = now - eventTimestamp.getTime();
              const elapsedSeconds = elapsedMilliseconds / 1000;

              if (elapsedSeconds > ttl) {
                this.#logger.debug("Message is expired, ignoring", {
                  messageAttributes,
                  properties,
                });

                await this.#commandPublisher.publish(
                  "WORKFLOW_RUN_TRIGGER_TIMEOUT",
                  {
                    id: data.id,
                    ttl,
                    elapsedSeconds,
                  },
                  { ...properties, "x-timestamp": String(Date.now()) }
                );

                return true;
              }
            }

            this.#logger.debug("Triggering workflow", data, properties);

            const runController = new WorkflowRunController({
              runId: data.id,
              hostRPC: this.#serverRPC,
              publisher: this.#commandPublisher,
              metadata: {
                workflowId: properties["x-workflow-id"],
                organizationId: properties["x-org-id"],
                environment: properties["x-env"],
                apiKey: properties["x-api-key"],
                appOrigin: properties["x-app-origin"],
                isTest:
                  typeof properties["x-is-test"] === "string"
                    ? properties["x-is-test"] === "true"
                    : false,
                attempt:
                  typeof properties["x-attempt"] === "string"
                    ? Number(properties["x-attempt"])
                    : 0,
              },
            });

            // Make sure this is set before calling initialize
            this.#runControllers.set(data.id, runController);

            // Send the trigger to the host machine
            const result = await runController.initialize(
              data.input,
              data.context
            );

            if (!result) {
              this.#runControllers.delete(data.id);
            }

            return result;
          },
        },
      });

      const result = await this.#triggerSubscriber.initialize();

      if (!result) {
        this.#logger.debug("Platform subscriber failed to initialize");
        return false;
      }

      this.#logger.info("Platform subscriber initialized");

      this.#isInitialized = true;

      return response;
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
    this.#logger.debug(
      "Closing run controllers...",
      Array.from(this.#runControllers.keys())
    );

    // Close all the run controllers in a Promise.all
    await Promise.all(
      Array.from(this.#runControllers.values()).map((controller) =>
        controller.close()
      )
    );

    // Clear the run controllers
    this.#runControllers.clear();

    if (this.#triggerSubscriber) {
      this.#logger.debug("Closing trigger subscriber...");

      await this.#triggerSubscriber.close();
    }

    this.#triggerSubscriber = undefined;
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
