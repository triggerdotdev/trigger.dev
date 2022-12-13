import {
  Producer as PulsarProducer,
  Consumer as PulsarConsumer,
  Message as PulsarMessage,
} from "pulsar-client";
import { pulsarClient } from "./pulsarClient";

import type { MetadataMessages, WorkflowMetadata } from "internal-messages";
export type { WorkflowMetadata };
import { z } from "zod";
import { Logger } from "internal-bridge/logger";

export type WorkflowMessageBrokerConfig = {
  id: string;
  orgId: string;
};

export class WorkflowMessageBroker {
  #workflowsMetaProducer?: PulsarProducer;
  #workflowsTriggersConsumer?: PulsarConsumer;
  #config: WorkflowMessageBrokerConfig;
  #logger: Logger;

  constructor(config: WorkflowMessageBrokerConfig) {
    this.#config = config;
    this.#logger = new Logger(`trigger.dev org=${this.#config.orgId}`, "info");
  }

  async initialize(data: WorkflowMetadata) {
    this.#logger.debug("Creating workflows-meta producer");

    // workflows-meta is a topic that is used to send metadata about the workflow to the platform
    this.#workflowsMetaProducer = await pulsarClient.createProducer({
      topic: "workflows-meta",
    });

    this.#logger.debug(`Creating ${this.#workflowTriggerTopic} consumer`);

    // workflows-triggers is a topic that is used to send triggers to the workflow, scoped to the orgId and workflowId
    this.#workflowsTriggersConsumer = await pulsarClient.subscribe({
      topic: this.#workflowTriggerTopic,
      subscription: `message-broker`,
      subscriptionType: "Shared",
      ackTimeoutMs: 30000,
      listener: async (msg, consumer) => {
        await this.#receiveTrigger(msg, consumer);
      },
    });

    await this.#sendMetadata("INITIALIZE_WORKFLOW", data);
  }

  async close() {
    this.#logger.debug("Closing workflows-meta producer");

    if (this.#workflowsMetaProducer) {
      await this.#workflowsMetaProducer.close();
    }

    this.#logger.debug("Closing workflows-triggers consumer");

    if (this.#workflowsTriggersConsumer) {
      await this.#workflowsTriggersConsumer.close();
    }
  }

  async #receiveTrigger(msg: PulsarMessage, consumer: PulsarConsumer) {
    const data = JSON.parse(msg.getData().toString());

    console.log("Received trigger", data);

    await consumer.acknowledge(msg);
  }

  async #sendMetadata<K extends keyof MetadataMessages>(
    type: K,
    data: z.infer<MetadataMessages[K]["data"]>
  ) {
    if (!this.#workflowsMetaProducer) {
      throw new Error("Cannot send message without a producer");
    }

    this.#logger.debug("Sending metadata message", type, data);

    await this.#workflowsMetaProducer.send({
      data: Buffer.from(
        JSON.stringify({
          type,
          data,
        })
      ),
      properties: {
        "x-workflow-id": this.#config.id,
        "x-org-id": this.#config.orgId,
      },
    });
  }

  get #workflowTriggerTopic() {
    return `workflows-triggers-${this.#config.orgId}-${this.#config.id}`;
  }
}
