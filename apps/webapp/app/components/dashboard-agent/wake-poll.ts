/**
 * The wake feed's poll: one self-scheduling chain per mount. A hidden tab asks nothing, a
 * resume catches up once, and neither can fork the chain into a second one.
 */

export const UNREAD_POLL_INTERVAL_MS = 60_000;

// Added to each delay so open tabs never settle into polling on the same second.
const UNREAD_POLL_JITTER_MS = 15_000;

/**
 * Which of the feed's wakes this tab should toast. The feed is recent deliveries, not
 * unread ones, and the local memory of what was toasted is per browser — so `unread` is the
 * only signal shared across machines that a wake has already been seen. A wake landing in
 * an open chat stays unread until that chat's next read, so it still toasts.
 */
export function wakesToToast<T extends { watchId: string; unread?: boolean }>(
  wakes: T[] | undefined,
  toasted: ReadonlySet<string>
): T[] {
  return (wakes ?? []).filter((wake) => wake.unread === true && !toasted.has(wake.watchId));
}

export type WakeToastPlan<T> =
  | { mode: "summary"; count: number }
  | { mode: "individual"; wakes: T[] };

/**
 * Whether this poll's fresh wakes join a grouped summary or each get their own toast.
 * `pending` is the running count of unacknowledged wakes carried from earlier polls; a
 * batch that pushes the total past `max` shows the summary with that cumulative count, so
 * a later batch adds to it rather than replacing it with only its own, smaller number.
 * The returned `pending` is what the caller carries into the next poll; it resets to zero
 * once the user acknowledges (opens the panel).
 */
export function planWakeToasts<T>(
  fresh: T[],
  pending: number,
  max: number
): { plan: WakeToastPlan<T>; pending: number } {
  const total = pending + fresh.length;
  if (total > max) {
    return { plan: { mode: "summary", count: total }, pending: total };
  }
  return { plan: { mode: "individual", wakes: fresh }, pending: total };
}

/**
 * The running pending count, owned by one holder so the poll and the panel cannot drift.
 * Every wake counts until the user opens the panel — by whichever route, including a single
 * wake toast — and opening it clears the count so a later grouped toast claims only wakes
 * still waiting.
 */
export function createWakePendingCount() {
  let pending = 0;

  return {
    plan<T>(fresh: T[], max: number): WakeToastPlan<T> {
      const result = planWakeToasts(fresh, pending, max);
      pending = result.pending;
      return result.plan;
    },
    acknowledge() {
      pending = 0;
    },
  };
}

export type WakePollOptions = {
  load: () => Promise<void>;
  isHidden: () => boolean;
  /** Subscribe to visibility changes; returns its own unsubscribe. */
  onVisibilityChange: (listener: () => void) => () => void;
  /** Seams so a test can drive the chain without real timers. */
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (handle: number) => void;
};

/** Start polling. The returned function stops the chain for good. */
export function startWakePolling(options: WakePollOptions): () => void {
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((callback, ms) => window.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));

  let stopped = false;
  let timer: number | undefined;
  let loading = false;
  // Each tick carries the chain it belongs to, so an orphaned callback returns
  // instead of scheduling itself again.
  let chain = 0;

  const tick = (generation: number) => {
    if (stopped || generation !== chain) return;

    // Scheduled before the load, so a slow response can't stall the chain.
    timer = setTimer(
      () => tick(generation),
      UNREAD_POLL_INTERVAL_MS + random() * UNREAD_POLL_JITTER_MS
    );

    if (loading || options.isHidden()) return;
    loading = true;
    const done = () => {
      loading = false;
    };
    options.load().then(done, done);
  };

  const unsubscribe = options.onVisibilityChange(() => {
    if (stopped || options.isHidden()) return;
    // One catch-up fetch on a new chain, replacing the pending timer rather than
    // adding a second chain.
    if (timer !== undefined) clearTimer(timer);
    chain += 1;
    tick(chain);
  });

  tick(chain);

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
    unsubscribe();
  };
}
