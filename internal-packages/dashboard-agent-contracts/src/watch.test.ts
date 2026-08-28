import { describe, expect, it } from "vitest";
import {
  WATCH_FAILED_RUN_STATUSES,
  WATCH_KINDS,
  WATCH_MAX_QUEUE_AGE_MINUTES,
  WATCH_STALL_TICKS_DEFAULT,
  WATCH_STALL_TICKS_MAX,
  WATCH_STALL_TICKS_MIN,
  resolveWatchResult,
  watchConditionVariants,
  watchCheckResultSchema,
  watchDeliveryStatusSchema,
  watchHeadlineKeys,
  watchIdentity,
  watchObservedOutcomeSchema,
  watchResolutionSchema,
  watchResolutionToWireStatus,
  watchResolutions,
  watchResultNeedsAttention,
  watchRunDisposition,
  watchSpecSchema,
  watchStatusSchema,
  type WatchKind,
  type WatchSpec,
} from "./watch.js";
import { watchConditionWording, watchResolvedBlockBody } from "./watch-wording.js";

const common = { maxHours: 6, note: "because I asked" };

const specs = {
  run_start: { ...common, kind: "run_start", runId: "run_123", checkEveryMinutes: 1 },
  run_finished: { ...common, kind: "run_finished", runId: "run_x", checkEveryMinutes: 5 },
  run_failed: { ...common, kind: "run_failed", runId: "run_y", checkEveryMinutes: 5 },
  backlog_drain: { ...common, kind: "backlog_drain", queue: "email-sends", checkEveryMinutes: 5 },
  queue_depth_above: {
    ...common,
    kind: "queue_depth_above",
    queue: "email-sends",
    threshold: 500,
    checkEveryMinutes: 5,
  },
  queue_depth_below: {
    ...common,
    kind: "queue_depth_below",
    queue: "email-sends",
    threshold: 100,
    checkEveryMinutes: 5,
  },
  queue_stalled: {
    ...common,
    kind: "queue_stalled",
    queue: "email-sends",
    ticks: 3,
    checkEveryMinutes: 5,
  },
  queue_oldest_age: {
    ...common,
    kind: "queue_oldest_age",
    queue: "email-sends",
    thresholdMinutes: 5,
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

  /**
   * Kinds that take the same fields share one member, so each of these asks the
   * grouped member to still hold every kind to its own subject and thresholds.
   */
  it("keeps each kind's own required fields", () => {
    for (const [kind, spec] of Object.entries(specs)) {
      for (const field of ["runId", "queue", "fingerprint", "threshold", "thresholdMinutes"]) {
        if (!(field in spec)) continue;
        const { [field]: _dropped, ...without } = spec as Record<string, unknown>;
        expect(watchSpecSchema.safeParse(without).success, `${kind} without ${field}`).toBe(false);
      }
    }
  });

  it("does not let one kind borrow another's subject", () => {
    expect(
      watchSpecSchema.safeParse({ ...common, ...specs.run_start, runId: undefined, queue: "q" })
        .success
    ).toBe(false);
    expect(
      watchSpecSchema.safeParse({
        ...specs.backlog_drain,
        queue: undefined,
        runId: "run_123",
      }).success
    ).toBe(false);
    // A depth kind needs its threshold; `backlog_drain` is not a threshold in disguise.
    expect(
      watchSpecSchema.safeParse({ ...specs.backlog_drain, kind: "queue_depth_above" }).success
    ).toBe(false);
  });

  it("still separates the run cadence floor from the aggregate one, kind by kind", () => {
    for (const [kind, spec] of Object.entries(specs)) {
      const runState = kind.startsWith("run_");
      expect(
        watchSpecSchema.safeParse({ ...spec, checkEveryMinutes: 1 }).success,
        `${kind} at 1 minute`
      ).toBe(runState);
    }
  });
});

