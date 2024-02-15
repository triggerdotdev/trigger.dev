import {
  ZodMessageHandler,
  ZodMessageSender,
  clientWebsocketMessages,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import { Evt } from "evt";
import { randomUUID } from "node:crypto";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { EnvironmentQueueConsumer } from "./marqs/environmentQueueConsumer.server";

export class AuthenticatedSocketConnection {
  public id: string;
  public onClose: Evt<CloseEvent> = new Evt();

  private _sender: ZodMessageSender<typeof serverWebsocketMessages>;
  private _environmentConsumer: EnvironmentQueueConsumer;
  private _messageHandler: ZodMessageHandler<typeof clientWebsocketMessages>;

  constructor(public ws: WebSocket, public authenticatedEnv: AuthenticatedEnvironment) {
    this.id = randomUUID();

    this._sender = new ZodMessageSender({
      schema: serverWebsocketMessages,
      sender: async (message) => {
        ws.send(JSON.stringify(message));
      },
    });

    this._environmentConsumer = new EnvironmentQueueConsumer(authenticatedEnv, this._sender);

    ws.addEventListener("message", this.#handleMessage.bind(this));
    ws.addEventListener("close", this.#handleClose.bind(this));
    ws.addEventListener("error", this.#handleError.bind(this));

    this._messageHandler = new ZodMessageHandler({
      schema: clientWebsocketMessages,
      messages: {
        READY_FOR_TASKS: async (payload) => {
          await this._environmentConsumer.registerBackgroundWorker(payload.backgroundWorkerId);
        },
        WORKER_DEPRECATED: async (payload) => {
          this._environmentConsumer.deprecateBackgroundWorker(payload.backgroundWorkerId);
        },
        BACKGROUND_WORKER_MESSAGE: async (payload) => {
          switch (payload.data.type) {
            case "TASK_RUN_COMPLETED": {
              await this._environmentConsumer.taskRunCompleted(
                payload.backgroundWorkerId,
                payload.data.completion
              );
              break;
            }
          }
        },
      },
    });
  }

  async initialize() {
    this._sender.send("SERVER_READY", { id: this.id });
  }

  async #handleMessage(ev: MessageEvent) {
    const data = JSON.parse(ev.data.toString());

    await this._messageHandler.handleMessage(data);
  }

  async #handleClose(ev: CloseEvent) {
    await this._environmentConsumer.stop();

    this.onClose.post(ev);
  }

  async #handleError(ev: Event) {
    logger.error("Websocket error", { ev });
  }
}
