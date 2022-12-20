import {
  Client as PulsarClient,
  ConsumerConfig as PulsarConsumerConfig,
  ProducerConfig as PulsarPublisherConfig,
} from "pulsar-client";
import { MessageCatalogSchema } from "./messageCatalogSchema";

import { z } from "zod";
import { ZodPublisher } from "./zodPublisher";
import { ZodSubscriber, ZodSubscriberHandlers } from "./zodSubscriber";

export type ZodPubSubOptions<TPubSubSchema extends MessageCatalogSchema> = {
  client: PulsarClient;
  schema: TPubSubSchema;
  topic: string;
  publisherConfig: Omit<PulsarPublisherConfig, "topic">;
  subscriberConfig: Omit<PulsarConsumerConfig, "listener" | "topic">;

  handlers: ZodSubscriberHandlers<TPubSubSchema>;
};

export class ZodPubSub<TPubSubSchema extends MessageCatalogSchema> {
  #publisher: ZodPublisher<TPubSubSchema>;
  #subscriber: ZodSubscriber<TPubSubSchema>;
  #schema: TPubSubSchema;

  constructor(options: ZodPubSubOptions<TPubSubSchema>) {
    this.#publisher = new ZodPublisher({
      client: options.client,
      config: { ...options.publisherConfig, topic: options.topic },
      schema: options.schema,
    });

    this.#subscriber = new ZodSubscriber({
      client: options.client,
      config: { ...options.subscriberConfig, topic: options.topic },
      schema: options.schema,
      handlers: options.handlers,
    });

    this.#schema = options.schema;
  }

  public async initialize(): Promise<boolean> {
    const publisherInitialized = await this.#publisher.initialize();

    if (!publisherInitialized) {
      return false;
    }

    const subscriberInitialized = await this.#subscriber.initialize();

    if (!subscriberInitialized) {
      return false;
    }

    return true;
  }

  public async close() {
    await this.#publisher.close();
    await this.#subscriber.close();
  }

  public async publish<K extends keyof TPubSubSchema>(
    type: K,
    data: z.infer<TPubSubSchema[K]["data"]>,
    properties?: z.infer<TPubSubSchema[K]["properties"]>
  ): Promise<string | undefined> {
    return this.#publisher.publish(type, data, properties);
  }
}