describe("watchIdentity", () => {
  it("identifies the condition, not the cadence", () => {
    expect(watchIdentity(specs.run_start)).toBe("run_start:run_123");
    expect(watchIdentity(specs.run_finished)).toBe("run_finished:run_x");
    expect(watchIdentity(specs.run_failed)).toBe("run_failed:run_y");
    expect(watchIdentity(specs.backlog_drain)).toBe("backlog_drain:email-sends");
    expect(watchIdentity(specs.queue_depth_above)).toBe("queue_depth_above:email-sends:500");
    expect(watchIdentity(specs.queue_depth_below)).toBe("queue_depth_below:email-sends:100");
    expect(watchIdentity(specs.queue_stalled)).toBe("queue_stalled:email-sends");
    expect(watchIdentity(specs.queue_oldest_age)).toBe("queue_oldest_age:email-sends:5");
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
    case "run_failed":
      return `failure of ${spec.runId}`;
    case "backlog_drain":
      return `drain of ${spec.queue}`;
    case "queue_depth_above":
      return `${spec.queue} above ${spec.threshold}`;
    case "queue_depth_below":
      return `${spec.queue} back below ${spec.threshold}`;
    case "queue_stalled":
      return `${spec.queue} stalled for ${spec.ticks} checks`;
    case "queue_oldest_age":
      return `${spec.queue} waits over ${spec.thresholdMinutes}m`;
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
  it("handles every kind", () => {
    expect(Object.values(specs).map(describeWatch)).toHaveLength(WATCH_KINDS.length);
    expect(WATCH_KINDS).toHaveLength(10);
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
    expect(watchDeliveryStatusSchema.options).toEqual([
      "not_required",
      "pending",
      "delivering",
      "delivered",
    ]);
  });
});

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
    expect(
      watchIdentity({ ...specs.queue_depth_above, checkEveryMinutes: 60, note: "other" })
    ).toBe(watchIdentity(specs.queue_depth_above));
  });
});

