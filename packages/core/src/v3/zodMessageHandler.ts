import { z } from "zod";
import { StructuredLogger } from "./utils/structuredLogger.js";

export class ZodSchemaParsedError extends Error {
  constructor(
    public error: z.ZodError,
    public payload: unknown
  ) {
    super(error.message);
  }
}

export type ZodMessageValueSchema<TDiscriminatedUnion extends z.ZodDiscriminatedUnion<any, any>> =
  | z.ZodFirstPartySchemaTypes
  | TDiscriminatedUnion;

export interface ZodMessageCatalogSchema {
  [key: string]: ZodMessageValueSchema<any>;
}

export type ZodMessageHandlers<TCatalogSchema extends ZodMessageCatalogSchema> = Partial<{
  [K in keyof TCatalogSchema]: (payload: z.infer<TCatalogSchema[K]>) => Promise<any>;
}>;

export type ZodMessageHandlerOptions<TMessageCatalog extends ZodMessageCatalogSchema> = {
  schema: TMessageCatalog;
  messages?: ZodMessageHandlers<TMessageCatalog>;
  logger?: StructuredLogger;
};

export type MessageFromSchema<
  K extends keyof TMessageCatalog,
  TMessageCatalog extends ZodMessageCatalogSchema,
> = {
  type: K;
  payload: z.input<TMessageCatalog[K]>;
};

export type MessagePayloadFromSchema<
  K extends keyof TMessageCatalog,
  TMessageCatalog extends ZodMessageCatalogSchema,
> = z.output<TMessageCatalog[K]>;

export type MessageFromCatalog<TMessageCatalog extends ZodMessageCatalogSchema> = {
  [K in keyof TMessageCatalog]: MessageFromSchema<K, TMessageCatalog>;
}[keyof TMessageCatalog];

export const ZodMessageSchema = z.object({
  version: z.literal("v1").default("v1"),
  type: z.string(),
  payload: z.unknown(),
});

export interface EventEmitterLike {
  on(eventName: string | symbol, listener: (...args: any[]) => void): this;
}

export class ZodMessageHandler<TMessageCatalog extends ZodMessageCatalogSchema> {
  #schema: TMessageCatalog;
  #handlers: ZodMessageHandlers<TMessageCatalog> | undefined;
  #logger: StructuredLogger | Console;

  constructor(options: ZodMessageHandlerOptions<TMessageCatalog>) {
    this.#schema = options.schema;
    this.#handlers = options.messages;
    this.#logger = options.logger ?? console;
  }

  public async handleMessage(message: unknown): Promise<
    | {
        success: true;
        data: unknown;
      }
    | {
        success: false;
        error: string;
      }
  > {
    const parsedMessage = this.parseMessage(message);

    if (!parsedMessage.success) {
      this.#logger.error(parsedMessage.error, { message });

      return {
        success: false,
        error: parsedMessage.error,
      };
    }

    if (!this.#handlers) {
      this.#logger.error("No handlers provided", { message });

      return {
        success: false,
        error: "No handlers provided",
      };
    }

    const handler = this.#handlers[parsedMessage.data.type];

    if (!handler) {
      const error = `No handler for message type: ${String(parsedMessage.data.type)}`;

      this.#logger.error(error, { message });

      return {
        success: false,
        error,
      };
    }

    const ack = await handler(parsedMessage.data.payload);

    return {
      success: true,
      data: ack,
    };
  }

  public parseMessage(message: unknown):
    | {
        success: true;
        data: MessageFromCatalog<TMessageCatalog>;
      }
    | {
        success: false;
        error: string;
      } {
    const parsedMessage = ZodMessageSchema.safeParse(message);

    if (!parsedMessage.success) {
      return {
        success: false,
        error: `Failed to parse message: ${JSON.stringify(parsedMessage.error)}`,
      };
    }

    const schema = this.#schema[parsedMessage.data.type];

    if (!schema) {
      return {
        success: false,
        error: `Unknown message type: ${parsedMessage.data.type}`,
      };
    }

    const parsedPayload = schema.safeParse(parsedMessage.data.payload);

    if (!parsedPayload.success) {
      return {
        success: false,
        error: `Failed to parse message payload: ${JSON.stringify(parsedPayload.error)}`,
      };
    }

    return {
      success: true,
      data: {
        type: parsedMessage.data.type,
        payload: parsedPayload.data,
      },
    };
  }

