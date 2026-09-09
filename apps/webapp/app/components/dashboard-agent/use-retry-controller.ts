import type { ChatStatus } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RetryAction } from "./retry-action";
import { isTurnInFlight } from "./turn-deadlines";

export const STOP_FAILED_MESSAGE = "Couldn't stop the previous turn. Try again.";
// If a queued settle outlives this, the local abort was a no-op and `status` will never
// leave submitted/streaming on its own.
export const PENDING_SETTLE_TIMEOUT_MS = 5_000;
// Bounds the server round-trip in `raceStop` so a stalled `stopGeneration` can't delay the
// local abort, or leave retry/dismiss waiting on a `stop()` call that never resolves.
export const STOP_REQUEST_TIMEOUT_MS = 5_000;

// What a queued retry/dismiss does once the aborted turn has actually settled.
// `action: null` means "just clear the error" (dismiss); a real `RetryAction` means
// resend once settled (retry).
type PendingAfterSettle = { action: RetryAction } | null;

export function needsStopFirst(status: ChatStatus, stopFailed: boolean): boolean {
  return isTurnInFlight(status) || stopFailed;
}

/** Whether a stale stop-failure banner should clear: a fresh turn just entered in flight. */
export function shouldClearStaleStopFailure(
  prevStatus: ChatStatus,
  status: ChatStatus,
  hasPendingAfterSettle: boolean
): boolean {
  return !isTurnInFlight(prevStatus) && isTurnInFlight(status) && !hasPendingAfterSettle;
}

export type SettleOutcome = { willResend: boolean; action: RetryAction | null };

/**
 * Races the server stop against `STOP_REQUEST_TIMEOUT_MS`, then always runs the local
 * abort. Returns whether the server side actually armed — callers must not resend when
 * this is `false`, since the old turn may still be writing server-side.
 */
export async function raceStop(deps: {
  stopGeneration: () => Promise<boolean>;
  aiStop: () => unknown;
}): Promise<boolean> {
  try {
    // `.catch` is attached immediately, not just raced: if the server call loses the
    // race but rejects later, that would otherwise be an unhandled rejection.
    const stopGeneration = deps.stopGeneration().catch(() => false);
    const stopped = await Promise.race([
      stopGeneration,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_REQUEST_TIMEOUT_MS)),
    ]);
    await deps.aiStop();
    return stopped;
  } catch {
    // `aiStop` throwing would otherwise surface as an unhandled rejection for a caller
    // (the composer's Stop button) that doesn't attach its own `.catch`.
    return false;
  }
}

export type RetryPhaseOptions = {
  /** Fires once a queued settle outlives `PENDING_SETTLE_TIMEOUT_MS` (the local abort was
   * a no-op). The phase has already abandoned the queued action and recorded a failure. */
  onPendingTimeout?: () => void;
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
};

/**
 * The retry/stop/dismiss/settle state machine, kept independent of React so tests drive
 * the real transitions instead of a parallel copy. `retrying` guards a second click while
 * the first is still waiting on a stop or a settle; `stopFailed` remembers a stop that
 * never armed server-side even though the local abort already settled `status`, so the
 * *next* retry re-attempts the stop instead of reading that settled `status` as safe to
 * resend into; a queued settle is what a retry/dismiss runs once `status` actually leaves
 * submitted/streaming — never inline, since the SDK's own catch/finally for the old turn
 * lands later and would stomp a resend already in flight. The bounded-fallback timer for a
 * queued settle is owned here too (not a separate effect keyed on its own tick), so a
 * settle that lands through `checkSettle` always disarms the same timer that armed it.
 */
