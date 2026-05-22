import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { signalsEmitter } from "~/services/signals.server";
import {
  startStaleSweepInterval,
  type StaleSweepIntervalHandle,
} from "./mollifier/mollifierStaleSweep.server";

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

  const handle = startStaleSweepInterval({
    intervalMs: env.TRIGGER_MOLLIFIER_STALE_SWEEP_INTERVAL_MS,
    staleThresholdMs: env.TRIGGER_MOLLIFIER_STALE_SWEEP_THRESHOLD_MS,
  });

  signalsEmitter.on("SIGTERM", handle.stop);
  signalsEmitter.on("SIGINT", handle.stop);
  global.__mollifierStaleSweepRegistered__ = true;
  global.__mollifierStaleSweepHandle__ = handle;
}
