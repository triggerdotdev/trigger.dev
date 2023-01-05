import {
  HostRPCSchema,
  Logger,
  ServerRPCSchema,
  ZodRPC,
} from "internal-bridge";
import {
  CoordinatorCatalog,
  platformCatalog,
  PlatformCatalog,
  ZodPublisher,
  ZodSubscriber,
} from "internal-platform";
import { z } from "zod";
import { pulsarClient } from "./pulsarClient";

export type WorkflowRunControllerOptions = {
  hostRPC: ZodRPC<typeof HostRPCSchema, typeof ServerRPCSchema>;
  publisher: ZodPublisher<CoordinatorCatalog>;
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
  #publisher: ZodPublisher<CoordinatorCatalog>;
  #subscriber: ZodSubscriber<Omit<PlatformCatalog, "TRIGGER_WORKFLOW">>;
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
    this.#logger = new Logger(`trigger.dev [run=${this.#runId}]`, "debug");

    this.#subscriber = new ZodSubscriber({
      schema: omit(platformCatalog, ["TRIGGER_WORKFLOW"]),
      client: pulsarClient,
      config: {
        topic: `persistent://public/default/workflow-runs-${this.#runId}`,
        subscription: `run-controller`,
        subscriptionType: "Exclusive",
        subscriptionInitialPosition: "Latest",
      },
      handlers: {
        RESOLVE_DELAY: async (id, data, properties) => {
          this.#logger.debug(
            "Received resolve delay request",
            id,
            data,
            properties
          );

          if (properties["x-workflow-run-id"] !== this.#runId) {
            return true;
          }

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
          this.#logger.debug(
            "Received resolve integration request",
            id,
            data,
            properties
          );

          if (properties["x-workflow-run-id"] !== this.#runId) {
            return true;
          }

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
          this.#logger.debug(
            "Received reject integration request",
            id,
            data,
            properties
          );

          if (properties["x-workflow-run-id"] !== this.#runId) {
            return true;
          }

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
    await this.#subscriber.initialize();

    return this.#hostRPC.send("TRIGGER_WORKFLOW", {
      id: this.#runId,
      trigger: { input, context },
      meta: this.#metadata,
    });
  }

  async close() {
    await this.#subscriber.close();

    await this.#publisher.publish(
      "WORKFLOW_RUN_DISCONNECTED",
      {
        id: this.#runId,
      },
      this.#publishProperties,
      { partitionKey: this.#runId }
    );

    this.#logger.debug("Workflow run closed");
  }

  async publish<TEventName extends keyof CoordinatorCatalog>(
    eventName: TEventName,
    data: z.infer<CoordinatorCatalog[TEventName]["data"]>
  ) {
    this.#logger.debug(`Publishing event ${eventName} with data`, data);

    return this.#publisher.publish(eventName, data, this.#publishProperties, {
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

function omit<T extends Record<string, any>, K extends keyof T>(
  obj: T,
  keys: K[]
): Omit<T, K> {
  const result: any = {};
  for (const key in obj) {
    if (!keys.includes(key as any)) {
      result[key] = obj[key];
    }
  }
  return result;
}
