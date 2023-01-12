import {
  HostRPCSchema,
  Logger,
  ServerRPCSchema,
  ZodRPC,
} from "internal-bridge";
import {
  CommandCatalog,
  commandResponseCatalog,
  CommandResponseCatalog,
  ZodPublisher,
  ZodSubscriber,
} from "internal-platform";
import { Topics } from "./pulsarClient";
import { z } from "zod";
import { pulsarClient } from "./pulsarClient";

export type WorkflowRunControllerOptions = {
  hostRPC: ZodRPC<typeof HostRPCSchema, typeof ServerRPCSchema>;
  publisher: ZodPublisher<CommandCatalog>;
  runId: string;
  metadata: {
    workflowId: string;
    environment: string;
    apiKey: string;
    organizationId: string;
  };
};

export class WorkflowRunController {
  #runId: string;
  #hostRPC: ZodRPC<typeof HostRPCSchema, typeof ServerRPCSchema>;
  #publisher: ZodPublisher<CommandCatalog>;
  #commandResponseSubscriber: ZodSubscriber<CommandResponseCatalog>;
  #metadata: {
    workflowId: string;
    environment: string;
    apiKey: string;
    organizationId: string;
  };

  #logger: Logger;

  constructor(options: WorkflowRunControllerOptions) {
    this.#runId = options.runId;
    this.#hostRPC = options.hostRPC;
    this.#publisher = options.publisher;
    this.#metadata = options.metadata;
    this.#logger = new Logger(`trigger.dev [run=${this.#runId}]`);

    this.#commandResponseSubscriber = new ZodSubscriber({
      schema: commandResponseCatalog,
      client: pulsarClient,
      config: {
        topic: Topics.runCommandResponses,
        subscription: `websocketserver-run-${this.#runId}`,
        subscriptionType: "Exclusive",
        subscriptionInitialPosition: "Latest",
      },
      handlers: {
        RESOLVE_DELAY: async (id, data, properties) => {
          if (properties["x-workflow-run-id"] !== this.#runId) {
            return true;
          }

          this.#logger.debug(
            "Received resolve delay request",
            id,
            data,
            properties
          );

          const success = await this.#hostRPC.send("RESOLVE_DELAY", {
            id: data.id,
            key: data.key,
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
        RESOLVE_INTEGRATION_REQUEST: async (id, data, properties) => {
          if (properties["x-workflow-run-id"] !== this.#runId) {
            return true;
          }

          this.#logger.debug(
            "Received resolve integration request",
            id,
            data,
            properties
          );

          const success = await this.#hostRPC.send("RESOLVE_REQUEST", {
            id: data.id,
            output: data.output,
            key: data.key,
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
        REJECT_INTEGRATION_REQUEST: async (id, data, properties) => {
          if (properties["x-workflow-run-id"] !== this.#runId) {
            return true;
          }

          this.#logger.debug(
            "Received reject integration request",
            id,
            data,
            properties
          );

          const success = await this.#hostRPC.send("REJECT_REQUEST", {
            id: data.id,
            key: data.key,
            error: data.error,
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
      },
    });
  }

  async initialize(input: any, context: any) {
    await this.#commandResponseSubscriber.initialize();

    return this.#hostRPC.send("TRIGGER_WORKFLOW", {
      id: this.#runId,
      trigger: { input, context },
      meta: this.#metadata,
    });
  }

  async close() {
    await this.#commandResponseSubscriber.close();

    await this.publish("WORKFLOW_RUN_DISCONNECTED", {
      id: this.#runId,
    });

    this.#logger.debug("Workflow run closed");
  }

  async publish<TEventName extends keyof CommandCatalog>(
    eventName: TEventName,
    data: z.infer<CommandCatalog[TEventName]["data"]>,
    timestamp: number = Date.now()
  ) {
    this.#logger.debug(`Publishing command ${eventName} with data`, data);

    const properties = {
      ...this.#publishProperties,
      "x-timestamp": String(timestamp),
    };

    return this.#publisher.publish(eventName, data, properties, {
      orderingKey: this.#runId,
      partitionKey: this.#runId,
    });
  }

  get #publishProperties() {
    return {
      "x-workflow-id": this.#metadata.workflowId,
      "x-api-key": this.#metadata.apiKey,
      "x-workflow-run-id": this.#runId,
    };
  }
}
