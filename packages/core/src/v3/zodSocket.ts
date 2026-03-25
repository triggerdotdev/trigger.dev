import type { ManagerOptions, Socket, SocketOptions } from "socket.io-client";
import { io } from "socket.io-client";
import { ZodError, z } from "zod";
import { EventEmitterLike, ZodMessageValueSchema } from "./zodMessageHandler.js";
import { LogLevel, SimpleStructuredLogger, StructuredLogger } from "./utils/structuredLogger.js";
import { fromZodError } from "zod-validation-error";

export interface ZodSocketMessageCatalogSchema {
  [key: string]:
    | {
        message: ZodMessageValueSchema<any>;
      }
    | {
        message: ZodMessageValueSchema<any>;
        callback?: ZodMessageValueSchema<any>;
      };
}

export type ZodMessageCatalogToSocketIoEvents<TCatalog extends ZodSocketMessageCatalogSchema> = {
  [K in keyof TCatalog]: SocketMessageHasCallback<TCatalog, K> extends true
    ? (
        message: z.infer<GetSocketMessageSchema<TCatalog, K>>,
        callback: (ack: z.infer<GetSocketCallbackSchema<TCatalog, K>>) => void
      ) => void
    : (message: z.infer<GetSocketMessageSchema<TCatalog, K>>) => void;
};

export type GetSocketMessageSchema<
  TRPCCatalog extends ZodSocketMessageCatalogSchema,
  TMessageType extends keyof TRPCCatalog,
> = TRPCCatalog[TMessageType]["message"];

export type InferSocketMessageSchema<
  TRPCCatalog extends ZodSocketMessageCatalogSchema,
  TMessageType extends keyof TRPCCatalog,
> = z.infer<GetSocketMessageSchema<TRPCCatalog, TMessageType>>;

export type GetSocketCallbackSchema<
  TRPCCatalog extends ZodSocketMessageCatalogSchema,
  TMessageType extends keyof TRPCCatalog,
> = TRPCCatalog[TMessageType] extends { callback: any }
  ? TRPCCatalog[TMessageType]["callback"]
  : never;

export type InferSocketCallbackSchema<
  TRPCCatalog extends ZodSocketMessageCatalogSchema,
  TMessageType extends keyof TRPCCatalog,
> = z.infer<GetSocketCallbackSchema<TRPCCatalog, TMessageType>>;

export type SocketMessageHasCallback<
  TRPCCatalog extends ZodSocketMessageCatalogSchema,
  TMessageType extends keyof TRPCCatalog,
> = GetSocketCallbackSchema<TRPCCatalog, TMessageType> extends never ? false : true;

export type ZodSocketMessageHandlers<TCatalogSchema extends ZodSocketMessageCatalogSchema> =
  Partial<{
    [K in keyof TCatalogSchema]: (
      payload: z.infer<GetSocketMessageSchema<TCatalogSchema, K>>
    ) => Promise<
      SocketMessageHasCallback<TCatalogSchema, K> extends true
        ? z.input<GetSocketCallbackSchema<TCatalogSchema, K>>
        : void
    >;
  }>;

export type ZodSocketMessageHandlerOptions<TMessageCatalog extends ZodSocketMessageCatalogSchema> =
  {
    schema: TMessageCatalog;
    handlers?: ZodSocketMessageHandlers<TMessageCatalog>;
    logger?: StructuredLogger;
    logPayloads?: boolean;
  };

type MessageFromSocketSchema<
  K extends keyof TMessageCatalog,
  TMessageCatalog extends ZodSocketMessageCatalogSchema,
> = {
  type: K;
  payload: z.input<GetSocketMessageSchema<TMessageCatalog, K>>;
};

export type MessagesFromSocketCatalog<TMessageCatalog extends ZodSocketMessageCatalogSchema> = {
  [K in keyof TMessageCatalog]: MessageFromSocketSchema<K, TMessageCatalog>;
}[keyof TMessageCatalog];

const messageSchema = z.object({
  version: z.string(),
  type: z.string(),
  payload: z.unknown(),
});

export class ZodSocketMessageHandler<TRPCCatalog extends ZodSocketMessageCatalogSchema> {
  #schema: TRPCCatalog;
  #handlers: ZodSocketMessageHandlers<TRPCCatalog> | undefined;
  #logger: StructuredLogger;
  #logPayloads: boolean;

  constructor(options: ZodSocketMessageHandlerOptions<TRPCCatalog>) {
    this.#schema = options.schema;
    this.#handlers = options.handlers;
    this.#logger =
      options.logger ?? new SimpleStructuredLogger("socket-message-handler", LogLevel.info);
    this.#logPayloads = options.logPayloads ?? !!process.env.LOG_SOCKET_HANDLER_PAYLOADS;
  }

