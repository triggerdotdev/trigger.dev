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

// 0 until the first successful load, then 1. Starts at 0 (not absent) so a
// never-loaded registry is an alertable series, distinct from "feature off".
const registryLoaded = new Gauge({
  name: "reloading_registry_loaded",
  help: "1 once the registry has loaded at least once, else 0 (0 = serving cold fallback)",
  labelNames: ["name"],
  registers: [metricsRegister],
});

export type ReloadingRegistry<T> = {
  isReady: Promise<void>;
  readonly isLoaded: boolean;
  current(): T | undefined;
  reload(): Promise<void>;
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
 * synchronous (`current()`) and return undefined until the first load completes;
 * callers must tolerate that (e.g. fall back to a safe default), the same cold-start
 * contract as the datastore / LLM-pricing registries. Interval-only: no pub/sub
 * (a follow-up if sub-second propagation is ever needed).
 */
export function createReloadingRegistry<T>(opts: ReloadingRegistryOptions<T>): ReloadingRegistry<T> {
  let snapshot: T | undefined;
  let loaded = false;
  let loadSeq = 0;
  let resolveReady!: () => void;
  const isReady = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  let interval: ReturnType<typeof setInterval> | undefined;

  function startReloadInterval() {
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
  }

  async function doLoad() {
    const seq = ++loadSeq;
    const next = await opts.load();
    if (seq < loadSeq) return; // a newer load started while we were awaiting; don't clobber
    snapshot = next;
    lastSuccessfulLoadAt.set({ name: opts.name }, Date.now() / 1000);
    if (!loaded) {
      loaded = true;
      registryLoaded.set({ name: opts.name }, 1);
      resolveReady();
      // Poll only after the first load lands, so the startup retry can't race it.
      if (opts.autoStart !== false) startReloadInterval();
    }
  }

  if (opts.autoStart !== false) {
    registryLoaded.set({ name: opts.name }, 0); // visible cold series until first load

    pRetry(() => doLoad(), {
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
    }).catch((err) => {
      logger.error("[ReloadingRegistry] startup load gave up", {
        name: opts.name,
        error: err instanceof Error ? err.message : String(err),
      });
    });
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
    stop,
  };
}
