import { describe, expect, it } from "vitest";
import {
  WATCH_FAILED_RUN_STATUSES,
  WATCH_KINDS,
  resolveWatchResult,
  watchCheckResultSchema,
  watchDeliveryStatusSchema,
  watchHeadlineKeys,
  watchIdentity,
  watchObservedOutcomeSchema,
  watchResolutionSchema,
  watchResolutionToWireStatus,
  watchResolutions,
  watchRunDisposition,
  watchSpecSchema,
  watchStatusSchema,
  type WatchKind,
  type WatchSpec,
} from "./watch.js";

const common = { maxHours: 6, note: "because I asked" };

const specs = {
  run_start: { ...common, kind: "run_start", runId: "run_123", checkEveryMinutes: 1 },
  run_finished: { ...common, kind: "run_finished", runId: "run_x", checkEveryMinutes: 5 },
  backlog_drain: { ...common, kind: "backlog_drain", queue: "email-sends", checkEveryMinutes: 5 },
  queue_depth_above: {
    ...common,
    kind: "queue_depth_above",
    queue: "email-sends",
    threshold: 500,
    checkEveryMinutes: 5,
  },
  error_recurrence: {
    ...common,
    kind: "error_recurrence",
    fingerprint: "a1b2c3",
    checkEveryMinutes: 15,
  },
  health_recovery: {
    ...common,
    kind: "health_recovery",
    report: "health",
    fromSeverity: "warn",
    checkEveryMinutes: 60,
  },
} satisfies Record<string, WatchSpec>;

