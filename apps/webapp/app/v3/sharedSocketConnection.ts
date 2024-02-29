import {
  MessageCatalogToSocketIoEvents,
  ZodMessageHandler,
  ZodMessageSender,
  clientWebsocketMessages,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import { Evt } from "evt";
import { randomUUID } from "node:crypto";
import { logger } from "~/services/logger.server";
import { SharedQueueConsumer } from "./marqs/sharedQueueConsumer.server";
import { DisconnectReason, Namespace, Socket } from "socket.io";

export class SharedSocketConnection {
  public id: string;
  public onClose: Evt<DisconnectReason> = new Evt();

  private _sender: ZodMessageSender<typeof serverWebsocketMessages>;
  private _sharedConsumer: SharedQueueConsumer;
  private _messageHandler: ZodMessageHandler<typeof clientWebsocketMessages>;

  constructor(
    namespace: Namespace<
      MessageCatalogToSocketIoEvents<typeof clientWebsocketMessages>,
      MessageCatalogToSocketIoEvents<typeof serverWebsocketMessages>
    >,
    private socket: Socket<
      MessageCatalogToSocketIoEvents<typeof clientWebsocketMessages>,
      MessageCatalogToSocketIoEvents<typeof serverWebsocketMessages>
    >,
    logger?: (...args: any[]) => void
  ) {
    this.id = randomUUID();

    this._sender = new ZodMessageSender({
      schema: serverWebsocketMessages,
      sender: async (message) => {
        return new Promise((resolve, reject) => {
          try {
            const { type, ...payload } = message;
            namespace.emit(type, payload as any);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      },
    });

    this._sharedConsumer = new SharedQueueConsumer(this._sender);

    socket.on("disconnect", this.#handleClose.bind(this));
    socket.on("error", this.#handleError.bind(this));

    this._messageHandler = new ZodMessageHandler({
      schema: clientWebsocketMessages,
      messages: {
        READY_FOR_TASKS: async (payload) => {
          this._sharedConsumer.start();
        },
        BACKGROUND_WORKER_DEPRECATED: async (payload) => {
          await this._sharedConsumer.deprecateBackgroundWorker(payload.backgroundWorkerId);
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
    this._messageHandler.registerHandlers(this.socket, logger);
  }

  async initialize() {
    this._sender.send("SERVER_READY", { id: this.id });
  }

  async #handleClose(ev: DisconnectReason) {
    await this._sharedConsumer.stop();

    this.onClose.post(ev);
  }

  async #handleError(ev: Error) {
    logger.error("Websocket error", { ev });
  }
}
