import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRetryPhase,
  needsStopFirst,
  PENDING_SETTLE_TIMEOUT_MS,
  performStop,
  raceStop,
  shouldClearStaleStopFailure,
  stopThenQueue,
  STOP_FAILED_MESSAGE,
  STOP_REQUEST_TIMEOUT_MS,
} from "./use-retry-controller";

type RetryAction = { kind: "regenerate" } | { kind: "resend"; messageId: string; text: string };

/** A `createRetryPhase` wired with fake timers instead of `window.setTimeout`. */
function fakeTimerPhase(onPendingTimeout?: () => void) {
  return createRetryPhase({
    onPendingTimeout,
    setTimer: (callback, ms) => setTimeout(callback, ms) as unknown as number,
    clearTimer: (handle) => clearTimeout(handle as unknown as NodeJS.Timeout),
  });
}

describe("needsStopFirst", () => {
  it("requires a stop first while the turn is in flight, even with no prior failure", () => {
    expect(needsStopFirst("submitted", false)).toBe(true);
    expect(needsStopFirst("streaming", false)).toBe(true);
  });

  it("requires a stop first when a prior stop failed, even once status looks settled", () => {
    expect(needsStopFirst("ready", true)).toBe(true);
  });

  it("resolves inline once settled with no unresolved prior failure", () => {
    expect(needsStopFirst("ready", false)).toBe(false);
    expect(needsStopFirst("error", false)).toBe(false);
  });
});

describe("shouldClearStaleStopFailure", () => {
  // The exact regression this guards: composer Stop -> stopGeneration false -> banner
  // shown; status settles to "ready"; the user sends an unrelated new message (status
  // transitions ready -> "submitted" with nothing queued waiting on the old stop). The
  // stale banner must clear so its Dismiss doesn't stop the *new* turn.
  it("clears on the transition into in-flight, with nothing pending settle", () => {
    expect(shouldClearStaleStopFailure("ready", "submitted", false)).toBe(true);
    expect(shouldClearStaleStopFailure("error", "streaming", false)).toBe(true);
  });

  // The other half of the regression this guards: a failure was recorded while the
  // turn was ALREADY in flight (the failed stop's own turn, not a new one) — moving
  // submitted -> streaming never leaves in-flight, so this must not read as a fresh
  // turn starting and wipe the banner mid-stuck-turn.
  it("does not clear on submitted -> streaming inside the same still-in-flight turn", () => {
    expect(shouldClearStaleStopFailure("submitted", "streaming", false)).toBe(false);
  });

  it("does not clear while status stays settled — no transition into in-flight at all", () => {
    expect(shouldClearStaleStopFailure("ready", "ready", false)).toBe(false);
  });

  it("does not clear when the in-flight dip is the very turn still awaiting its own settle", () => {
    expect(shouldClearStaleStopFailure("ready", "submitted", true)).toBe(false);
  });
});

