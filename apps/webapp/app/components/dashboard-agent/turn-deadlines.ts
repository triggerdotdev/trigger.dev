/**
 * Bounded waits during a live turn: "first event" (nothing streamed yet) and "tool
 * pending" (one tool call stuck). Both clear the moment the watched condition changes.
 */

export const FIRST_EVENT_DEADLINE_MS = 45_000;
export const TOOL_PENDING_DEADLINE_MS = 120_000;

export type TurnDeadlineError = { kind: "first-event" } | { kind: "tool-pending"; tool: string };

/**
 * Null unless a turn is live. A dangling `input-available` part on an idle chat isn't a
 * pending call, and arming a timer for it would fire with nothing able to clear it.
 */
export function activeToolPendingKey(status: string, inFlightTool: string | null): string | null {
  const inFlight = status === "streaming" || status === "submitted";
  return inFlight ? inFlightTool : null;
}

export function turnDeadlineErrorMessage(
  error: TurnDeadlineError,
  toolLabel: (tool: string) => string
): string {
  if (error.kind === "first-event") {
    return "The agent hasn't started responding. It may not be running — try again.";
  }
  return `${toolLabel(error.tool)} is taking longer than expected. It may not be running — try again.`;
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
  /** Stop the timer and forget the key, without calling `onClear`. For unmount. */
  dispose: () => void;
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
    dispose() {
      stopTimer();
      currentKey = null;
    },
  };
}
