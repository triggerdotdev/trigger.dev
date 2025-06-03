import type { DisconnectReason, Namespace, Server, Socket } from "socket.io";
import { ZodMessageSender } from "./zodMessageHandler.js";
import {
  ZodMessageCatalogToSocketIoEvents,
  ZodSocketMessageCatalogSchema,
  ZodSocketMessageHandler,
  ZodSocketMessageHandlers,
  GetSocketMessagesWithCallback,
} from "./zodSocket.js";
// @ts-ignore
import type { DefaultEventsMap, EventsMap } from "socket.io/dist/typed-events";
import { z } from "zod";
import { SimpleStructuredLogger, StructuredLogger } from "./utils/structuredLogger.js";

type AssertNoCallbackSchemas<T extends ZodSocketMessageCatalogSchema> = [
  GetSocketMessagesWithCallback<T>,
] extends [never]
  ? {}
  : { __error__: GetSocketMessagesWithCallback<T> };

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

interface ZodNamespaceOptions<
  TClientMessages extends ZodSocketMessageCatalogSchema,
  TServerMessages extends ZodSocketMessageCatalogSchema,
  TServerSideEvents extends EventsMap = DefaultEventsMap,
  TSocketData extends z.ZodObject<any, any, any> = any,
> extends AssertNoCallbackSchemas<TServerMessages> {
  io: Server;
  name: string;
  clientMessages: TClientMessages;
  serverMessages: TServerMessages;
  socketData?: TSocketData;
  handlers?: ZodSocketMessageHandlers<TClientMessages>;
  authToken?: string;
  logger?: StructuredLogger;
  logHandlerPayloads?: boolean;
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
    this.#logger =
      opts.logger ??
      new SimpleStructuredLogger(`ns-${opts.name}`, undefined, {
        namespace: opts.name,
      });

    this.#handler = new ZodSocketMessageHandler({
      schema: opts.clientMessages,
      handlers: opts.handlers,
      logPayloads: opts.logHandlerPayloads,
    });

    this.io = opts.io;

    this.namespace = this.io.of(opts.name);

    const invalidMessages = Object.entries(opts.serverMessages)
      .filter(([, value]) => "callback" in value && value.callback)
      .map(([key]) => key);

    if (invalidMessages.length > 0) {
      throw new Error(
        `serverMessages with callbacks are not supported: ${invalidMessages.join(", ")}`
      );
    }

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

        return;
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
