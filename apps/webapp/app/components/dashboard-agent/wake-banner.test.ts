import { describe, expect, it } from "vitest";
import { wakePresentation, wakeRefFromMessageId, wakeResolution } from "./WakeBanner";
import { watchWakeToastTitle } from "./WatchWakeToast";

const runWatch = {
  id: "watch_1",
  kind: "run_finished",
  identity: "run_finished:run_abc123",
  note: "tell me when the nightly invoice run finishes",
};

describe("wakeRefFromMessageId", () => {
  it("still reads the as-built two-value wake id", () => {
    expect(wakeRefFromMessageId("wake:watch:watch_1:fired")).toEqual({
      watchId: "watch_1",
      outcome: "fired",
    });
    expect(wakeRefFromMessageId("wake:watch:watch_1:expired")).toEqual({
      watchId: "watch_1",
      outcome: "expired",
    });
    expect(wakeRefFromMessageId("msg_1")).toBeNull();
  });
});

describe("wakeResolution", () => {
  it("prefers the row's resolution", () => {
    expect(wakeResolution("expired", { resolution: "condition_impossible" })).toBe(
      "condition_impossible"
    );
  });

  it("reconstructs one for a row written before the resolution column", () => {
    expect(wakeResolution("fired", { endedReason: null })).toBe("condition_met");
    expect(wakeResolution("expired", { endedReason: "terminal_unsatisfied" })).toBe(
      "condition_impossible"
    );
    expect(wakeResolution("expired", { endedReason: "not_met_by_expiry" })).toBe(
      "window_completed"
    );
    expect(wakeResolution("expired", undefined)).toBe("window_completed");
  });
});