export function createRetryPhase(options: RetryPhaseOptions = {}) {
  const onPendingTimeout = options.onPendingTimeout ?? (() => {});
  const setTimer = options.setTimer ?? ((callback, ms) => window.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));

  let retrying = false;
  let stopFailed = false;
  let pendingAfterSettle: PendingAfterSettle = null;
  let timer: number | undefined;
  let disposed = false;

  function stopTimer() {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  }

  function settle(pending: NonNullable<PendingAfterSettle>): SettleOutcome {
    stopTimer();
    retrying = false;
    stopFailed = false;
    return { willResend: !!pending.action, action: pending.action };
  }

  return {
    get stopFailed() {
      return stopFailed;
    },
    get hasPendingAfterSettle() {
      return !!pendingAfterSettle;
    },
    get disposed() {
      return disposed;
    },
    /** Called by `retry`/`dismissError`: `null` means bail out (already busy or
     * disposed); otherwise begins and reports whether the caller must stop the turn
     * first before settling. */
    begin(status: ChatStatus): "stop-then-settle" | "settle-now" | null {
      if (disposed || retrying) return null;
      retrying = true;
      return needsStopFirst(status, stopFailed) ? "stop-then-settle" : "settle-now";
    },
    recordStopFailure(): void {
      stopFailed = true;
      retrying = false;
    },
    recordStopSuccess(): void {
      stopFailed = false;
    },
    /** Queues `pending` for the settle effect, and arms the bounded fallback. A no-op
     * once disposed — an unmounted phase must never arm a timer again. */
    queueForSettle(pending: NonNullable<PendingAfterSettle>): void {
      if (disposed) return;
      pendingAfterSettle = pending;
      stopTimer();
      timer = setTimer(() => {
        timer = undefined;
        pendingAfterSettle = null;
        stopFailed = true;
        retrying = false;
        onPendingTimeout();
      }, PENDING_SETTLE_TIMEOUT_MS);
    },
    settleNow(pending: NonNullable<PendingAfterSettle>): SettleOutcome {
      if (disposed) return { willResend: false, action: null };
      return settle(pending);
    },
    /** The settle effect: runs once `status` actually leaves submitted/streaming. */
    checkSettle(status: ChatStatus): SettleOutcome | null {
      if (!pendingAfterSettle || isTurnInFlight(status)) return null;
      const pending = pendingAfterSettle;
      pendingAfterSettle = null;
      return settle(pending);
    },
    /** The stale-banner effect: clears `stopFailed` on a transition into a fresh turn. */
    clearStaleStopFailure(prevStatus: ChatStatus, status: ChatStatus): boolean {
      if (!stopFailed) return false;
      if (!shouldClearStaleStopFailure(prevStatus, status, !!pendingAfterSettle)) return false;
      stopFailed = false;
      return true;
    },
    /** Cancels the bounded-fallback timer and makes the phase terminal — for unmount.
     * Any in-flight `stopThenQueue` continuation that lands afterward must not be able
     * to arm a fresh timer or resend into an unmounted component. */
    dispose(): void {
      disposed = true;
      pendingAfterSettle = null;
      stopTimer();
    },
  };
}

type RetryPhase = ReturnType<typeof createRetryPhase>;

/**
 * `stop()`'s failure/success recording, factored out so a manual stop (composer's Stop
 * button, unmount) and `stopThenQueue` below share the exact same bookkeeping.
 */
export async function performStop(deps: {
  phase: RetryPhase;
  stopGeneration: () => Promise<boolean>;
  aiStop: () => unknown;
}): Promise<boolean> {
  const stopped = await raceStop({ stopGeneration: deps.stopGeneration, aiStop: deps.aiStop });
  if (stopped) {
    deps.phase.recordStopSuccess();
  } else {
    deps.phase.recordStopFailure();
  }
  return stopped;
}

/**
 * What `retry`/`dismissError` do once they decide a stop is needed first: stop, then queue
 * `pending` for the settle effect only if the server side actually armed. Skips the queue
 * outright on a failed stop — `performStop` already recorded the failure.
 */
export async function stopThenQueue(deps: {
  phase: RetryPhase;
  stop: () => Promise<boolean>;
  pending: NonNullable<PendingAfterSettle>;
}): Promise<boolean> {
  const stopped = await deps.stop();
  if (stopped) deps.phase.queueForSettle(deps.pending);
  return stopped;
}

export type UseRetryControllerOptions = {
  chatId: string;
  transport: { stopGeneration: (chatId: string) => Promise<boolean> };
  /** The AI SDK's own `status`. */
  status: ChatStatus;
  /** The AI SDK's own `stop` — local-only, aborts the current read. */
  stop: () => unknown;
  sendMessage: (message: { text: string; messageId: string }) => unknown;
  regenerate: () => unknown;
  clearError: () => void;
  /**
   * Runs synchronously, right before a settled retry/dismiss resends (or just clears,
   * for a dismiss) — `willResend` is false only for a dismiss. The caller's chance to
   * reset its own turn-scoped state (deadlines, attempt counters) in step.
   */
  onSettled?: (willResend: boolean) => void;
};