describe("raceStop", () => {
  it("returns true and still runs the local abort when the server call resolves in time", async () => {
    const aiStop = vi.fn();
    const stopped = await raceStop({ stopGeneration: () => Promise.resolve(true), aiStop });
    expect(stopped).toBe(true);
    expect(aiStop).toHaveBeenCalledTimes(1);
  });

  it("resolves false without waiting once the bound elapses, but still aborts locally", async () => {
    vi.useFakeTimers();
    try {
      const aiStop = vi.fn();
      const pending = raceStop({ stopGeneration: () => new Promise(() => {}), aiStop });
      await vi.advanceTimersByTimeAsync(STOP_REQUEST_TIMEOUT_MS);
      expect(await pending).toBe(false);
      expect(aiStop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a rejected server call as a failed stop, not an unhandled rejection", async () => {
    const aiStop = vi.fn();
    const stopped = await raceStop({
      stopGeneration: () => Promise.reject(new Error("network down")),
      aiStop,
    });
    expect(stopped).toBe(false);
    expect(aiStop).toHaveBeenCalledTimes(1);
  });

  it("returns false when the local abort itself throws", async () => {
    const stopped = await raceStop({
      stopGeneration: () => Promise.resolve(true),
      aiStop: () => {
        throw new Error("abort failed");
      },
    });
    expect(stopped).toBe(false);
  });
});

describe("createRetryPhase: the retry/dismiss/settle state machine behind useRetryController", () => {
  const resend: RetryAction = { kind: "resend", messageId: "m1", text: "hi" };

  it("a second click while the first is still busy is a no-op — exactly one request", () => {
    const phase = createRetryPhase();
    expect(phase.begin("ready")).toBe("settle-now");
    // Still busy: nothing has settled yet.
    expect(phase.begin("ready")).toBeNull();
    expect(phase.begin("submitted")).toBeNull();

    const outcome = phase.settleNow({ action: resend });
    expect(outcome).toEqual({ willResend: true, action: resend });
    // Settled — a subsequent click is no longer a no-op.
    expect(phase.begin("ready")).toBe("settle-now");
  });

  it("reports stop-then-settle while the turn is in flight, settle-now once it's ready", () => {
    const phase = createRetryPhase();
    expect(phase.begin("submitted")).toBe("stop-then-settle");
  });

  it("queues past an in-flight turn and settles exactly once status leaves it", () => {
    vi.useFakeTimers();
    try {
      const phase = fakeTimerPhase();
      phase.begin("submitted");
      phase.queueForSettle({ action: resend });

      expect(phase.checkSettle("submitted")).toBeNull();
      expect(phase.checkSettle("streaming")).toBeNull();

      const outcome = phase.checkSettle("ready");
      expect(outcome).toEqual({ willResend: true, action: resend });
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismiss settles with a null action — clear only, no resend", () => {
    const phase = createRetryPhase();
    phase.begin("ready");
    expect(phase.settleNow({ action: null })).toEqual({ willResend: false, action: null });
  });

  it("a recorded stop failure survives the local abort's settle, refusing the next inline resend", () => {
    const phase = createRetryPhase();
    phase.recordStopFailure();
    // `needsStopFirst` is what `begin` actually consults; this is the exact race it guards.
    expect(phase.begin("ready")).toBe("stop-then-settle");
  });

  it("a successful stop clears a prior failure", () => {
    const phase = createRetryPhase();
    phase.recordStopFailure();
    phase.recordStopSuccess();
    expect(phase.stopFailed).toBe(false);
  });

  it("clears a stale stop-failure banner only on the real transition, reusing shouldClearStaleStopFailure", () => {
    const phase = createRetryPhase();
    phase.recordStopFailure();
    expect(phase.clearStaleStopFailure("submitted", "streaming")).toBe(false);
    expect(phase.clearStaleStopFailure("ready", "submitted")).toBe(true);
    expect(phase.stopFailed).toBe(false);
  });
});

describe("createRetryPhase: bounded-fallback timer", () => {
  const resend: RetryAction = { kind: "resend", messageId: "m1", text: "hi" };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Regression: a normal settle must disarm the *same* timer `queueForSettle` armed —
  // not rely on a separately-scheduled effect noticing the settle happened.
  it("a normal settle before the bound cancels the fallback timer — no bogus failure later", async () => {
    const onPendingTimeout = vi.fn();
    const phase = fakeTimerPhase(onPendingTimeout);
    phase.begin("submitted");
    phase.queueForSettle({ action: resend });

    const outcome = phase.checkSettle("ready");
    expect(outcome).toEqual({ willResend: true, action: resend });

    await vi.advanceTimersByTimeAsync(PENDING_SETTLE_TIMEOUT_MS);
    expect(onPendingTimeout).not.toHaveBeenCalled();
    expect(phase.stopFailed).toBe(false);
  });

  it("fires onPendingTimeout and records a failure when nothing settles in time", async () => {
    const onPendingTimeout = vi.fn();
    const phase = fakeTimerPhase(onPendingTimeout);
    phase.begin("submitted");
    phase.queueForSettle({ action: resend });

    await vi.advanceTimersByTimeAsync(PENDING_SETTLE_TIMEOUT_MS);
    expect(onPendingTimeout).toHaveBeenCalledTimes(1);
    expect(phase.stopFailed).toBe(true);
    expect(phase.hasPendingAfterSettle).toBe(false);
    // The abandoned action never fires even once status later leaves in-flight.
    expect(phase.checkSettle("ready")).toBeNull();
  });

  it("dispose cancels a pending timer without recording a failure", async () => {
    const onPendingTimeout = vi.fn();
    const phase = fakeTimerPhase(onPendingTimeout);
    phase.begin("submitted");
    phase.queueForSettle({ action: resend });

    phase.dispose();
    await vi.advanceTimersByTimeAsync(PENDING_SETTLE_TIMEOUT_MS);
    expect(onPendingTimeout).not.toHaveBeenCalled();
  });
});

describe("performStop", () => {
  it("records success on the phase when the server armed", async () => {
    const phase = createRetryPhase();
    phase.recordStopFailure();
    const stopped = await performStop({
      phase,
      stopGeneration: () => Promise.resolve(true),
      aiStop: () => {},
    });
    expect(stopped).toBe(true);
    expect(phase.stopFailed).toBe(false);
  });

  // What the composer's manual Stop button (or unmount teardown) relies on: a stop that
  // never went through `retry`/`dismissError` still leaves the phase (and so the next
  // retry) knowing the server never armed, banner-worthy via `STOP_FAILED_MESSAGE`.
  it("records a failure on the phase when the server never armed", async () => {
    const phase = createRetryPhase();
    const stopped = await performStop({
      phase,
      stopGeneration: () => Promise.resolve(false),
      aiStop: () => {},
    });
    expect(stopped).toBe(false);
    expect(phase.stopFailed).toBe(true);
    // The hook surfaces this as `new Error(STOP_FAILED_MESSAGE)` — the manual-stop banner.
    expect(STOP_FAILED_MESSAGE).toMatch(/Couldn't stop/);
    expect(phase.begin("ready")).toBe("stop-then-settle");
  });
});

describe("stopThenQueue", () => {
  const resend: RetryAction = { kind: "resend", messageId: "m1", text: "hi" };

  it("queues the pending settle once `stop` reports the server armed", async () => {
    vi.useFakeTimers();
    try {
      const phase = fakeTimerPhase();
      const stopped = await stopThenQueue({
        phase,
        stop: () => Promise.resolve(true),
        pending: { action: resend },
      });
      expect(stopped).toBe(true);
      expect(phase.hasPendingAfterSettle).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // The exact race `stop`'s return value exists to prevent: the old turn may still be
  // writing server-side, so a failed stop must never leave anything queued to resend into.
  it("does not queue anything when `stop` reports the server never armed", async () => {
    const phase = createRetryPhase();
    const stopped = await stopThenQueue({
      phase,
      stop: () => Promise.resolve(false),
      pending: { action: resend },
    });
    expect(stopped).toBe(false);
    expect(phase.hasPendingAfterSettle).toBe(false);
    // Never fires even once status later leaves in-flight.
    expect(phase.checkSettle("ready")).toBeNull();
  });

  // The unmount race this guards: `stopThenQueue`'s stop promise is still pending when
  // `dispose()` runs, so its `.then` continuation lands afterward and must not be able to
  // arm a fresh fallback timer on the now-disposed phase.
  it("dispose while the stop promise is pending leaves the settled continuation a no-op", async () => {
    vi.useFakeTimers();
    try {
      const onPendingTimeout = vi.fn();
      const phase = fakeTimerPhase(onPendingTimeout);
      let resolveStop!: (stopped: boolean) => void;
      const stopPromise = new Promise<boolean>((resolve) => {
        resolveStop = resolve;
      });

      const pending = stopThenQueue({
        phase,
        stop: () => stopPromise,
        pending: { action: resend },
      });

      phase.dispose();
      resolveStop(true);
      expect(await pending).toBe(true);
      expect(phase.hasPendingAfterSettle).toBe(false);

      await vi.advanceTimersByTimeAsync(PENDING_SETTLE_TIMEOUT_MS);
      expect(onPendingTimeout).not.toHaveBeenCalled();
      expect(phase.hasPendingAfterSettle).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
