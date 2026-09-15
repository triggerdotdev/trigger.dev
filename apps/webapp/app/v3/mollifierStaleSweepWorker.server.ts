import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { signalsEmitter } from "~/services/signals.server";
import {
  startStaleSweepInterval,
  type StaleSweepIntervalHandle,
} from "./mollifier/mollifierStaleSweep.server";
import { MollifierStaleSweepState } from "./mollifier/mollifierStaleSweepState.server";

declare global {
  // eslint-disable-next-line no-var
  var __mollifierStaleSweepRegistered__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __mollifierStaleSweepHandle__: StaleSweepIntervalHandle | undefined;
}

/**
 * Bootstraps the mollifier stale-entry sweep.
 *
 * Independent of the drainer — its purpose is to alert when entries are
 * piling up despite the drainer being supposedly healthy, so it runs
 * any time the mollifier itself is enabled (gated separately from
 * `TRIGGER_MOLLIFIER_DRAINER_ENABLED`). The sweep is read-only: it
 * counts and logs stale entries but does not remove or salvage them.
 *
 * The Remix dev server re-evaluates `entry.server.tsx` on every change,
 * so the registration guard + handle cache make the bootstrap
 * idempotent across hot reloads.
 */
export function initMollifierStaleSweepWorker(): void {
  if (env.TRIGGER_MOLLIFIER_STALE_SWEEP_ENABLED !== "1") return;
  if (global.__mollifierStaleSweepRegistered__) return;

  logger.debug("Initializing mollifier stale-entry sweep", {
    intervalMs: env.TRIGGER_MOLLIFIER_STALE_SWEEP_INTERVAL_MS,
    staleThresholdMs: env.TRIGGER_MOLLIFIER_STALE_SWEEP_THRESHOLD_MS,
  });

  // Construct the sweep's durable-state Redis client using the same
  // mollifier-Redis credentials as the buffer. Keeping this client
  // separate from the buffer's own client keeps state ownership clean:
  // the buffer abstracts queue/entry state, this abstracts sweep state.
  const state = new MollifierStaleSweepState({
    redisOptions: {
      keyPrefix: "",
      host: env.TRIGGER_MOLLIFIER_REDIS_HOST,
      port: env.TRIGGER_MOLLIFIER_REDIS_PORT,
      username: env.TRIGGER_MOLLIFIER_REDIS_USERNAME,
      password: env.TRIGGER_MOLLIFIER_REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.TRIGGER_MOLLIFIER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    maxRetriesPerRequest: env.TRIGGER_MOLLIFIER_REDIS_MAX_RETRIES_PER_REQUEST,
  });

  const handle = startStaleSweepInterval(
    {
      intervalMs: env.TRIGGER_MOLLIFIER_STALE_SWEEP_INTERVAL_MS,
      staleThresholdMs: env.TRIGGER_MOLLIFIER_STALE_SWEEP_THRESHOLD_MS,
      maxEntriesPerEnv: env.TRIGGER_MOLLIFIER_STALE_SWEEP_MAX_ENTRIES_PER_ENV,
      maxOrgsPerPass: env.TRIGGER_MOLLIFIER_STALE_SWEEP_MAX_ORGS_PER_PASS,
    },
    { state }
  );

  // `handle.stop` is now async (it closes the Redis client). The signals
  // emitter swallows promise rejections from listeners, so wrap it in a
  // void-returning shim to be explicit about discarding the promise.
  const onShutdown = (): void => {
    void handle.stop();
  };
  signalsEmitter.on("SIGTERM", onShutdown);
  signalsEmitter.on("SIGINT", onShutdown);
  global.__mollifierStaleSweepRegistered__ = true;
  global.__mollifierStaleSweepHandle__ = handle;
}
