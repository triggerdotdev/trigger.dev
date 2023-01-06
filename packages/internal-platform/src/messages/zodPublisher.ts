import {
  PulsarClient,
  PulsarProducer,
  PulsarProducerConfig,
} from "internal-pulsar";
import { Logger } from "../logger";
import { MessageCatalogSchema } from "./messageCatalogSchema";
import { ulid } from "ulid";

import { z, ZodError } from "zod";

export type PublishOptions = {
  deliverAfter?: number;
  deliverAt?: number;
  partitionKey?: string;
  orderingKey?: string;
};

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

  #logger: Logger;

  constructor(options: ZodPublisherOptions<PublisherSchema>) {
    this.#config = options.config;
    this.#schema = options.schema;
    this.#client = options.client;
    this.#logger = new Logger("trigger.dev publisher");
  }

  public async initialize(): Promise<boolean> {
    try {
      this.#logger.debug(
        `Initializing publisher with config ${JSON.stringify(this.#config)}`
      );

      this.#producer = await this.#client.createProducer(this.#config);

      return true;
    } catch (e) {
      this.#logger.error("Error initializing publisher", e);

      return false;
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
      throw new Error("Cannot publish before establishing connection");
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

    const id = ulid();

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

    this.#logger.debug("Publishing message", message);

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