  public async handleMessage(message: unknown) {
    const parseResult = this.parseMessage(message);

    if (!parseResult.success) {
      this.#logger.error("Failed to parse message, skipping handler", {
        rawMessage: message,
        error: parseResult.reason,
      });
      return;
    }

    if (!this.#handlers) {
      throw new Error("No handlers provided");
    }

    const { type, payload } = parseResult.data;

    const handler = this.#handlers[type];

    if (!handler) {
      this.#logger.error("No handler for message type", { type, payload });
      return;
    }

    const ack = await handler(payload);

    return ack;
  }

  private parseMessage(message: unknown):
    | {
        success: true;
        data: MessagesFromSocketCatalog<TRPCCatalog>;
      }
    | {
        success: false;
        reason?: string;
      } {
    const parsedMessage = messageSchema.safeParse(message);

    if (!parsedMessage.success) {
      return {
        success: false,
        reason: `Failed to parse message: ${fromZodError(parsedMessage.error).toString()}`,
      };
    }

    const schema = this.#schema[parsedMessage.data.type]?.["message"];

    if (!schema) {
      return {
        success: false,
        reason: `Unknown message type: ${parsedMessage.data.type}`,
      };
    }

    const messageWithVersion = {
      version: parsedMessage.data.version,
      ...(typeof parsedMessage.data.payload === "object" ? parsedMessage.data.payload : {}),
    };

    const parsedPayload = schema.safeParse(messageWithVersion);

    if (!parsedPayload.success) {
      this.#logger.error("Failed to parse message payload", {
        message,
        payload: messageWithVersion,
      });

      return {
        success: false,
        reason: fromZodError(parsedPayload.error).toString(),
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

    for (const eventName of Object.keys(this.#handlers)) {
      emitter.on(eventName, async (message: any, callback?: any): Promise<void> => {
        log.info(`Incoming event ${eventName}`, {
          eventName,
          ...(this.#logPayloads ? { eventMessage: message } : {}),
          hasCallback: !!callback,
        });

        let ack;

        try {
          // FIXME: this only works if the message doesn't have genuine payload prop
          if ("payload" in message) {
            ack = await this.handleMessage({ type: eventName, ...message });
          } else {
            // Handle messages not sent by ZodMessageSender
            const { version, ...payload } = message;
            ack = await this.handleMessage({ type: eventName, version, payload });
          }
        } catch (error) {
          log.error("Error while handling message", {
            error:
              error instanceof Error
                ? {
                    message: error.message,
                    stack: error.stack,
                  }
                : error,
          });
          return;
        }

        if (callback && typeof callback === "function") {
          callback(ack);
        }
      });
    }
  }
}

export type ZodSocketMessageSenderOptions<TMessageCatalog extends ZodSocketMessageCatalogSchema> = {
  schema: TMessageCatalog;
  socket: ZodSocket<any, TMessageCatalog>;
  logger?: StructuredLogger;
};

export type GetSocketMessagesWithCallback<TMessageCatalog extends ZodSocketMessageCatalogSchema> = {
  [K in keyof TMessageCatalog]: SocketMessageHasCallback<TMessageCatalog, K> extends true
    ? K
    : never;
}[keyof TMessageCatalog];

export type GetSocketMessagesWithoutCallback<
  TMessageCatalog extends ZodSocketMessageCatalogSchema,
> = {
  [K in keyof TMessageCatalog]: SocketMessageHasCallback<TMessageCatalog, K> extends true
    ? never
    : K;
}[keyof TMessageCatalog];

export class ZodSocketMessageSender<TMessageCatalog extends ZodSocketMessageCatalogSchema> {
  #schema: TMessageCatalog;
  #socket: ZodSocket<any, TMessageCatalog>;
  #logger: StructuredLogger;

  constructor(options: ZodSocketMessageSenderOptions<TMessageCatalog>) {
    this.#schema = options.schema;
    this.#socket = options.socket;
    this.#logger = options.logger ?? new SimpleStructuredLogger("zod-socket-sender", LogLevel.info);
  }

  public send<K extends GetSocketMessagesWithoutCallback<TMessageCatalog>>(
    type: K,
    payload: z.input<GetSocketMessageSchema<TMessageCatalog, K>>
  ): void {
    const schema = this.#schema[type]?.["message"];

    if (!schema) {
      throw new Error(`Unknown message type: ${type as string}`);
    }

    const parsedPayload = schema.safeParse(payload);

    if (!parsedPayload.success) {
      this.#logger.error("Failed to parse message payload, will not send", {
        error: parsedPayload.error,
      });
      return;
    }

    // @ts-expect-error
    this.#socket.emit(type, { payload, version: "v1" });

    return;
  }

  public async sendWithAck<K extends GetSocketMessagesWithCallback<TMessageCatalog>>(
    type: K,
    payload: z.input<GetSocketMessageSchema<TMessageCatalog, K>>,
    timeout?: number
  ): Promise<z.infer<GetSocketCallbackSchema<TMessageCatalog, K>>> {
    const schema = this.#schema[type]?.["message"];

    if (!schema) {
      throw new Error(`Unknown message type: ${type as string}`);
    }

    const parsedPayload = schema.safeParse(payload);

    if (!parsedPayload.success) {
      throw new Error(`Failed to parse message payload: ${JSON.stringify(parsedPayload.error)}`);
    }

    const socket = timeout ? this.#socket.timeout(timeout) : this.#socket;

    // @ts-expect-error
    const callbackResult = await socket.emitWithAck(type, { payload, version: "v1" });

    return callbackResult;
  }
}

