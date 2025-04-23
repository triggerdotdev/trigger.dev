import {
  clientWebsocketMessages,
  IntervalService,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import { ZodMessageHandler, ZodMessageSender } from "@trigger.dev/core/v3/zodMessageHandler";
import { Evt } from "evt";
import { randomUUID } from "node:crypto";
import type { CloseEvent, ErrorEvent, MessageEvent } from "ws";
import { WebSocket } from "ws";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { DevQueueConsumer } from "./marqs/devQueueConsumer.server";

export class AuthenticatedSocketConnection {
  public id: string;
  public onClose: Evt<CloseEvent> = new Evt();

  private _sender: ZodMessageSender<typeof serverWebsocketMessages>;
  private _consumer: DevQueueConsumer;
  private _messageHandler: ZodMessageHandler<typeof clientWebsocketMessages>;
  private _pingService: IntervalService;

  constructor(
    public ws: WebSocket,
    public authenticatedEnv: AuthenticatedEnvironment,
    private readonly ipAddress: string | string[]
  ) {
    this.id = randomUUID();

    this._sender = new ZodMessageSender({
      schema: serverWebsocketMessages,
      sender: async (message) => {
        return new Promise((resolve, reject) => {
          if (!ws.OPEN) {
            return reject(new Error("Websocket is not open"));
          }

          ws.send(JSON.stringify(message), {}, (err) => {
            if (err) {
              reject(err);
              return;
            }

            resolve();
          });
        });
      },
      canSendMessage() {
        return ws.readyState === WebSocket.OPEN;
      },
    });

    this._consumer = new DevQueueConsumer(this.id, authenticatedEnv, this._sender, {
      ipAddress: Array.isArray(this.ipAddress) ? this.ipAddress.join(", ") : this.ipAddress,
    });

    ws.addEventListener("message", this.#handleMessage.bind(this));
    ws.addEventListener("close", this.#handleClose.bind(this));
    ws.addEventListener("error", this.#handleError.bind(this));

    ws.on("ping", (data) => {
      logger.debug("[AuthenticatedSocketConnection] Received ping", {
        id: this.id,
        envId: this.authenticatedEnv.id,
        data,
      });
    });

    ws.on("pong", (data) => {
      // logger.debug("[AuthenticatedSocketConnection] Received pong", {
      //   id: this.id,
      //   envId: this.authenticatedEnv.id,
      //   data,
      // });
    });

    this._pingService = new IntervalService({
      onInterval: async () => {
        if (ws.readyState !== WebSocket.OPEN) {
          logger.debug("[AuthenticatedSocketConnection] Websocket not open, skipping ping");
          return;
        }

        // logger.debug("[AuthenticatedSocketConnection] Sending ping", {
        //   id: this.id,
        //   envId: this.authenticatedEnv.id,
        // });

        ws.ping();
      },
      intervalMs: 45_000,
    });
    this._pingService.start();

    this._messageHandler = new ZodMessageHandler({
      schema: clientWebsocketMessages,
      logger,
      messages: {
        READY_FOR_TASKS: async (payload) => {
          await this._consumer.registerBackgroundWorker(
            payload.backgroundWorkerId,
            payload.inProgressRuns ?? []
          );
        },
        BACKGROUND_WORKER_DEPRECATED: async (payload) => {
          await this._consumer.deprecateBackgroundWorker(payload.backgroundWorkerId);
        },
        BACKGROUND_WORKER_MESSAGE: async (payload) => {
          switch (payload.data.type) {
            case "TASK_RUN_COMPLETED": {
              await this._consumer.taskAttemptCompleted(
                payload.backgroundWorkerId,
                payload.data.completion,
                payload.data.execution
              );
              break;
            }
            case "TASK_RUN_FAILED_TO_RUN": {
              await this._consumer.taskRunFailed(
                payload.backgroundWorkerId,
                payload.data.completion
              );

              break;
            }
            case "TASK_HEARTBEAT": {
              await this._consumer.taskHeartbeat(payload.backgroundWorkerId, payload.data.id);
              break;
            }
            case "TASK_RUN_HEARTBEAT": {
              await this._consumer.taskRunHeartbeat(payload.backgroundWorkerId, payload.data.id);
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
    try {
      const data = JSON.parse(ev.data.toString());

      await this._messageHandler.handleMessage(data);
    } catch (error) {
      logger.error("[AuthenticatedSocketConnection] Failed to handle message", {
        error:
          error instanceof Error
            ? {
                message: error.message,
                stack: error.stack,
              }
            : error,
        message: ev.data.toString(),
      });
    }
  }

  async #handleClose(ev: CloseEvent) {
    logger.debug("[AuthenticatedSocketConnection] Websocket closed", { ev });

    this._pingService.stop();

    await this._consumer.stop();

    const result = this.onClose.post(ev);

    logger.debug("[AuthenticatedSocketConnection] Called onClose", {
      result,
    });
  }

  async #handleError(ev: ErrorEvent) {
    logger.error("Websocket error", { ev });
  }
}
