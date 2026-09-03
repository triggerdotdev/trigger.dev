import { FEATURE_FLAG } from "~/v3/featureFlags";
import { logger } from "~/services/logger.server";
import { flag } from "./featureFlags.server";

// The run-store blip-retry gate, resolved from the global `runStoreInfraRetryEnabled` flag on a
// background timer and held in memory. The store consults it SYNCHRONOUSLY per operation, so:
//   - the operation path does ZERO database work and never awaits — a blip can neither add latency
//     nor turn the gate itself into a failure or disable resilience mid-blip (the last value is held),
//   - a failing refresh keeps the last known value, and
//   - a single background timer (not one query per op) never stampedes the control-plane pool.
// The poller is warmed at process startup (see startRunStoreInfraRetryFlagPoller). The only cold
// window is a brand-new process before its first read completes, which safely reads `false`.

const REFRESH_INTERVAL_MS = 30_000;

let current = false;
let started = false;
let warmup: Promise<void> | null = null;

async function refresh(): Promise<boolean> {
  try {
    current = await flag({ key: FEATURE_FLAG.runStoreInfraRetryEnabled, defaultValue: false });
    return true;
  } catch (error) {
    // Keep the last known value: a flag-store blip must not flip resilience on or off.
    logger.debug("runStoreInfraRetry flag refresh failed; keeping last value", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function initialRead(): Promise<void> {
  // Bounded retry of the FIRST read so a brief blip at startup doesn't leave resilience off until the
  // next tick. Never on the operation path. If the store is unreachable the whole window, `current`
  // stays at the safe default (false) and self-heals on a later tick.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await refresh()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Start the background poller once (idempotent). Call at process startup to warm the gate before
 * traffic. It kicks off the initial read and the refresh timer WITHOUT blocking; the returned promise
 * resolves when the first read settles, so a caller MAY await readiness at boot, but the operation
 * path never does.
 */
export function startRunStoreInfraRetryFlagPoller(): Promise<void> {
  if (started) {
    return warmup ?? Promise.resolve();
  }
  started = true;
  warmup = initialRead();
  const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  timer.unref?.(); // don't keep the process alive for the poll timer
  return warmup;
}

/**
 * The run-store blip-retry gate: a PURELY SYNCHRONOUS, database-free read of the in-memory value the
 * background poller maintains. It never awaits and does no database work, so it adds no latency and
 * cannot itself fail or hang during a blip. It only ensures the poller is running (non-blocking) as a
 * fallback for entrypoints that skip the explicit startup warm.
 */
export function isRunStoreInfraRetryEnabled(): boolean {
  startRunStoreInfraRetryFlagPoller();
  return current;
}
