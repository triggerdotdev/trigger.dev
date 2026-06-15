import pRetry from "p-retry";
import { Counter, Gauge } from "prom-client";
import { metricsRegister } from "~/metrics.server";
import { logger } from "~/services/logger.server";
import { signalsEmitter } from "~/services/signals.server";

const loadFailures = new Counter({
  name: "reloading_registry_load_failures_total",
  help: "Failed loads of a reloading registry",
  labelNames: ["name"],
  registers: [metricsRegister],
});

const lastSuccessfulLoadAt = new Gauge({
  name: "reloading_registry_last_successful_load_timestamp_seconds",
  help: "Unix time of the last successful registry load (staleness signal)",
  labelNames: ["name"],
  registers: [metricsRegister],
});

export type ReloadingRegistry<T> = {
  isReady: Promise<void>;
  readonly isLoaded: boolean;
  current(): T | undefined;
  reload(): Promise<void>;
  waitUntilReady(timeoutMs: number): Promise<void>;
  stop(): void;
};

export type ReloadingRegistryOptions<T> = {
  /** Tag for metrics + logs. */
  name: string;
  /** Loads the full snapshot from the source of truth. */
  load: () => Promise<T>;
  /** How often to reload after the first successful load. */
  intervalMs: number;
  /** Startup retry config; defaults to forever with backoff. */
  retry?: { retries?: number };
  /** Start the background load + interval at construction. Default true; set false to keep inert (e.g. tests). */
  autoStart?: boolean;
};

/**
 * In-memory snapshot loaded at startup and refreshed on an interval. Reads are
 * synchronous (`current()`); the first read should gate on `waitUntilReady` so a
 * cold replica never serves a default over a real value. Mirrors the datastore /
 * LLM-pricing registries. Interval-only: no pub/sub (a follow-up if sub-second
 * propagation is ever needed).
 */
export function createReloadingRegistry<T>(opts: ReloadingRegistryOptions<T>): ReloadingRegistry<T> {
  let snapshot: T | undefined;
  let loaded = false;
  let started = false;
  let loadSeq = 0;
  let resolveReady!: () => void;
  const isReady = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  async function doLoad() {
    const seq = ++loadSeq;
    const next = await opts.load();
    if (seq < loadSeq) return; // a newer load started while we were awaiting; don't clobber
    snapshot = next;
    lastSuccessfulLoadAt.set({ name: opts.name }, Date.now() / 1000);
    if (!loaded) {
      loaded = true;
      resolveReady();
    }
  }

  let interval: ReturnType<typeof setInterval> | undefined;

  if (opts.autoStart !== false) {
    started = true;

    const startup = pRetry(() => doLoad(), {
      forever: opts.retry?.retries === undefined,
      retries: opts.retry?.retries,
      minTimeout: 1_000,
      maxTimeout: 60_000,
      factor: 2,
      onFailedAttempt: (error) => {
        loadFailures.inc({ name: opts.name });
        logger.warn("[ReloadingRegistry] startup load failed, retrying", {
          name: opts.name,
          attemptNumber: error.attemptNumber,
          retriesLeft: error.retriesLeft,
          error: error.message,
        });
      },
    });
    startup.catch((err) => {
      logger.error("[ReloadingRegistry] startup load gave up", {
        name: opts.name,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    interval = setInterval(() => {
      doLoad().catch((err) => {
        loadFailures.inc({ name: opts.name });
        logger.warn("[ReloadingRegistry] reload failed", {
          name: opts.name,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, opts.intervalMs);
    interval.unref(); // never keep the process alive; SIGTERM still clears it
  } else {
    resolveReady(); // inert: any direct `await isReady` resolves immediately
  }

  function stop() {
    if (interval) clearInterval(interval);
  }
  signalsEmitter.on("SIGTERM", stop);
  signalsEmitter.on("SIGINT", stop);

  return {
    isReady,
    get isLoaded() {
      return loaded;
    },
    current: () => snapshot,
    reload: doLoad,
    async waitUntilReady(timeoutMs: number) {
      if (!started || loaded || timeoutMs <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          isReady,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    stop,
  };
}
