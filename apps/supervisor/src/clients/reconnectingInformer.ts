import { setTimeout as sleep } from "node:timers/promises";
import type { KubernetesObject, ListPromise, ListWatch } from "@kubernetes/client-node";
import type { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";

const MAX_RECONNECT_BACKOFF_MS = 30_000;

type ReconnectingInformerOptions<T extends KubernetesObject> = {
  /** Used in log fields, to tell informers apart. */
  name: string;
  logger: SimpleStructuredLogger;
  reconnectIntervalMs: number;
  list: ListPromise<T>;
  /** Builds the informer around the list it is given, which wraps `list`. */
  makeInformer: (list: ListPromise<T>) => ListWatch<T>;
  /** Called for every error the informer raises, before any reconnect. */
  onError?: (err: unknown) => void;
};

/**
 * An informer that reconnects with a capped backoff until a start succeeds, for
 * as long as it runs. The client's own error handling gives up after one failure.
 */
export class ReconnectingInformer<T extends KubernetesObject> {
  readonly informer: ListWatch<T>;
  private readonly name: string;
  private readonly logger: SimpleStructuredLogger;
  private readonly reconnectIntervalMs: number;
  private readonly listFn: ListPromise<T>;
  private readonly onErrorHook?: (err: unknown) => void;
  private running = false;
  private reconnecting = false;
  private erroredDuringReconnect = false;
  private starting = false;
  private ownListPending = false;

  constructor(opts: ReconnectingInformerOptions<T>) {
    this.name = opts.name;
    this.logger = opts.logger;
    this.reconnectIntervalMs = opts.reconnectIntervalMs;
    this.listFn = opts.list;
    this.onErrorHook = opts.onError;
    this.informer = opts.makeInformer(() => this.list());
    this.informer.on("error", (err?: unknown) => void this.onError(err));
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Rejects when the first list fails, so the caller learns the informer never started. */
  async start() {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.startInformer();
  }

  async stop() {
    if (!this.running) {
      return;
    }
    this.running = false;
    await this.informer.stop();
  }

  /**
   * The client relists on its own after a 410 and leaves that list's rejection
   * unhandled, so a failure there becomes a reconnect and the abandoned relist
   * never settles. An empty list instead would delete every cached object. Only
   * a start's own list rejects into the start: a 410 on the watch that start
   * opens relists inside it too, and nothing awaits that one.
   */
  private async list() {
    const ownList = this.starting && this.ownListPending;
    this.ownListPending = false;
    try {
      return await this.listFn();
    } catch (err: unknown) {
      if (ownList) {
        throw err;
      }
      void this.onError(err);
      return new Promise<never>(() => {});
    }
  }

  private async startInformer() {
    this.starting = true;
    // A start lists first only when it has no resourceVersion to watch from.
    this.ownListPending = !this.informer.latestResourceVersion();
    try {
      await this.informer.start();
    } finally {
      this.starting = false;
    }
    // A stop during the list still lets the client open its watch afterwards.
    if (!this.running) {
      await this.informer.stop();
    }
  }

  /**
   * Retries until a start ends with no error raised during it. A watch that
   * fails to connect raises its error inside the start, which still resolves.
   */
  private async onError(err: unknown) {
    if (!this.running) {
      return;
    }
    this.onErrorHook?.(err);
    if (this.reconnecting) {
      this.erroredDuringReconnect = true;
      return;
    }
    this.reconnecting = true;
    this.logger.error("Informer watch failed, reconnecting", {
      informer: this.name,
      error: messageOf(err),
    });
    let delayMs = this.reconnectIntervalMs;
    try {
      do {
        await sleep(delayMs);
        if (!this.running) {
          return;
        }
        this.erroredDuringReconnect = false;
        try {
          await this.startInformer();
        } catch (reconnectErr: unknown) {
          this.erroredDuringReconnect = true;
          this.logger.error("Informer reconnect failed", {
            informer: this.name,
            error: messageOf(reconnectErr),
          });
        }
        delayMs = Math.min(
          delayMs * 2,
          Math.max(this.reconnectIntervalMs, MAX_RECONNECT_BACKOFF_MS)
        );
      } while (this.running && this.erroredDuringReconnect);
    } finally {
      this.reconnecting = false;
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
