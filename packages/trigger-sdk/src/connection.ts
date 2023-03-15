import type { WebSocket as NodeWebSocket } from "ws";
import { v4 } from "uuid";
import { Evt } from "evt";
import { IConnection, Logger, MESSAGE_META } from "internal-bridge";

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
  #logger: Logger;

  #pingIntervalHandle: NodeJS.Timeout | undefined;
  #pingIntervalMs: number = 30_000; // 30 seconds
  #closeUnresponsiveConnectionTimeoutMs: number = 3 * 60 * 1000; // 3 minutes

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

    this.#logger = new Logger("trigger.dev connection");

    this.onClose.attach(() => {
      this.#isClosed = true;

      if (this.#pingIntervalHandle) {
        clearInterval(this.#pingIntervalHandle);
        this.#pingIntervalHandle = undefined;
      }

      for (const timeout of this.#timeouts) {
        clearTimeout(timeout);
      }

      this.#timeouts.clear();
    });

    this.#socket.onopen = () => {
      this.#isClosed = false;
      this.onOpen.post();

      this.#startPingInterval();
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
    this.#logger.debug("[connect] Attempting to connect");

    return new Promise<void>((resolve, reject) => {
      if (
        this.#socket.readyState === this.#socket.OPEN &&
        this.#isAuthenticated
      ) {
        this.#logger.debug("[connect] Already connected, resolving");

        return resolve();
      }

      const failTimeout = setTimeout(() => {
        this.#logger.debug("[connect] Connection timed out, rejecting");

        reject(new TimeoutError());
      }, this.#connectTimeout);

      this.#timeouts.add(failTimeout);

      this.onAuthenticated.attach(() => {
        clearTimeout(failTimeout);
        this.#timeouts.delete(failTimeout);

        this.#logger.debug("[connect] Connected, resolving");

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

  #startPingInterval() {
    // Do the ping stuff here
    let lastSuccessfulPing = new Date();
    this.#pingIntervalHandle = setInterval(async () => {
      if (!this.#socket.OPEN) {
        if (this.#pingIntervalHandle) {
          clearInterval(this.#pingIntervalHandle);
          this.#pingIntervalHandle = undefined;
        }

        return;
      }

      try {
        await this.#ping();
        lastSuccessfulPing = new Date();
      } catch (err) {
        this.#logger.warn("Pong not received in time");
        if (!(err instanceof TimeoutError)) {
          this.#logger.error(err);
        }

        if (
          lastSuccessfulPing.getTime() <
          new Date().getTime() - this.#closeUnresponsiveConnectionTimeoutMs
        ) {
          this.#logger.error(
            "No pong received in last three minutes, closing connection to Trigger.dev and retrying..."
          );
          if (this.#pingIntervalHandle) {
            clearInterval(this.#pingIntervalHandle);
            this.#pingIntervalHandle = undefined;
          }
          this.#socket.close();
        }
      }
    }, this.#pingIntervalMs);
  }

  async #ping() {
    if (!this.#socket.OPEN) {
      throw new NotConnectedError();
    }

    if (!("ping" in this.#socket)) {
      // Not supported in web client WebSocket
      throw new Error(
        "ping not supported in this underlying websocket connection"
      );
    }

    const socket = this.#socket;

    return new Promise<void>((resolve, reject) => {
      const id = v4();

      const failTimeout = setTimeout(() => {
        reject(new TimeoutError("Pong not received in time"));
      }, this.#pingTimeout);

      this.#timeouts.add(failTimeout);

      this.#pendingMessages.set(id, {
        data: "ping",
        onAckReceived: () => {
          clearTimeout(failTimeout);

          this.#timeouts.delete(failTimeout);

          this.#logger.debug(`Resolving ping`);

          resolve();
        },
      });

      this.#logger.debug(`Sending ping ${id} to ${socket.url}`);

      socket.ping(id, undefined, (err) => {
        if (err) {
          reject(err);
        }
      });
    });
  }
}