describe("wakePresentation", () => {
  it("states the fact, not a generic watch update", () => {
    const presented = wakePresentation("fired", {
      ...runWatch,
      resolution: "condition_met",
      observedOutcome: {
        kind: "run_finished",
        verified: true,
        finalStatus: "COMPLETED_SUCCESSFULLY",
        durationMs: 4200,
      },
    });
    expect(presented.headline).toBe("Run run_abc123 finished");
    expect(presented.label).toBe("Watch update");
    expect(presented.category).toBe("positive");
  });

  it("shows a failed run as a failure, on the same resolution", () => {
    const presented = wakePresentation("fired", {
      ...runWatch,
      resolution: "condition_met",
      observedOutcome: {
        kind: "run_finished",
        verified: true,
        finalStatus: "COMPLETED_WITH_ERRORS",
        durationMs: null,
      },
    });
    expect(presented.headline).toBe("Run run_abc123 failed");
    expect(presented.category).toBe("attention");
    expect(presented.semanticIcon).not.toBe("success");
  });

  it("names the queue in a drain headline", () => {
    expect(
      wakePresentation("fired", {
        id: "watch_2",
        kind: "backlog_drain",
        identity: "backlog_drain:email-sends",
        note: "",
        resolution: "condition_met",
      }).headline
    ).toBe("email-sends queue drained");
  });

  it("reports the threshold watch with its number", () => {
    expect(
      wakePresentation("fired", {
        id: "watch_3",
        kind: "queue_depth_above",
        identity: "queue_depth_above:email-sends:500",
        note: "",
        resolution: "condition_met",
        observedOutcome: {
          kind: "queue_depth_above",
          verified: true,
          depth: 612,
          threshold: 500,
        },
      }).headline
    ).toBe("email-sends queue is still above 500");
  });

  it("treats a completed window as an answer, not silence", () => {
    const presented = wakePresentation("expired", {
      id: "watch_4",
      kind: "backlog_drain",
      identity: "backlog_drain:email-sends",
      note: "",
      resolution: "window_completed",
      observedOutcome: { kind: "backlog_drain", verified: true, depth: 42 },
    });
    expect(presented.headline).toBe("email-sends queue is still at 42");
    expect(presented.category).toBe("attention");
  });

  it("says the condition couldn't be confirmed when the final read failed", () => {
    expect(
      wakePresentation("expired", {
        id: "watch_5",
        kind: "backlog_drain",
        identity: "backlog_drain:email-sends",
        note: "",
        resolution: "window_completed",
        observedOutcome: { kind: "backlog_drain", verified: false, depth: null },
      }).headline
    ).toBe("The watch ended without a confirmed answer");
  });

  it("falls back without guessing an outcome when the watch is gone", () => {
    const presented = wakePresentation("fired", undefined);
    expect(presented.headline).toBe("The watch woke this chat up on its own.");
    expect(presented.category).toBe("neutral");
  });

  it("says an error recurred, and that a quiet window was good news", () => {
    const error = {
      id: "watch_6",
      kind: "error_recurrence",
      identity: "error_recurrence:a1b2c3d4e5f6",
      note: "",
    };
    expect(wakePresentation("fired", { ...error, resolution: "condition_met" })).toMatchObject({
      headline: "Error a1b2c3d4e5f6 happened again",
      category: "attention",
    });
    expect(wakePresentation("expired", { ...error, resolution: "window_completed" })).toMatchObject(
      { headline: "Error a1b2c3d4e5f6 stayed quiet", category: "positive" }
    );
  });

  it("says a queue came back below its threshold, and when it never did", () => {
    const below = {
      id: "watch_below",
      kind: "queue_depth_below",
      identity: "queue_depth_below:email-sends:100",
      note: "",
    };
    expect(
      wakePresentation("fired", {
        ...below,
        resolution: "condition_met",
        observedOutcome: { kind: "queue_depth_below", verified: true, depth: 42, threshold: 100 },
      })
    ).toMatchObject({ headline: "email-sends queue is back below 100", category: "positive" });

    expect(
      wakePresentation("expired", {
        ...below,
        resolution: "window_completed",
        observedOutcome: { kind: "queue_depth_below", verified: true, depth: 780, threshold: 100 },
      })
    ).toMatchObject({ headline: "email-sends queue is still above 100", category: "attention" });
  });

  it("says a queue is stuck at the depth it stalled on, and that it kept moving", () => {
    const stalled = {
      id: "watch_stalled",
      kind: "queue_stalled",
      identity: "queue_stalled:email-sends",
      note: "",
    };
    expect(
      wakePresentation("fired", {
        ...stalled,
        resolution: "condition_met",
        observedOutcome: {
          kind: "queue_stalled",
          verified: true,
          depth: 42,
          notDecreasingStreak: 3,
          ticks: 3,
        },
      })
    ).toMatchObject({ headline: "email-sends queue is stuck at 42", category: "attention" });

    expect(
      wakePresentation("expired", {
        ...stalled,
        resolution: "window_completed",
        observedOutcome: {
          kind: "queue_stalled",
          verified: true,
          depth: 3,
          notDecreasingStreak: 1,
          ticks: 3,
        },
      })
    ).toMatchObject({ headline: "email-sends queue kept moving", category: "positive" });
  });

  it("states the wait and the limit it passed, in minutes", () => {
    const age = {
      id: "watch_age",
      kind: "queue_oldest_age",
      identity: "queue_oldest_age:email-sends:5",
      note: "",
    };
    expect(
      wakePresentation("fired", {
        ...age,
        resolution: "condition_met",
        observedOutcome: {
          kind: "queue_oldest_age",
          verified: true,
          ageMs: 12 * 60_000,
          thresholdMinutes: 5,
        },
      })
    ).toMatchObject({
      headline: "runs in email-sends are waiting 12m (over your 5m limit)",
      category: "attention",
    });

    expect(
      wakePresentation("expired", {
        ...age,
        resolution: "window_completed",
        observedOutcome: {
          kind: "queue_oldest_age",
          verified: true,
          ageMs: 30_000,
          thresholdMinutes: 5,
        },
      })
    ).toMatchObject({ headline: "email-sends queue stayed under 5m", category: "positive" });
  });

  it("names the queue, not the threshold, when a queue-pack watch's queue is gone", () => {
    for (const [kind, identity] of [
      ["queue_depth_below", "queue_depth_below:email-sends:100"],
      ["queue_stalled", "queue_stalled:email-sends"],
      ["queue_oldest_age", "queue_oldest_age:email-sends:5"],
    ] as const) {
      expect(
        wakePresentation("expired", {
          id: `watch_${kind}`,
          kind,
          identity,
          note: "",
          resolution: "condition_impossible",
        })
      ).toMatchObject({ headline: "email-sends queue no longer exists", category: "neutral" });
    }
  });

  it("recovers health without naming an identity", () => {
    expect(
      wakePresentation("fired", {
        id: "watch_7",
        kind: "health_recovery",
        identity: "health_recovery:health",
        note: "",
        resolution: "condition_met",
      }).headline
    ).toBe("Health recovered");
  });
});

describe("watchWakeToastTitle", () => {
  const wake = {
    watchId: "watch_1",
    chatId: "chat_1",
    note: "tell me when the nightly invoice run finishes",
  };

  it("leads with the fact, not the notification", () => {
    expect(
      watchWakeToastTitle({
        ...wake,
        outcome: "fired",
        kind: "backlog_drain",
        identity: "backlog_drain:email-sends",
        resolution: "condition_met",
      })
    ).toBe("email-sends queue drained");
  });

  it("follows the observed outcome, so a failed run is never good news", () => {
    expect(
      watchWakeToastTitle({
        ...wake,
        outcome: "fired",
        kind: "run_finished",
        identity: "run_finished:run_abc123",
        resolution: "condition_met",
        observedOutcome: {
          kind: "run_finished",
          verified: true,
          finalStatus: "COMPLETED_WITH_ERRORS",
          durationMs: 1200,
        },
      })
    ).toBe("Run run_abc123 failed");
  });

  it("reconstructs a resolution for a row written before the model existed", () => {
    expect(
      watchWakeToastTitle({
        ...wake,
        outcome: "expired",
        kind: "backlog_drain",
        identity: "backlog_drain:email-sends",
      })
    ).toBe("email-sends queue still hasn't drained");
  });

  it("claims nothing when the wake carries no watch at all", () => {
    expect(watchWakeToastTitle({ ...wake, outcome: "fired" })).toBe(
      "The watch woke this chat up on its own."
    );
  });
});
