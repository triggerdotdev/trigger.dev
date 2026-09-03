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
let initPromise: Promise<void> | null = null;

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

function ensureStarted(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }
  // One initial read, shared by all early callers, so a globally-enabled flag is effective from the
  // FIRST operation of a fresh process (not only after the first background tick). Later calls await
  // this already-resolved promise and return the in-memory value with no further database work.
  initPromise = refresh();
  const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  timer.unref?.(); // don't keep the process alive for the poll timer
  return initPromise;
}

/**
 * The run-store blip-retry gate. The first call awaits a single initial read (so op #1 sees the real
 * flag); every later call resolves from the in-memory value with no database work — so the gate does
 * no per-op DB read, survives a blip (last value held), and never stampedes the control-plane pool.
 */
export async function isRunStoreInfraRetryEnabled(): Promise<boolean> {
  await ensureStarted();
  return current;
}
