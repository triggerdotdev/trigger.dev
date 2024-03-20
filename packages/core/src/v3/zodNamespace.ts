import { DisconnectReason, Namespace, Server, Socket } from "socket.io";
import { ZodMessageSender } from "./zodMessageHandler";
import {
  ZodMessageCatalogToSocketIoEvents,
  ZodSocketMessageCatalogSchema,
  ZodSocketMessageHandler,
  ZodSocketMessageHandlers,
} from "./zodSocket";
import { DefaultEventsMap, EventsMap } from "socket.io/dist/typed-events";
import { z } from "zod";

interface ExtendedError extends Error {
  data?: any;
}

export type ZodNamespaceSocket<
  TClientMessages extends ZodSocketMessageCatalogSchema,
  TServerMessages extends ZodSocketMessageCatalogSchema,
  TServerSideEvents extends EventsMap = DefaultEventsMap,
  TSocketData extends z.ZodObject<any, any, any> = any,
> = Socket<
  ZodMessageCatalogToSocketIoEvents<TClientMessages>,
  ZodMessageCatalogToSocketIoEvents<TServerMessages>,
  TServerSideEvents,
  z.infer<TSocketData>
>;

type StructuredArgs = (Record<string, unknown> | undefined)[];

export interface StructuredLogger {
  log: (message: string, ...args: StructuredArgs) => any;
  error: (message: string, ...args: StructuredArgs) => any;
  warn: (message: string, ...args: StructuredArgs) => any;
  info: (message: string, ...args: StructuredArgs) => any;
  debug: (message: string, ...args: StructuredArgs) => any;
  child: (fields: Record<string, unknown>) => StructuredLogger;
}

export enum LogLevel {
  "log",
  "error",
  "warn",
  "info",
  "debug",
}

export class SimpleStructuredLogger implements StructuredLogger {
  constructor(
    private name: string,
    private level: LogLevel = ["1", "true"].includes(process.env.DEBUG ?? "")
      ? LogLevel.debug
      : LogLevel.info,
    private fields?: Record<string, unknown>
  ) {}

  child(fields: Record<string, unknown>, level?: LogLevel) {
    return new SimpleStructuredLogger(this.name, level, { ...this.fields, ...fields });
  }

  log(message: string, ...args: StructuredArgs) {
    if (this.level < LogLevel.log) return;

    this.#structuredLog(console.log, message, "log", ...args);
  }

  error(message: string, ...args: StructuredArgs) {
    if (this.level < LogLevel.error) return;

    this.#structuredLog(console.error, message, "error", ...args);
  }

  warn(message: string, ...args: StructuredArgs) {
    if (this.level < LogLevel.warn) return;

    this.#structuredLog(console.warn, message, "warn", ...args);
  }

  info(message: string, ...args: StructuredArgs) {
    if (this.level < LogLevel.info) return;

    this.#structuredLog(console.info, message, "info", ...args);
  }

  debug(message: string, ...args: StructuredArgs) {
    if (this.level < LogLevel.debug) return;

    this.#structuredLog(console.debug, message, "debug", ...args);
  }

  #structuredLog(
    loggerFunction: (message: string, ...args: any[]) => void,
    message: string,
    level: string,
    ...args: Array<Record<string, unknown> | undefined>
  ) {
    const structuredLog = {
      ...args,
      ...this.fields,
      timestamp: new Date(),
      name: this.name,
      message,
      level,
    };

    loggerFunction(JSON.stringify(structuredLog));
  }
}

interface ZodNamespaceOptions<
  TClientMessages extends ZodSocketMessageCatalogSchema,
  TServerMessages extends ZodSocketMessageCatalogSchema,
  TServerSideEvents extends EventsMap = DefaultEventsMap,
  TSocketData extends z.ZodObject<any, any, any> = any,
