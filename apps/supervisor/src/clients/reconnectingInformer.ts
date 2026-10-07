import { setTimeout as sleep } from "node:timers/promises";
import type { KubernetesObject, ListPromise, ListWatch } from "@kubernetes/client-node";
import type { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";

const MAX_RECONNECT_BACKOFF_MS = 30_000;

// Past the server closing the watch at its timeout, how long to wait for the
// client to watch again before taking the watch for stalled.
const WATCH_STALL_GRACE_MS = 30_000;

type ReconnectingInformerOptions<T extends KubernetesObject> = {
  /** Used in log fields, to tell informers apart. */
  name: string;
  logger: SimpleStructuredLogger;
  reconnectIntervalMs: number;
  /** The watch path, which gets the timeout as a query parameter. */
  path: string;
  list: ListPromise<T>;
  /** Builds the informer around the path and list it is given, which wraps `list`. */
  makeInformer: (path: string, list: ListPromise<T>) => ListWatch<T>;
  /** Called for every error the informer raises, before any reconnect. */
  onError?: (err: unknown) => void;
  /**
   * How long the server keeps each watch open before closing it. A watch that has
   * neither connected nor delivered an event for this plus 30 s is taken as
   * stalled. Without it, a watch has no timeout and is never checked.
   */
  watchTimeoutSeconds?: number;
  /** Called when the stall check takes the watch for stalled, before it reconnects. */
  onStall?: (quietMs: number) => void;
};

/**
 * An informer that reconnects with a capped backoff until a start succeeds, for
 * as long as it runs. The client's own error handling gives up after one failure.
 *
 * A connection that died without closing (a dropped NAT entry, a blackholed load
 * balancer) raises nothing. With a watch timeout, the server closes each watch
 * and the client watches again, so a healthy watch connects at least that often,
 * and a stall check reconnects one that goes quiet for longer.
 */
export class ReconnectingInformer<T extends KubernetesObject> {
  readonly informer: ListWatch<T>;
  private readonly name: string;
  private readonly logger: SimpleStructuredLogger;
  private readonly reconnectIntervalMs: number;
  private readonly listFn: ListPromise<T>;
  private readonly onErrorHook?: (err: unknown) => void;
  private readonly onStallHook?: (quietMs: number) => void;
  private readonly watchTimeoutMs?: number;
  private lastWatchActivityAt = 0;
  private stallCheck?: NodeJS.Timeout;
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
    this.onStallHook = opts.onStall;
    this.watchTimeoutMs =
      opts.watchTimeoutSeconds === undefined ? undefined : opts.watchTimeoutSeconds * 1000;
    const path =
      opts.watchTimeoutSeconds === undefined
        ? opts.path
        : `${opts.path}?timeoutSeconds=${opts.watchTimeoutSeconds}`;
    this.informer = opts.makeInformer(path, () => this.list());
    this.informer.on("error", (err?: unknown) => void this.onError(err));
    this.informer.on("connect", () => this.markWatchActivity());
    this.informer.on("add", () => this.markWatchActivity());
    this.informer.on("update", () => this.markWatchActivity());
    this.informer.on("delete", () => this.markWatchActivity());
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
    if (this.watchTimeoutMs !== undefined) {
      this.markWatchActivity();
      // Installed first, so a first watch that never comes up is covered too.
      this.stallCheck = setInterval(
        () => void this.checkWatchStalled(),
        Math.min(WATCH_STALL_GRACE_MS, this.watchTimeoutMs)
      );
      this.stallCheck.unref();
    }
    try {
      await this.startInformer();
    } catch (err: unknown) {
      clearInterval(this.stallCheck);
      throw err;
    }
  }

  async stop() {
    if (!this.running) {
      return;
    }
    this.running = false;
    clearInterval(this.stallCheck);
    await this.informer.stop();
  }

  private markWatchActivity() {
    this.lastWatchActivityAt = Date.now();
  }

  /**
   * Skips while a reconnect runs: a reconnect into a blackholed connection ends
   * once the client's header timeout aborts it, and the next check retries.
   */
  private async checkWatchStalled() {
    const quietMs = Date.now() - this.lastWatchActivityAt;
    if (
      !this.running ||
      this.reconnecting ||
      this.watchTimeoutMs === undefined ||
      quietMs <= this.watchTimeoutMs + WATCH_STALL_GRACE_MS
    ) {
      return;
    }
    this.onStallHook?.(quietMs);
    this.markWatchActivity();
    await this.informer.stop();
    // The stopped request's own error arrives while this reconnect waits, and is skipped.
    await this.reconnect(new Error("watch stalled"));
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

  private async onError(err: unknown) {
    if (!this.running) {
      return;
    }
    this.onErrorHook?.(err);
    await this.reconnect(err);
  }

  /**
   * Retries until a start ends with no error raised during it. A watch that
   * fails to connect raises its error inside the start, which still resolves.
   */
  private async reconnect(err: unknown) {
    if (!this.running) {
      return;
    }
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
