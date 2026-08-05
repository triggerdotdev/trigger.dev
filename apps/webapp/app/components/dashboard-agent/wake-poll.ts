/**
 * The wake feed's poll: one self-scheduling chain per mount. A hidden tab asks nothing, a
 * resume catches up once, and neither can fork the chain into a second one.
 */

export const UNREAD_POLL_INTERVAL_MS = 60_000;

// Added to each delay so open tabs never settle into polling on the same second.
export const UNREAD_POLL_JITTER_MS = 15_000;

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