export type ZodSocket<
  TListenEvents extends ZodSocketMessageCatalogSchema,
  TEmitEvents extends ZodSocketMessageCatalogSchema,
> = Omit<
  Socket<
    ZodMessageCatalogToSocketIoEvents<TListenEvents>,
    ZodMessageCatalogToSocketIoEvents<TEmitEvents>
  >,
  "timeout"
> & {
  timeout: (
    timeout: number
  ) => Socket<
    ZodMessageCatalogToSocketIoEvents<TListenEvents>,
    ZodMessageCatalogToSocketIoEvents<TEmitEvents>
  >;
};

interface ZodSocketConnectionOptions<
  TClientMessages extends ZodSocketMessageCatalogSchema,
  TServerMessages extends ZodSocketMessageCatalogSchema,
> {
  host: string;
  port?: number;
  secure?: boolean;
  namespace: string;
  clientMessages: TClientMessages;
  serverMessages: TServerMessages;
  extraHeaders?: {
    [header: string]: string;
  };
  handlers?: ZodSocketMessageHandlers<TServerMessages>;
  authToken?: string;
  ioOptions?: Partial<ManagerOptions & SocketOptions>;
  logHandlerPayloads?: boolean;
  onConnection?: (
    socket: ZodSocket<TServerMessages, TClientMessages>,
    handler: ZodSocketMessageHandler<TServerMessages>,
    sender: ZodSocketMessageSender<TClientMessages>,
    logger: StructuredLogger
  ) => Promise<void>;
  onDisconnect?: (
    socket: ZodSocket<TServerMessages, TClientMessages>,
    reason: Socket.DisconnectReason,
    description: any,
    logger: StructuredLogger
  ) => Promise<void>;
  onError?: (
    socket: ZodSocket<TServerMessages, TClientMessages>,
    err: Error,
    logger: StructuredLogger
  ) => Promise<void>;
}

export class ZodSocketConnection<
  TClientMessages extends ZodSocketMessageCatalogSchema,
  TServerMessages extends ZodSocketMessageCatalogSchema,
> {
  #sender: ZodSocketMessageSender<TClientMessages>;
  socket: ZodSocket<TServerMessages, TClientMessages>;

  #handler: ZodSocketMessageHandler<TServerMessages>;
  #logger: StructuredLogger;

  constructor(opts: ZodSocketConnectionOptions<TClientMessages, TServerMessages>) {
    const uri = `${opts.secure ? "wss" : "ws"}://${opts.host}:${
      opts.port ?? (opts.secure ? "443" : "80")
    }/${opts.namespace}`;

    const logger = new SimpleStructuredLogger(`socket-${opts.namespace}`, LogLevel.info, {
      namespace: opts.namespace,
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      extraHeaders: opts.extraHeaders,
    });

    logger.log("new zod socket", { uri });

    this.socket = io(uri, {
      transports: ["websocket"],
      auth: {
        token: opts.authToken,
      },
      extraHeaders: opts.extraHeaders,
      reconnectionDelay: 500,
      reconnectionDelayMax: 1000,
      ...opts.ioOptions,
    });

    this.#logger = logger.child({
      socketId: this.socket.id,
    });

    this.#handler = new ZodSocketMessageHandler({
      schema: opts.serverMessages,
      handlers: opts.handlers,
      logPayloads: opts.logHandlerPayloads,
    });
    this.#handler.registerHandlers(this.socket, this.#logger);

    this.#sender = new ZodSocketMessageSender({
      schema: opts.clientMessages,
      socket: this.socket,
      logger: this.#logger,
    });

    this.socket.on("connect_error", async (error) => {
      this.#logger.error(`connect_error: ${error}`);

      if (opts.onError) {
        await opts.onError(this.socket, error, this.#logger);
      }
    });

    this.socket.on("connect", async () => {
      this.#logger.info("connect");

      if (opts.onConnection) {
        await opts.onConnection(this.socket, this.#handler, this.#sender, this.#logger);
      }
    });

    this.socket.on("disconnect", async (reason, description) => {
      this.#logger.info("disconnect", { reason, description });

      if (opts.onDisconnect) {
        await opts.onDisconnect(this.socket, reason, description, this.#logger);
      }
    });
  }

  close() {
    this.socket.close();
  }

  connect() {
    this.socket.connect();
  }

  get send() {
    return this.#sender.send.bind(this.#sender);
  }

  get sendWithAck() {
    return this.#sender.sendWithAck.bind(this.#sender);
  }
}
