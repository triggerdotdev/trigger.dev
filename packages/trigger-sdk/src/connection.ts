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

export class HostConnection implements IConnection {
  id: string;
  onMessage: Evt<string>;
  onAuthenticated: Evt<void>;
  onClose: Evt<[number, string]>;
  onOpen: Evt<void>;
  onError: Evt<Error>;

  #socket: WebSocket | NodeWebSocket;

  #connectTimeout: number;
  #sendTimeout: number;
  #pingTimeout: number;
  #isAuthenticated: boolean = false;
  #timeouts: Set<NodeJS.Timeout>;
  #isClosed: boolean = false;
  #pendingMessages = new Map<string, PendingMessage>();

  constructor(socket: WebSocket | NodeWebSocket, options?: ConnectionOptions) {
    this.#socket = socket;
    this.id = options?.id ?? v4();

    this.onMessage = new Evt();
    this.onAuthenticated = new Evt<void>();
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

        if (metadata.data === "AUTHENTICATED") {
          this.#isAuthenticated = true;
          this.onAuthenticated.post();
          return;
        }

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

  async connect() {
    return new Promise<void>((resolve, reject) => {
      if (
        this.#socket.readyState === this.#socket.OPEN &&
        this.#isAuthenticated
      ) {
        return resolve();
      }

      const failTimeout = setTimeout(
        () => reject(new TimeoutError()),
        this.#connectTimeout
      );

      this.#timeouts.add(failTimeout);

      this.onAuthenticated.attach(() => {
        clearTimeout(failTimeout);
        this.#timeouts.delete(failTimeout);
        resolve();
      });
    });
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
