import { Logger } from "@trigger.dev/core/logger";
import { ZodMessageCatalogSchema, ZodMessageHandler } from "@trigger.dev/core/v3/zodMessageHandler";
import { Evt } from "evt";
import { z } from "zod";
import { createRedisClient, RedisClient, RedisWithClusterOptions } from "~/redis.server";
import { logger } from "~/services/logger.server";
import { safeJsonParse } from "~/utils/json";

export type ZodPubSubOptions<TMessageCatalog extends ZodMessageCatalogSchema> = {
  redis: RedisWithClusterOptions;
  schema: TMessageCatalog;
};

export interface ZodSubscriber<TMessageCatalog extends ZodMessageCatalogSchema> {
  on<K extends keyof TMessageCatalog>(
    eventName: K,
    listener: (payload: z.infer<TMessageCatalog[K]>) => Promise<void>
  ): void;

  stopListening(): Promise<void>;
}

class RedisZodSubscriber<TMessageCatalog extends ZodMessageCatalogSchema>
  implements ZodSubscriber<TMessageCatalog>
{
  private _subscriber: RedisClient;
  private _listeners: Map<string, (payload: unknown) => Promise<void>> = new Map();
  private _messageHandler: ZodMessageHandler<TMessageCatalog>;

  public onUnsubscribed: Evt<{
    pattern: string;
  }> = new Evt();

  constructor(
    private readonly _pattern: string,
    private readonly _options: ZodPubSubOptions<TMessageCatalog>,
    private readonly _logger: Logger
  ) {
    this._subscriber = createRedisClient("trigger:zodSubscriber", _options.redis);
    this._messageHandler = new ZodMessageHandler({
      schema: _options.schema,
      logger: this._logger,
    });
  }

  async initialize() {
    await this._subscriber.psubscribe(this._pattern);
    this._subscriber.on("pmessage", this.#onMessage.bind(this));
  }

  public on<K extends keyof TMessageCatalog>(
    eventName: K,
    listener: (payload: z.infer<TMessageCatalog[K]>) => Promise<void>
  ): void {
    this._listeners.set(eventName as string, listener);
  }

  public async stopListening(): Promise<void> {
    this._listeners.clear();
    await this._subscriber.punsubscribe();

    this.onUnsubscribed.post({ pattern: this._pattern });

    this._subscriber.quit();
  }

  async #onMessage(pattern: string, channel: string, serializedMessage: string) {
    if (pattern !== this._pattern) {
      return;
    }

    const parsedMessage = safeJsonParse(serializedMessage);

    if (!parsedMessage) {
      return;
    }

    const message = this._messageHandler.parseMessage(parsedMessage);

    if (!message.success) {
      this._logger.error(`Failed to parse message: ${message.error}`, { parsedMessage });
      return;
    }

    if (typeof message.data.type !== "string") {
      this._logger.error(`Failed to parse message: invalid type`, { parsedMessage });
      return;
    }

    const listener = this._listeners.get(message.data.type);

    if (!listener) {
      this._logger.debug(`No listener for message type: ${message.data.type}`, { parsedMessage });

      return;
    }

    try {
      await listener(message.data.payload);
    } catch (error) {
      this._logger.error("Error handling message", { error, message });
    }
  }
}

export class ZodPubSub<TMessageCatalog extends ZodMessageCatalogSchema> {
  private _publisher: RedisClient;
  private _logger = logger.child({ module: "ZodPubSub" });
  private _subscriberCount = 0;

  get subscriberCount() {
    return this._subscriberCount;
  }

  constructor(private _options: ZodPubSubOptions<TMessageCatalog>) {
    this._publisher = createRedisClient("trigger:zodSubscriber", _options.redis);
  }

  get redisOptions() {
    return this._options.redis;
  }

  public async publish<K extends keyof TMessageCatalog>(
    channel: string,
    type: K,
    payload: z.input<TMessageCatalog[K]>
  ): Promise<void> {
    try {
      await this._publisher.publish(channel, JSON.stringify({ type, payload, version: "v1" }));
    } catch (e) {
      logger.error("Failed to publish message", { channel, type, payload, error: e });
    }
  }

  public async subscribe(channel: string): Promise<ZodSubscriber<TMessageCatalog>> {
    const subscriber = new RedisZodSubscriber(channel, this._options, this._logger);

    await subscriber.initialize();

    this._subscriberCount++;

    subscriber.onUnsubscribed.attachOnce(({ pattern }) => {
      logger.debug("Subscriber unsubscribed", { pattern });

      this._subscriberCount--;
    });

    return subscriber;
  }
}