export type UseRetryController = {
  /** Stops the in-flight turn: races the server call against `STOP_REQUEST_TIMEOUT_MS`,
   * then always runs the local abort. Also used for a manual stop and on unmount. */
  stop: () => Promise<boolean>;
  retry: (action: RetryAction) => void;
  dismissError: () => void;
  stopFailedError: Error | undefined;
};

/**
 * The retry/stop/dismiss/settle machinery behind a stuck-turn error: stopping the
 * in-flight turn, waiting for it to actually settle before resending (never inline —
 * the old `makeRequest`'s catch/finally lands later and would stomp a turn already
 * resent into), refusing the resend outright if the stop never armed, and a bounded
 * fallback for when the local abort turns out to be a no-op.
 */
export function useRetryController({
  chatId,
  transport,
  status,
  stop: aiStop,
  sendMessage,
  regenerate,
  clearError,
  onSettled,
}: UseRetryControllerOptions): UseRetryController {
  const [stopFailedError, setStopFailedError] = useState<Error | undefined>(undefined);
  // Bumped whenever a settle is queued, so the settle effect below (keyed on `status`
  // alone otherwise) re-runs even when `status` itself hasn't changed.
  const [settleTick, setSettleTick] = useState(0);
  const phaseRef = useRef(
    createRetryPhase({
      onPendingTimeout: () => setStopFailedError(new Error(STOP_FAILED_MESSAGE)),
    })
  );

  useEffect(() => () => phaseRef.current.dispose(), []);

  const stop = useCallback(async (): Promise<boolean> => {
    const stopped = await performStop({
      phase: phaseRef.current,
      stopGeneration: () => transport.stopGeneration(chatId),
      aiStop,
    });
    setStopFailedError(stopped ? undefined : new Error(STOP_FAILED_MESSAGE));
    return stopped;
  }, [transport, chatId, aiStop]);

  const runOutcome = useCallback(
    (outcome: SettleOutcome) => {
      clearError();
      setStopFailedError(undefined);
      onSettled?.(outcome.willResend);
      if (!outcome.action) return;
      if (outcome.action.kind === "regenerate") {
        void regenerate();
        return;
      }
      void sendMessage({ text: outcome.action.text, messageId: outcome.action.messageId });
    },
    [clearError, onSettled, regenerate, sendMessage]
  );

  // `Chat.stop` only aborts — the old `makeRequest`'s catch/finally lands later and, if a
  // new turn had already started (an inline resend), would stomp it. So a resend is never
  // inline; it waits here for `status` to actually leave submitted/streaming.
  useEffect(() => {
    const outcome = phaseRef.current.checkSettle(status);
    if (outcome) runOutcome(outcome);
  }, [status, settleTick, runOutcome]);

  // Clears a stale stop-failure banner once a fresh turn starts (see `shouldClearStaleStopFailure`).
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = status;
    if (!phaseRef.current.clearStaleStopFailure(prevStatus, status)) return;
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setStopFailedError(undefined);
  }, [status]);

  const stopThenSettle = useCallback(
    (pending: NonNullable<PendingAfterSettle>) => {
      void stopThenQueue({ phase: phaseRef.current, stop, pending }).then((stopped) => {
        if (stopped && !phaseRef.current.disposed) setSettleTick((tick) => tick + 1);
      });
    },
    [stop]
  );

  const retry = useCallback(
    (action: RetryAction) => {
      if (!action) return;
      const decision = phaseRef.current.begin(status);
      if (!decision) return;
      if (decision === "stop-then-settle") {
        stopThenSettle({ action });
        return;
      }
      runOutcome(phaseRef.current.settleNow({ action }));
    },
    [status, stopThenSettle, runOutcome]
  );

  // Dismissing a deadline error also stops the turn (rather than leaving it running and
  // just re-arming the deadline): `status` would otherwise stay "submitted"/"streaming"
  // with the composer disabled and no visible way to send another message.
  const dismissError = useCallback(() => {
    const decision = phaseRef.current.begin(status);
    if (!decision) return;
    if (decision === "stop-then-settle") {
      stopThenSettle({ action: null });
      return;
    }
    runOutcome(phaseRef.current.settleNow({ action: null }));
  }, [status, stopThenSettle, runOutcome]);

  return { stop, retry, dismissError, stopFailedError };
}
