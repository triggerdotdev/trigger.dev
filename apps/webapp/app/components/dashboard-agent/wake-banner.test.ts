// What the user reads before the narration. Two rules are pinned here:
//
//  1. The banner shows the FACT, not a generic "watch update — all clear".
//  2. The presentation comes from the resolution PLUS the observed outcome — the
//     wire encoding in the message id (`fired`/`expired`) is only an address.
import { describe, expect, it } from "vitest";
import { wakePresentation, wakeRefFromMessageId, wakeResolution } from "./WakeBanner";

const runWatch = {
  id: "watch_1",
  kind: "run_finished",
  identity: "run_finished:run_abc123",
  note: "tell me when the nightly invoice run finishes",
};

describe("wakeRefFromMessageId", () => {
  // §7.5 binding: the transport keeps its two-value suffix, so persisted wakes
  // and banner render keys stay valid under the resolution model.
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

  // The whole reason the resolution alone is insufficient (§4.2).
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
    // Binding: a failed run never wears a success check.
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
      headline: "Error a1b2c3d4 happened again",
      category: "attention",
    });
    expect(wakePresentation("expired", { ...error, resolution: "window_completed" })).toMatchObject(
      { headline: "Error a1b2c3d4 stayed quiet", category: "positive" }
    );
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
