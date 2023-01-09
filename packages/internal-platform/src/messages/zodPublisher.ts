import {
  PulsarClient,
  PulsarProducer,
  PulsarProducerConfig,
} from "internal-pulsar";
import { Logger } from "../logger";
import { MessageCatalogSchema } from "./messageCatalogSchema";
import { ulid } from "ulid";

import { z, ZodError } from "zod";
import { ZodPubSubStatus } from "./types";

export type PublishOptions = {
  deliverAfter?: number;
  deliverAt?: number;
  partitionKey?: string;
  orderingKey?: string;
  id?: string;
};

type PendingMessages<PublisherSchema extends MessageCatalogSchema> = Array<{
  type: keyof PublisherSchema;
  data: z.infer<PublisherSchema[keyof PublisherSchema]["data"]>;
  properties?: z.infer<PublisherSchema[keyof PublisherSchema]["properties"]>;
  options: PublishOptions;
}>;

export type ZodPublisherOptions<PublisherSchema extends MessageCatalogSchema> =
  {
    client: PulsarClient;
    config: PulsarProducerConfig;
    schema: PublisherSchema;
  };

export class ZodPublisher<PublisherSchema extends MessageCatalogSchema> {
  #config: PulsarProducerConfig;
  #schema: PublisherSchema;
  #producer?: PulsarProducer;
  #client: PulsarClient;
  #status: ZodPubSubStatus = "waitingToConnect";
  #logger: Logger;
  #pendingMessages: PendingMessages<PublisherSchema> = [];

  constructor(options: ZodPublisherOptions<PublisherSchema>) {
    this.#config = options.config;
    this.#schema = options.schema;
    this.#client = options.client;
    this.#logger = new Logger("trigger.dev publisher");
  }

  public async initialize(): Promise<boolean> {
    if (this.#status !== "waitingToConnect") {
      return this.#status === "ready";
    }

    this.#status = "initializing";

    try {
      this.#logger.debug(
        `Initializing publisher with config ${JSON.stringify(this.#config)}`
      );

      this.#producer = await this.#client.createProducer(this.#config);

      this.#status = "ready";

      await this.#flushPendingMessages();

      return true;
    } catch (e) {
      this.#logger.error("Error initializing publisher", e);

      this.#status = "error";

      return false;
    }
  }

  async #flushPendingMessages() {
    if (this.#pendingMessages.length === 0) {
      return;
    }

    this.#logger.debug(
      `Publishing ${this.#pendingMessages.length} pending messages`
    );

    // Publish messages and remove them from #pendingMessages one at a time
    // so that if one fails, the rest will still be published
    for (let i = 0; i < this.#pendingMessages.length; i++) {
      const message = this.#pendingMessages[i];

      try {
        await this.publish(
          message.type,
          message.data,
          message.properties,
          message.options
        );
      } catch (error) {
        // If the publish fails, we don't want to remove the message from the array
        // So we just continue to the next iteration of the loop
        continue;
      }

      // If the publish was successful, we can remove the message from the array
      this.#pendingMessages.splice(i, 1);
      // Decrementing `i` here to account for the removed element
      if (i > 0) i--;
    }

    if (this.#pendingMessages.length > 0) {
      this.#logger.warn(
        `Failed to publish ${this.#pendingMessages.length} pending messages`
      );
    }
  }

  public async close() {
    if (this.#producer && this.#producer.isConnected()) {
      await this.#producer.close();
      this.#producer = undefined;
    }
  }

  public async publish<K extends keyof PublisherSchema>(
    type: K,
    data: z.infer<PublisherSchema[K]["data"]>,
    properties?: z.infer<PublisherSchema[K]["properties"]>,
    options?: PublishOptions
  ): Promise<string | undefined> {
    if (!this.#producer) {
      if (
        this.#status === "waitingToConnect" ||
        this.#status === "initializing"
      ) {
        const id = ulid();

        this.#logger.info(
          "Message published before connection, adding it to pending messages",
          {
            type,
            data,
            properties,
            id,
          }
        );

        this.#pendingMessages.push({
          type,
          data,
          properties,
          options: { id, ...(options ?? {}) },
        });

        return id;
      } else {
        throw new Error(
          `Cannot publish to ${
            this.#config.topic
          } because it is not connected and is in status ${this.#status}`
        );
      }
    }

    try {
      return this.#handlePublish(type, data, properties, options);
    } catch (e) {
      if (e instanceof ZodError) {
        this.#logger.error(
          "[ZodPublisher] Could not publish invalid message data or properties",
          data,
          properties
        );
      } else {
        this.#logger.error("[ZodPublisher] Error handling message", e);
      }
    }
  }

  async #handlePublish<K extends keyof PublisherSchema>(
    type: K,
    data: z.infer<PublisherSchema[K]["data"]>,
    properties?: z.infer<PublisherSchema[K]["properties"]>,
    options?: PublishOptions
  ): Promise<string> {
    const messageSchema = this.#schema[type];

    if (!messageSchema) {
      throw new Error(`Unknown message type: ${String(type)}`);
    }

    const id = (options ?? {}).id ?? ulid();

    this.#logger.debug("Publishing message", {
      topic: this.#config.topic,
      type,
      data,
      properties,
      options,
    });

    const parsedData = messageSchema.data.parse(data);
    const parsedProperties = messageSchema.properties.parse(properties ?? {});

    const message = JSON.stringify({
      id,
      type,
      data: parsedData,
    });

    const response = await this.#producer!.send({
      data: Buffer.from(message),
      properties: parsedProperties,
      deliverAfter: options?.deliverAfter,
      deliverAt: options?.deliverAt,
      partitionKey: options?.partitionKey,
      orderingKey: options?.orderingKey,
    });

    return response.toString();
  }
}
