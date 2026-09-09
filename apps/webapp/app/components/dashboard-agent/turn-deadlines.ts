/**
 * Bounded waits during a live turn: "no first event" (nothing streamed yet) and "tool
 * hung" (one tool call stuck). Both clear the moment the watched condition changes.
 */

export const NO_FIRST_EVENT_DEADLINE_MS = 45_000;
export const TOOL_HUNG_DEADLINE_MS = 120_000;

export type TurnDeadlineState = "no_first_event" | "tool_hung";

/**
 * Whether the AI SDK's `status` means a turn is still running server-side. Both
 * deadlines can only ever be live in this window, so anything gating a fresh send (or
 * showing the stop affordance) must use the same predicate — a narrower one (e.g.
 * `status === "streaming"` alone) would let a send through while a deadline error is
 * still showing.
 */
export function isTurnInFlight(status: string): boolean {
  return status === "submitted" || status === "streaming";
}

/** The no-first-event deadline's key: armed only while nothing has streamed yet. */
export function noFirstEventKey(status: string): "submitted" | null {
  return status === "submitted" ? "submitted" : null;
}

export type KeyedDeadlineOptions<K extends string> = {
  deadlineMs: number;
  onTimeout: (key: K) => void;
  /** Called whenever a previously-active key stops being active, fired or not. */
  onClear: () => void;
  /** Seams so a test can drive the timer without real ones. */
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
};

export type KeyedDeadline<K extends string> = {
  /** Call with the currently active key, or null for none. A no-op if it hasn't changed. */
  sync: (key: K | null) => void;
  /** Stop the timer and forget the key, without calling `onClear`. For unmount or retry. */
  reset: () => void;
};

/**
 * Timer starts when `sync` sees a new key, fires `onTimeout` if it's still active after
 * `deadlineMs`, and clears (`onClear`) whenever the key changes away, fired or not.
 */
export function createKeyedDeadline<K extends string>(
  options: KeyedDeadlineOptions<K>
): KeyedDeadline<K> {
  const setTimer = options.setTimer ?? ((callback, ms) => window.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));

  let currentKey: K | null = null;
  let timer: number | undefined;

  function stopTimer() {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  }

  return {
    sync(key) {
      if (key === currentKey) return;
      const hadKey = currentKey !== null;
      stopTimer();
      currentKey = key;
      if (hadKey) options.onClear();
      if (key === null) return;
      timer = setTimer(() => {
        timer = undefined;
        options.onTimeout(key);
      }, options.deadlineMs);
    },
    reset() {
      stopTimer();
      currentKey = null;
    },
  };
}
