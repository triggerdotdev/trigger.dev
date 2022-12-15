import {
  Client as PulsarClient,
  Producer as PulsarProducer,
  ProducerConfig as PulsarPublisherConfig,
} from "pulsar-client";
import { Logger } from "../logger";
import { MessageCatalogSchema } from "./messageCatalogSchema";

import { z } from "zod";

export type ZodPublisherOptions<PublisherSchema extends MessageCatalogSchema> =
  {
    client: PulsarClient;
    publisherConfig: PulsarPublisherConfig;
    publisherSchema: PublisherSchema;
  };

export class ZodPublisher<PublisherSchema extends MessageCatalogSchema> {
  #publisherConfig: PulsarPublisherConfig;
  #publisherSchema: PublisherSchema;
  #publisher?: PulsarProducer;
  #client: PulsarClient;

  #logger: Logger;

  constructor(options: ZodPublisherOptions<PublisherSchema>) {
    this.#publisherConfig = options.publisherConfig;
    this.#publisherSchema = options.publisherSchema;
    this.#client = options.client;
    this.#logger = new Logger("trigger.dev publisher", "info");
  }

  public async initialize(): Promise<boolean> {
    try {
      this.#logger.debug(
        `Initializing publisher with config ${JSON.stringify(
          this.#publisherConfig
        )}`
      );

      this.#publisher = await this.#client.createProducer(
        this.#publisherConfig
      );

      return true;
    } catch (e) {
      this.#logger.error("Error initializing publisher", e);

      return false;
    }
  }

  public async close() {
    if (this.#publisher) {
      await this.#publisher.close();
      this.#publisher = undefined;
    }
  }

  public async publish<K extends keyof PublisherSchema>(
    id: string,
    type: K,
    data: z.infer<PublisherSchema[K]["data"]>,
    properties?: z.infer<PublisherSchema[K]["properties"]>
  ): Promise<string> {
    if (!this.#publisher) {
      throw new Error("Cannot publish before establishing connection");
    }

    const message = JSON.stringify({
      id,
      type,
      data,
    });

    const response = await this.#publisher.send({
      data: Buffer.from(message),
      properties,
    });

    return response.toString();
  }
}