describe("the queue pack (TRI-12890)", () => {
  it("floors all three at the 5-minute aggregate cadence", () => {
    for (const spec of [specs.queue_depth_below, specs.queue_stalled, specs.queue_oldest_age]) {
      expect(watchSpecSchema.safeParse({ ...spec, checkEveryMinutes: 1 }).success).toBe(false);
      expect(watchSpecSchema.safeParse({ ...spec, checkEveryMinutes: 5 }).success).toBe(true);
    }
  });

  it("defaults the stall count rather than asking for it", () => {
    const { ticks, ...withoutTicks } = specs.queue_stalled;
    const parsed = watchSpecSchema.parse(withoutTicks);
    expect(parsed).toMatchObject({ kind: "queue_stalled", ticks: WATCH_STALL_TICKS_DEFAULT });
  });

  it("bounds the stall count", () => {
    expect(
      watchSpecSchema.safeParse({ ...specs.queue_stalled, ticks: WATCH_STALL_TICKS_MIN - 1 })
        .success
    ).toBe(false);
    expect(
      watchSpecSchema.safeParse({ ...specs.queue_stalled, ticks: WATCH_STALL_TICKS_MAX + 1 })
        .success
    ).toBe(false);
    expect(watchSpecSchema.safeParse({ ...specs.queue_stalled, ticks: 1.5 }).success).toBe(false);
  });

  it("requires a positive whole-minute SLA under the watch ceiling", () => {
    expect(
      watchSpecSchema.safeParse({ ...specs.queue_oldest_age, thresholdMinutes: 0 }).success
    ).toBe(false);
    expect(
      watchSpecSchema.safeParse({ ...specs.queue_oldest_age, thresholdMinutes: 1.5 }).success
    ).toBe(false);
    expect(
      watchSpecSchema.safeParse({
        ...specs.queue_oldest_age,
        thresholdMinutes: WATCH_MAX_QUEUE_AGE_MINUTES + 1,
      }).success
    ).toBe(false);
  });

  it("treats the depth threshold and the SLA as part of the identity", () => {
    expect(watchIdentity({ ...specs.queue_depth_below, threshold: 10 })).not.toBe(
      watchIdentity(specs.queue_depth_below)
    );
    expect(watchIdentity({ ...specs.queue_oldest_age, thresholdMinutes: 30 })).not.toBe(
      watchIdentity(specs.queue_oldest_age)
    );
    expect(watchIdentity({ ...specs.queue_stalled, ticks: 8 })).toBe(
      watchIdentity(specs.queue_stalled)
    );
  });

  it("offers the whole queue family under Customize, and the run family separately", () => {
    expect(watchConditionVariants("backlog_drain")).toEqual([
      "backlog_drain",
      "queue_depth_above",
      "queue_depth_below",
      "queue_stalled",
      "queue_oldest_age",
    ]);
    for (const kind of ["queue_depth_below", "queue_stalled", "queue_oldest_age"] as const) {
      expect(watchConditionVariants(kind)).toContain("backlog_drain");
      expect(watchConditionVariants(kind)).toContain(kind);
    }
    // A run watch can be moved between all three of its questions, `run_start` included.
    for (const kind of ["run_start", "run_finished", "run_failed"] as const) {
      expect(watchConditionVariants(kind)).toEqual(["run_start", "run_finished", "run_failed"]);
    }
    expect(watchConditionVariants("health_recovery")).toEqual(["health_recovery"]);
    expect(watchConditionVariants("error_recurrence")).toEqual(["error_recurrence"]);
  });

  it("presents each new kind per §9.1: crossing back below is good, a stall isn't", () => {
    expect(
      resolveWatchResult({ kind: "queue_depth_below", resolution: "condition_met" })
    ).toMatchObject({ category: "positive", headlineKey: "queue_back_below" });
    expect(
      resolveWatchResult({ kind: "queue_depth_below", resolution: "window_completed" })
    ).toMatchObject({ category: "attention", headlineKey: "queue_still_above" });
    expect(
      resolveWatchResult({ kind: "queue_stalled", resolution: "condition_met" })
    ).toMatchObject({ category: "attention", headlineKey: "queue_stalled" });
    expect(
      resolveWatchResult({ kind: "queue_stalled", resolution: "window_completed" })
    ).toMatchObject({ category: "positive", headlineKey: "queue_kept_moving" });
    expect(
      resolveWatchResult({ kind: "queue_oldest_age", resolution: "condition_met" })
    ).toMatchObject({ category: "attention", headlineKey: "queue_wait_over_sla" });
    expect(
      resolveWatchResult({ kind: "queue_oldest_age", resolution: "window_completed" })
    ).toMatchObject({ category: "positive", headlineKey: "queue_wait_under_sla" });
    for (const kind of ["queue_depth_below", "queue_stalled", "queue_oldest_age"] as const) {
      expect(resolveWatchResult({ kind, resolution: "condition_impossible" })).toMatchObject({
        category: "neutral",
        headlineKey: "queue_gone",
      });
    }
  });

  it("answers the attention question for every surface, and never for an unknown kind", () => {
    expect(
      watchResultNeedsAttention({ kind: "backlog_drain", resolution: "window_completed" })
    ).toBe(true);
    expect(watchResultNeedsAttention({ kind: "backlog_drain", resolution: "condition_met" })).toBe(
      false
    );
    expect(
      watchResultNeedsAttention({
        kind: "run_finished",
        resolution: "condition_met",
        outcome: {
          kind: "run_finished",
          verified: true,
          finalStatus: "COMPLETED_WITH_ERRORS",
          durationMs: 4200,
        },
      })
    ).toBe(true);
    expect(
      watchResultNeedsAttention({
        kind: "run_finished",
        resolution: "condition_met",
        outcome: {
          kind: "run_finished",
          verified: true,
          finalStatus: "COMPLETED_SUCCESSFULLY",
          durationMs: 4200,
        },
      })
    ).toBe(false);
    expect(watchResultNeedsAttention({ kind: "not_a_kind", resolution: "condition_met" })).toBe(
      false
    );
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
      { kind: "run_failed", finalStatus: "COMPLETED_WITH_ERRORS", durationMs: 900 },
      { kind: "backlog_drain", depth: 0 },
      { kind: "queue_depth_above", depth: 612, threshold: 500 },
      { kind: "queue_depth_below", depth: 42, threshold: 100 },
      { kind: "queue_stalled", depth: 42, notDecreasingStreak: 3, ticks: 3 },
      { kind: "queue_oldest_age", ageMs: 720_000, thresholdMinutes: 5 },
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
    const required: Partial<Record<WatchKind, Record<string, number>>> = {
      queue_depth_above: { threshold: 500 },
      queue_depth_below: { threshold: 100 },
      queue_stalled: { ticks: 3 },
      queue_oldest_age: { thresholdMinutes: 5 },
    };

    for (const kind of WATCH_KINDS) {
      const outcome = watchObservedOutcomeSchema.parse({
        kind,
        verified: false,
        ...(required[kind] ?? {}),
      });
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

describe("watchResolvedBlockBody", () => {
  const identity = watchIdentity(specs.run_failed as WatchSpec);

  it("marks good news as already true even when the window merely ran out", () => {
    expect(
      watchResolvedBlockBody({
        watchId: "watch_1",
        resolved: { kind: "run_failed", identity, resolution: "window_completed" },
      }).outcome
    ).toBe("already_true");
  });

  it("does not put a success check on bad news the watch caught", () => {
    expect(
      watchResolvedBlockBody({
        watchId: "watch_1",
        resolved: {
          kind: "run_failed",
          identity,
          resolution: "condition_met",
          observed: watchObservedOutcomeSchema.parse({ kind: "run_failed" }),
        },
      }).outcome
    ).toBe("impossible");
  });
});

describe("watchConditionWording", () => {
  it("shortens the fingerprint in the error-recurrence note", () => {
    const note = watchConditionWording({
      ...common,
      kind: "error_recurrence",
      fingerprint: "error_c4b4",
      checkEveryMinutes: 15,
    }).note;

    expect(note).not.toContain("error error_");
    expect(note).toBe("ping me if error c4b4 happens again");
  });
});