> {
  io: Server;
  name: string;
  clientMessages: TClientMessages;
  serverMessages: TServerMessages;
  socketData?: TSocketData;
  handlers?: ZodSocketMessageHandlers<TClientMessages>;
  authToken?: string;
  logger?: StructuredLogger;
  preAuth?: (
    socket: ZodNamespaceSocket<TClientMessages, TServerMessages, TServerSideEvents, TSocketData>,
    next: (err?: ExtendedError) => void,
    logger: StructuredLogger
  ) => Promise<void>;
  postAuth?: (
    socket: ZodNamespaceSocket<TClientMessages, TServerMessages, TServerSideEvents, TSocketData>,
    next: (err?: ExtendedError) => void,
    logger: StructuredLogger
  ) => Promise<void>;
  onConnection?: (
    socket: ZodNamespaceSocket<TClientMessages, TServerMessages, TServerSideEvents, TSocketData>,
    handler: ZodSocketMessageHandler<TClientMessages>,
    sender: ZodMessageSender<TServerMessages>,
    logger: StructuredLogger
  ) => Promise<void>;
  onDisconnect?: (
    socket: ZodNamespaceSocket<TClientMessages, TServerMessages, TServerSideEvents, TSocketData>,
    reason: DisconnectReason,
    description: any,
    logger: StructuredLogger
  ) => Promise<void>;
  onError?: (
    socket: ZodNamespaceSocket<TClientMessages, TServerMessages, TServerSideEvents, TSocketData>,
    err: Error,
    logger: StructuredLogger
  ) => Promise<void>;
}

export class ZodNamespace<
  TClientMessages extends ZodSocketMessageCatalogSchema,
  TServerMessages extends ZodSocketMessageCatalogSchema,
  TSocketData extends z.ZodObject<any, any, any> = any,
  TServerSideEvents extends EventsMap = DefaultEventsMap,
> {
  #logger: StructuredLogger;
  #handler: ZodSocketMessageHandler<TClientMessages>;
  sender: ZodMessageSender<TServerMessages>;

  io: Server;
  namespace: Namespace<
    ZodMessageCatalogToSocketIoEvents<TClientMessages>,
    ZodMessageCatalogToSocketIoEvents<TServerMessages>,
    TServerSideEvents,
    z.infer<TSocketData>
  >;

  constructor(
    opts: ZodNamespaceOptions<TClientMessages, TServerMessages, TServerSideEvents, TSocketData>
  ) {
    this.#logger = opts.logger ?? new SimpleStructuredLogger(opts.name);

    this.#handler = new ZodSocketMessageHandler({
      schema: opts.clientMessages,
      handlers: opts.handlers,
    });

    this.io = opts.io;

    this.namespace = this.io.of(opts.name);

    // FIXME: There's a bug here, this sender should not accept Socket schemas with callbacks
    this.sender = new ZodMessageSender({
      schema: opts.serverMessages,
      sender: async (message) => {
        return new Promise((resolve, reject) => {
          try {
            // @ts-expect-error
            this.namespace.emit(message.type, message.payload);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      },
    });

    if (opts.preAuth) {
      this.namespace.use(async (socket, next) => {
        const logger = this.#logger.child({ socketId: socket.id, socketStage: "preAuth" });

        if (typeof opts.preAuth === "function") {
          await opts.preAuth(socket, next, logger);
        }
      });
    }

    if (opts.authToken) {
      this.namespace.use((socket, next) => {
        const logger = this.#logger.child({ socketId: socket.id, socketStage: "auth" });

        const { auth } = socket.handshake;

        if (!("token" in auth)) {
          logger.error("no token");
          return socket.disconnect(true);
        }

        if (auth.token !== opts.authToken) {
          logger.error("invalid token");
          return socket.disconnect(true);
        }

        logger.info("success");

        next();
      });
    }

    if (opts.postAuth) {
      this.namespace.use(async (socket, next) => {
        const logger = this.#logger.child({ socketId: socket.id, socketStage: "auth" });

        if (typeof opts.postAuth === "function") {
          await opts.postAuth(socket, next, logger);
        }
      });
    }

    this.namespace.on("connection", async (socket) => {
      const logger = this.#logger.child({ socketId: socket.id, socketStage: "connection" });
      logger.info("connected");

      this.#handler.registerHandlers(socket, logger);

      socket.on("disconnect", async (reason, description) => {
        logger.info("disconnect", { reason, description });

        if (opts.onDisconnect) {
          await opts.onDisconnect(socket, reason, description, logger);
        }
      });

      socket.on("error", async (error) => {
        logger.error("error", { error });

        if (opts.onError) {
          await opts.onError(socket, error, logger);
        }
      });

      if (opts.onConnection) {
        await opts.onConnection(socket, this.#handler, this.sender, logger);
      }
    });
  }

  fetchSockets() {
    return this.namespace.fetchSockets();
  }
}
