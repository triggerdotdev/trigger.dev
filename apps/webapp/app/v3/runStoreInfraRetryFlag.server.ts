import { FEATURE_FLAG } from "~/v3/featureFlags";
import { logger } from "~/services/logger.server";
import { flag } from "./featureFlags.server";

// The run-store blip-retry gate, resolved from the global `runStoreInfraRetryEnabled` flag on a
// background timer and cached in memory. The store consults this synchronously per operation, so:
//   - it does NO database read on the hot path — a connection blip can never turn the gate itself
//     into a failure or disable resilience mid-blip (the last value is held in memory), and
//   - a failing flag read never stampedes the control-plane pool (one timer, not one query per op).
// A failed refresh keeps the last known value; the only cold window is a brand-new process whose
// first refresh has not completed, which resolves to the safe `false`.

const REFRESH_INTERVAL_MS = 30_000;

let current = false;
let started = false;

async function refresh(): Promise<void> {
  try {
    current = await flag({ key: FEATURE_FLAG.runStoreInfraRetryEnabled, defaultValue: false });
  } catch (error) {
    // Keep the last known value: a flag-store blip must not flip resilience on or off.
    logger.debug("runStoreInfraRetry flag refresh failed; keeping last value", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function ensureStarted(): void {
  if (started) {
    return;
  }
  started = true;
  void refresh();
  const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  // Don't keep the process alive for the poll timer.
  timer.unref?.();
}

/** Synchronous, DB-free read of the run-store blip-retry gate. Safe to call on every operation. */
export function isRunStoreInfraRetryEnabled(): boolean {
  ensureStarted();
  return current;
}
