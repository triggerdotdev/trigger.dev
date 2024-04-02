import {
  MessageCatalogToSocketIoEvents,
  StructuredLogger,
  ZodMessageHandler,
  ZodMessageSender,
  clientWebsocketMessages,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import { Evt } from "evt";
import { randomUUID } from "node:crypto";
import { logger } from "~/services/logger.server";
import { SharedQueueConsumer } from "./marqs/sharedQueueConsumer.server";
import type { DisconnectReason, Namespace, Socket } from "socket.io";
import { ROOT_CONTEXT, Span, SpanKind, trace } from "@opentelemetry/api";
import { env } from "~/env.server";

const tracer = trace.getTracer("sharedQueueConsumerPool");

interface SharedQueueConsumerPoolOptions {
  sender: ZodMessageSender<typeof serverWebsocketMessages>;
  poolSize: number;
}

class SharedQueueConsumerPool {
  #consumers: SharedQueueConsumer[];
  #span: Span;

  constructor(opts: SharedQueueConsumerPoolOptions) {
    this.#span = tracer.startSpan(
      "SharedQueueConsumerPool()",
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          "pool.size": opts.poolSize,
        },
      },
      ROOT_CONTEXT
    );

    const spanContext = trace.setSpan(ROOT_CONTEXT, this.#span);

    this.#consumers = Array(opts.poolSize)
      .fill(null)
      .map(
        () =>
          new SharedQueueConsumer(opts.sender, {
            interval: env.SHARED_QUEUE_CONSUMER_INTERVAL_MS,
            nextTickInterval: env.SHARED_QUEUE_CONSUMER_NEXT_TICK_INTERVAL_MS,
            parentContext: spanContext,
          })
      );
  }

  async start() {
    await Promise.allSettled(this.#consumers.map((consumer) => consumer.start()));
  }

  async stop() {
    await Promise.allSettled(this.#consumers.map((consumer) => consumer.stop()));
    this.#span.end();
  }
}

interface SharedSocketConnectionOptions {
  namespace: Namespace<
    MessageCatalogToSocketIoEvents<typeof clientWebsocketMessages>,
    MessageCatalogToSocketIoEvents<typeof serverWebsocketMessages>
  >;
  socket: Socket<
    MessageCatalogToSocketIoEvents<typeof clientWebsocketMessages>,
    MessageCatalogToSocketIoEvents<typeof serverWebsocketMessages>
  >;
  logger?: StructuredLogger;
  poolSize?: number;
}

export class SharedSocketConnection {
  public id: string;
  public onClose: Evt<DisconnectReason> = new Evt();

  private _sender: ZodMessageSender<typeof serverWebsocketMessages>;
  private _sharedQueueConsumerPool: SharedQueueConsumerPool;
  private _messageHandler: ZodMessageHandler<typeof clientWebsocketMessages>;
  private _defaultPoolSize = 10;

  constructor(opts: SharedSocketConnectionOptions) {
    this.id = randomUUID();

    this._sender = new ZodMessageSender({
      schema: serverWebsocketMessages,
      sender: async (message) => {
        return new Promise((resolve, reject) => {
          try {
            const { type, ...payload } = message;
            opts.namespace.emit(type, payload as any);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      },
    });

    logger.log("Starting SharedQueueConsumer pool", {
      poolSize: opts.poolSize ?? this._defaultPoolSize,
    });

    this._sharedQueueConsumerPool = new SharedQueueConsumerPool({
      poolSize: opts.poolSize ?? this._defaultPoolSize,
      sender: this._sender,
    });

    opts.socket.on("disconnect", this.#handleClose.bind(this));
    opts.socket.on("error", this.#handleError.bind(this));

    this._messageHandler = new ZodMessageHandler({
      schema: clientWebsocketMessages,
      messages: {
        READY_FOR_TASKS: async (payload) => {
          this._sharedQueueConsumerPool.start();
        },
        BACKGROUND_WORKER_DEPRECATED: async (payload) => {
          // await this._sharedConsumer.deprecateBackgroundWorker(payload.backgroundWorkerId);
        },
        BACKGROUND_WORKER_MESSAGE: async (payload) => {
          switch (payload.data.type) {
            case "TASK_RUN_COMPLETED": {
              // handled in coordinator namespace
              break;
            }
            case "TASK_HEARTBEAT": {
              // handled in coordinator namespace
              break;
            }
          }
        },
      },
    });
    this._messageHandler.registerHandlers(opts.socket, opts.logger ?? logger);
  }

  async initialize() {
    this._sender.send("SERVER_READY", { id: this.id });
  }

  async #handleClose(ev: DisconnectReason) {
    await this._sharedQueueConsumerPool.stop();

    this.onClose.post(ev);
  }

  async #handleError(ev: Error) {
    logger.error("Websocket error", { ev });
  }
}