  public registerHandlers(emitter: EventEmitterLike, logger?: StructuredLogger) {
    const log = logger ?? console;

    if (!this.#handlers) {
      log.info("No handlers provided");
      return;
    }

    for (const eventName of Object.keys(this.#schema)) {
      emitter.on(eventName, async (message: any, callback?: any): Promise<void> => {
        log.info(`handling ${eventName}`, {
          payload: message,
          hasCallback: !!callback,
        });

        let ack: Awaited<ReturnType<ZodMessageHandler<TMessageCatalog>["handleMessage"]>>;

        // Use runtime validation to detect payload presence
        const hasPayload =
          typeof message === "object" &&
          message !== null &&
          z.object({ payload: z.unknown() }).passthrough().safeParse(message).success;

        if (hasPayload) {
          ack = await this.handleMessage({ type: eventName, ...(message as any) });
        } else {
          // Handle messages not sent by ZodMessageSender
          const messageObj =
            typeof message === "object" && message !== null ? (message as any) : {};
          const { version, ...payload } = messageObj;
          ack = await this.handleMessage({ type: eventName, version, payload });
        }

        if (callback && typeof callback === "function") {
          if (!ack.success) {
            // We don't know the callback type, so we can't do anything else - not all callbacks may accept a success prop
            log.error("Failed to handle message, skipping callback", { message, error: ack.error });
            return;
          }

          callback(ack.data);
        }
      });
    }
  }
}

export function parseMessageFromCatalog<TMessageCatalog extends ZodMessageCatalogSchema>(
  message: unknown,
  schema: TMessageCatalog
): MessageFromCatalog<TMessageCatalog> {
  const parsedMessage = ZodMessageSchema.safeParse(message);

  if (!parsedMessage.success) {
    throw new Error(`Failed to parse message: ${JSON.stringify(parsedMessage.error)}`);
  }

  const messageSchema = schema[parsedMessage.data.type];

  if (!messageSchema) {
    throw new Error(`Unknown message type: ${parsedMessage.data.type}`);
  }

  const parsedPayload = messageSchema.safeParse(parsedMessage.data.payload);

  if (!parsedPayload.success) {
    throw new Error(`Failed to parse message payload: ${JSON.stringify(parsedPayload.error)}`);
  }

  return {
    type: parsedMessage.data.type,
    payload: parsedPayload.data,
  };
}

type ZodMessageSenderCallback<TMessageCatalog extends ZodMessageCatalogSchema> = (message: {
  type: keyof TMessageCatalog;
  payload: z.infer<TMessageCatalog[keyof TMessageCatalog]>;
  version: "v1";
}) => Promise<void>;

export type ZodMessageSenderOptions<TMessageCatalog extends ZodMessageCatalogSchema> = {
  schema: TMessageCatalog;
  sender: ZodMessageSenderCallback<TMessageCatalog>;
  canSendMessage?: () => Promise<boolean> | boolean;
};

export class ZodMessageSender<TMessageCatalog extends ZodMessageCatalogSchema> {
  #schema: TMessageCatalog;
  #sender: ZodMessageSenderCallback<TMessageCatalog>;
  #canSendMessage?: ZodMessageSenderOptions<TMessageCatalog>["canSendMessage"];

  constructor(options: ZodMessageSenderOptions<TMessageCatalog>) {
    this.#schema = options.schema;
    this.#sender = options.sender;
    this.#canSendMessage = options.canSendMessage;
  }

  public async validateCanSendMessage(): Promise<boolean> {
    if (!this.#canSendMessage) {
      return true;
    }
    return await this.#canSendMessage();
  }

  public async send<K extends keyof TMessageCatalog>(
    type: K,
    payload: z.input<TMessageCatalog[K]>
  ) {
    const schema = this.#schema[type];

    if (!schema) {
      throw new Error(`Unknown message type: ${type as string}`);
    }

    const parsedPayload = schema.safeParse(payload);

    if (!parsedPayload.success) {
      throw new ZodSchemaParsedError(parsedPayload.error, payload);
    }

    try {
      await this.#sender({ type, payload, version: "v1" });
    } catch (error) {
      console.error("[ZodMessageSender] Failed to send message", error);
    }
  }

  public async forwardMessage(message: unknown) {
    const parsedMessage = ZodMessageSchema.safeParse(message);

    if (!parsedMessage.success) {
      throw new Error(`Failed to parse message: ${JSON.stringify(parsedMessage.error)}`);
    }

    const schema = this.#schema[parsedMessage.data.type];

    if (!schema) {
      throw new Error(`Unknown message type: ${parsedMessage.data.type}`);
    }

    const parsedPayload = schema.safeParse(parsedMessage.data.payload);

    if (!parsedPayload.success) {
      throw new Error(`Failed to parse message payload: ${JSON.stringify(parsedPayload.error)}`);
    }

    try {
      await this.#sender({
        type: parsedMessage.data.type,
        payload: parsedPayload.data,
        version: "v1",
      });
    } catch (error) {
      console.error("[ZodMessageSender] Failed to forward message", error);
    }
  }
}

export async function sendMessageInCatalog<TMessageCatalog extends ZodMessageCatalogSchema>(
  catalog: TMessageCatalog,
  type: keyof TMessageCatalog,
  payload: z.input<TMessageCatalog[keyof TMessageCatalog]>,
  sender: ZodMessageSenderCallback<TMessageCatalog>
) {
  const schema = catalog[type];

  if (!schema) {
    throw new Error(`Unknown message type: ${type as string}`);
  }

  const parsedPayload = schema.safeParse(payload);

  if (!parsedPayload.success) {
    throw new ZodSchemaParsedError(parsedPayload.error, payload);
  }

  await sender({ type, payload, version: "v1" });
}

export type MessageCatalogToSocketIoEvents<TCatalog extends ZodMessageCatalogSchema> = {
  [K in keyof TCatalog]: (message: z.infer<TCatalog[K]>) => void;
};
