import type { WebSocket as NodeWebSocket } from "ws";
import { v4 } from "uuid";
import { Evt } from "evt";
import { IConnection, MESSAGE_META } from "internal-bridge";

export class TimeoutError extends Error {}
export class NotConnectedError extends Error {}

type PendingMessage = {
  data: string;
  onAckReceived: () => void;
};

export type ConnectionOptions = {
  connectTimeout?: number;
  sendTimeout?: number;
  pingTimeout?: number;
  id?: string;
};

export class TriggerServerConnection implements IConnection {
  id: string;
  onMessage: Evt<string>;
  onClose: Evt<[number, string]>;
  onOpen: Evt<void>;
  onError: Evt<Error>;

  #socket: WebSocket | NodeWebSocket;

  #connectTimeout: number;
  #sendTimeout: number;
  #pingTimeout: number;
  #timeouts: Set<NodeJS.Timeout>;
  #isClosed: boolean = false;
  #pendingMessages = new Map<string, PendingMessage>();

  constructor(socket: WebSocket | NodeWebSocket, options?: ConnectionOptions) {
    this.#socket = socket;
    this.id = options?.id ?? v4();

    this.onMessage = new Evt();
    this.onClose = new Evt<[number, string]>();
    this.onOpen = new Evt();
    this.onError = new Evt<Error>();

    this.#connectTimeout = options?.connectTimeout ?? 5000;
    this.#sendTimeout = options?.sendTimeout ?? 5000;
    this.#pingTimeout = options?.pingTimeout ?? 5000;

    this.#timeouts = new Set();

    this.onClose.attach(() => {
      this.#isClosed = true;

      for (const timeout of this.#timeouts) {
        clearTimeout(timeout);
      }

      this.#timeouts.clear();
    });

    this.#socket.onopen = () => {
      this.#isClosed = false;
      this.onOpen.post();
    };

    this.#socket.onclose = (ev: CloseEvent) => {
      this.onClose.post([ev.code, ev.reason]);
    };

    this.#socket.onerror = (ev: ErrorEvent | Event) => {
      const message = "message" in ev ? ev.message : "Unknown error";

      this.onError.post(new Error(message));
    };

    this.#socket.onmessage = (event: MessageEvent) => {
      if (this.#isClosed) return;

      const data = JSON.parse(event.data.toString());
      const metadata = MESSAGE_META.parse(data);

      if (metadata.type === "ACK") {
        const pendingMessage = this.#pendingMessages.get(metadata.id);

        if (pendingMessage) {
          pendingMessage.onAckReceived();
          this.#pendingMessages.delete(metadata.id);
        }
      }

      if (metadata.type === "MESSAGE") {
        socket.send(JSON.stringify({ type: "ACK", id: metadata.id }));

        this.onMessage.post(metadata.data);
      }
    };

    if ("pong" in socket) {
      socket.on("pong", (buf) => {
        const id = buf.toString();
        const pendingMessage = this.#pendingMessages.get(id);

        if (pendingMessage?.data === "ping") {
          pendingMessage.onAckReceived();
        }
      });
    }
  }

  async send(data: string) {
    if (this.#isClosed) throw new NotConnectedError();

    return new Promise<void>((resolve, reject) => {
      const id = v4();

      const failTimeout = setTimeout(() => {
        reject(new TimeoutError());
      }, this.#sendTimeout);

      this.#timeouts.add(failTimeout);

      this.#pendingMessages.set(id, {
        data,
        onAckReceived: () => {
          clearTimeout(failTimeout);

          this.#timeouts.delete(failTimeout);

          resolve();
        },
      });

      this.#socket.send(JSON.stringify({ id, data, type: "MESSAGE" }));
    });
  }

  close(code?: number, reason?: string) {
    this.#isClosed = true;
    this.onMessage.detach();
    return this.#socket.close(code, reason);
  }
}