describe("watchSpecSchema", () => {
  it("accepts every kind", () => {
    for (const spec of Object.values(specs)) {
      expect(watchSpecSchema.safeParse(spec).success).toBe(true);
    }
  });

  it("allows a 1-minute cadence for run-state watches", () => {
    expect(watchSpecSchema.safeParse({ ...specs.run_finished, checkEveryMinutes: 1 }).success).toBe(
      true
    );
  });

  it("rejects a 1-minute cadence for aggregate watches", () => {
    expect(
      watchSpecSchema.safeParse({ ...specs.backlog_drain, checkEveryMinutes: 1 }).success
    ).toBe(false);
    expect(
      watchSpecSchema.safeParse({ ...specs.error_recurrence, checkEveryMinutes: 1 }).success
    ).toBe(false);
    expect(
      watchSpecSchema.safeParse({ ...specs.queue_depth_above, checkEveryMinutes: 1 }).success
    ).toBe(false);
    expect(
      watchSpecSchema.safeParse({ ...specs.health_recovery, checkEveryMinutes: 1 }).success
    ).toBe(false);
  });

  it("rejects an off-grid cadence", () => {
    expect(watchSpecSchema.safeParse({ ...specs.run_start, checkEveryMinutes: 3 }).success).toBe(
      false
    );
    expect(
      watchSpecSchema.safeParse({ ...specs.backlog_drain, checkEveryMinutes: 30 }).success
    ).toBe(false);
  });

  it("enforces the 24 hour ceiling", () => {
    expect(watchSpecSchema.safeParse({ ...specs.run_start, maxHours: 24 }).success).toBe(true);
    expect(watchSpecSchema.safeParse({ ...specs.run_start, maxHours: 25 }).success).toBe(false);
    expect(watchSpecSchema.safeParse({ ...specs.run_start, maxHours: 0 }).success).toBe(false);
  });

  it("requires a note", () => {
    const { note, ...withoutNote } = specs.run_start;
    expect(watchSpecSchema.safeParse(withoutNote).success).toBe(false);
  });

  it("does not accept a client-supplied `since` on error_recurrence", () => {
    const parsed = watchSpecSchema.parse({
      ...specs.error_recurrence,
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed).not.toHaveProperty("since");
  });

  it("rejects an unknown kind", () => {
    expect(watchSpecSchema.safeParse({ ...common, kind: "run_slow", runId: "run_1" }).success).toBe(
      false
    );
  });
});

describe("watchIdentity", () => {
  it("identifies the condition, not the cadence", () => {
    expect(watchIdentity(specs.run_start)).toBe("run_start:run_123");
    expect(watchIdentity(specs.run_finished)).toBe("run_finished:run_x");
    expect(watchIdentity(specs.backlog_drain)).toBe("backlog_drain:email-sends");
    expect(watchIdentity(specs.queue_depth_above)).toBe("queue_depth_above:email-sends:500");
    expect(watchIdentity(specs.error_recurrence)).toBe("error_recurrence:a1b2c3");
    expect(watchIdentity(specs.health_recovery)).toBe("health_recovery:health");
  });

  it("ignores cadence, note, and maxHours", () => {
    expect(
      watchIdentity({
        ...specs.backlog_drain,
        checkEveryMinutes: 60,
        note: "different",
        maxHours: 1,
      })
    ).toBe(watchIdentity(specs.backlog_drain));
  });

  it("covers every kind exhaustively", () => {
    for (const kind of WATCH_KINDS) {
      expect(watchIdentity(specs[kind])).toContain(`${kind}:`);
    }
  });
});

// Compile-time exhaustiveness: adding a WatchSpec variant breaks this switch.
function describeWatch(spec: WatchSpec): string {
  switch (spec.kind) {
    case "run_start":
      return `start of ${spec.runId}`;
    case "run_finished":
      return `finish of ${spec.runId}`;
    case "backlog_drain":
      return `drain of ${spec.queue}`;
    case "queue_depth_above":
      return `${spec.queue} above ${spec.threshold}`;
    case "error_recurrence":
      return `recurrence of ${spec.fingerprint}`;
    case "health_recovery":
      return `recovery from ${spec.fromSeverity}`;
    default: {
      const unreachable: never = spec;
      throw new Error(`Unhandled: ${JSON.stringify(unreachable)}`);
    }
  }
}

describe("exhaustiveness", () => {
  it("handles all six kinds", () => {
    expect(Object.values(specs).map(describeWatch)).toHaveLength(6);
    expect(WATCH_KINDS).toHaveLength(6);
  });
});

describe("enums", () => {
  it("check results", () => {
    expect(watchCheckResultSchema.options).toEqual([
      "pending",
      "satisfied",
      "terminal_unsatisfied",
      "unavailable",
    ]);
  });

  it("statuses", () => {
    expect(watchStatusSchema.options).toEqual(["active", "fired", "expired", "cancelled"]);
    expect(watchDeliveryStatusSchema.options).toEqual(["not_required", "pending", "delivered"]);
  });
});

/* ------------------------------------------------------------------ *
 * The resolution model
 * ------------------------------------------------------------------ */

describe("queue_depth_above", () => {
  it("requires a non-negative integer threshold", () => {
    expect(watchSpecSchema.safeParse({ ...specs.queue_depth_above, threshold: 0 }).success).toBe(
      true
    );
    expect(watchSpecSchema.safeParse({ ...specs.queue_depth_above, threshold: -1 }).success).toBe(
      false
    );
    expect(watchSpecSchema.safeParse({ ...specs.queue_depth_above, threshold: 1.5 }).success).toBe(
      false
    );
  });

  it("treats the threshold as part of the identity", () => {
    expect(watchIdentity({ ...specs.queue_depth_above, threshold: 5000 })).not.toBe(
      watchIdentity(specs.queue_depth_above)
    );
    // …but not the cadence or the note, same as every other kind.
    expect(
      watchIdentity({ ...specs.queue_depth_above, checkEveryMinutes: 60, note: "other" })
    ).toBe(watchIdentity(specs.queue_depth_above));
  });
});

describe("resolutions", () => {
  it("has three values, and `unavailable` is not one of them", () => {
    expect(watchResolutionSchema.options).toEqual([
      "condition_met",
      "window_completed",
      "condition_impossible",
    ]);
    expect(watchResolutions).not.toContain("unavailable");
  });

  // §7.5 binding: the wire keeps its as-built two-value encoding, so persisted
  // wake ids, delivery ids and banner render keys stay valid.
  it("encodes onto the stable two-value wire status", () => {
    expect(watchResolutionToWireStatus("condition_met")).toBe("fired");
    expect(watchResolutionToWireStatus("window_completed")).toBe("expired");
    expect(watchResolutionToWireStatus("condition_impossible")).toBe("expired");
  });
});

describe("watchRunDisposition", () => {
  it("splits success from failure from cancellation", () => {
    expect(watchRunDisposition("COMPLETED_SUCCESSFULLY")).toBe("succeeded");
    expect(watchRunDisposition("CANCELED")).toBe("cancelled");
    expect(watchRunDisposition(null)).toBe("unknown");
    for (const status of WATCH_FAILED_RUN_STATUSES) {
      expect(watchRunDisposition(status)).toBe("failed");
    }
  });
});

describe("watchObservedOutcomeSchema", () => {
  it("accepts one shape per kind", () => {
    const outcomes = [
      { kind: "run_start", started: true, status: "EXECUTING" },
      { kind: "run_finished", finalStatus: "COMPLETED_SUCCESSFULLY", durationMs: 1200 },
      { kind: "backlog_drain", depth: 0 },
      { kind: "queue_depth_above", depth: 612, threshold: 500 },
      { kind: "error_recurrence", countSince: 3 },
      { kind: "health_recovery", severity: "ok" },
    ];
    for (const outcome of outcomes) {
      expect(watchObservedOutcomeSchema.safeParse(outcome).success).toBe(true);
    }
    expect(outcomes).toHaveLength(WATCH_KINDS.length);
  });

  it("defaults `verified` to true", () => {
    const parsed = watchObservedOutcomeSchema.parse({ kind: "backlog_drain", depth: 0 });
    expect(parsed.verified).toBe(true);
  });
});

describe("resolveWatchResult", () => {
  it("covers every kind × resolution cell", () => {
    for (const kind of WATCH_KINDS) {
      for (const resolution of watchResolutions) {
        const result = resolveWatchResult({ kind, resolution });
        expect(watchHeadlineKeys).toContain(result.headlineKey);
        expect(["positive", "attention", "neutral"]).toContain(result.category);
      }
    }
  });

  // §4.2: one resolution, two opposite presentations. This is the whole reason
  // the resolution alone is insufficient.
  it("splits run_finished on the observed final status", () => {
    const ok = resolveWatchResult({
      kind: "run_finished",
      resolution: "condition_met",
      outcome: {
        kind: "run_finished",
        verified: true,
        finalStatus: "COMPLETED_SUCCESSFULLY",
        durationMs: null,
      },
    });
    const failed = resolveWatchResult({
      kind: "run_finished",
      resolution: "condition_met",
      outcome: {
        kind: "run_finished",
        verified: true,
        finalStatus: "COMPLETED_WITH_ERRORS",
        durationMs: null,
      },
    });

    expect(ok).toMatchObject({ category: "positive", headlineKey: "run_finished" });
    expect(failed).toMatchObject({ category: "attention", headlineKey: "run_failed" });
  });

  // Binding (§4.2): "a failed run must never wear a success check".
  it("gives the failed run a non-success icon", () => {
    const failed = resolveWatchResult({
      kind: "run_finished",
      resolution: "condition_met",
      outcome: { kind: "run_finished", verified: true, finalStatus: "CRASHED", durationMs: null },
    });
    expect(failed.semanticIcon).not.toBe("success");
    expect(failed.tone).toBe("error");
  });

  it("presents a cancelled run neutrally, not as a success", () => {
    expect(
      resolveWatchResult({
        kind: "run_finished",
        resolution: "condition_met",
        outcome: {
          kind: "run_finished",
          verified: true,
          finalStatus: "CANCELED",
          durationMs: null,
        },
      })
    ).toMatchObject({ category: "neutral", headlineKey: "run_cancelled" });
  });

  it("does not infer tone from a good-news kind list", () => {
    // Same resolution, opposite categories — proof the mapping is per kind.
    expect(
      resolveWatchResult({ kind: "backlog_drain", resolution: "window_completed" }).category
    ).toBe("attention");
    expect(
      resolveWatchResult({ kind: "error_recurrence", resolution: "window_completed" }).category
    ).toBe("positive");
    expect(
      resolveWatchResult({ kind: "queue_depth_above", resolution: "window_completed" }).category
    ).toBe("positive");
    expect(
      resolveWatchResult({ kind: "queue_depth_above", resolution: "condition_met" }).category
    ).toBe("attention");
  });

  it("says the condition could not be confirmed when the final read failed", () => {
    for (const kind of WATCH_KINDS) {
      const outcome = watchObservedOutcomeSchema.parse(
        kind === "queue_depth_above"
          ? { kind, verified: false, threshold: 500 }
          : { kind, verified: false }
      );
      expect(
        resolveWatchResult({ kind: kind as WatchKind, resolution: "window_completed", outcome })
      ).toMatchObject({ category: "neutral", headlineKey: "unverified_at_window_end" });
    }
  });

  it("never claims a met condition was unverified", () => {
    const outcome = watchObservedOutcomeSchema.parse({ kind: "backlog_drain", verified: false });
    expect(
      resolveWatchResult({ kind: "backlog_drain", resolution: "condition_met", outcome })
        .headlineKey
    ).toBe("queue_drained");
  });
});
