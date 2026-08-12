import { describe, expect, it } from "vitest";
import {
  checkWatch,
  previousCheckFacts,
  type WatchCheckDeps,
  type WatchErrorRecurrence,
  type WatchQueueDepth,
  type WatchRunRow,
} from "~/services/dashboardAgentWatchChecks";
import type { WatchSpec } from "@internal/dashboard-agent-contracts";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const SINCE = new Date("2026-07-27T11:00:00.000Z");

function deps(overrides: Partial<WatchCheckDeps> = {}): WatchCheckDeps {
  return {
    readRun: async () => null,
    queueExists: async () => true,
    readQueueDepth: async () => null,
    readQueueOldestAge: async () => null,
    readErrorRecurrence: async () => null,
    readHealth: async () => null,
    ...overrides,
  };
}

function live(depth: number): WatchQueueDepth {
  return { depth, source: "live_queue", current: true };
}

function stale(depth: number): WatchQueueDepth {
  return {
    depth,
    source: "queue_metrics",
    current: false,
    asOf: new Date("2026-07-27T11:40:00.000Z"),
  };
}

function run(overrides: Partial<WatchRunRow> = {}): WatchRunRow {
  return {
    friendlyId: "run_1",
    status: "PENDING",
    queue: "task/my-task",
    createdAt: new Date("2026-07-27T11:55:00.000Z"),
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    delayUntil: null,
    ...overrides,
  };
}

function check(spec: WatchSpec, d: WatchCheckDeps, previous?: Record<string, unknown> | null) {
  return checkWatch(spec, d, { now: NOW, since: SINCE, previous });
}

const runStart: WatchSpec = {
  kind: "run_start",
  runId: "run_1",
  checkEveryMinutes: 1,
  maxHours: 2,
  note: "tell me when it starts",
};

const runFinished: WatchSpec = {
  kind: "run_finished",
  runId: "run_1",
  checkEveryMinutes: 1,
  maxHours: 2,
  note: "tell me when it finishes",
};

const backlogDrain: WatchSpec = {
  kind: "backlog_drain",
  queue: "task/my-task",
  checkEveryMinutes: 5,
  maxHours: 2,
  note: "tell me when the backlog clears",
};

const errorRecurrence: WatchSpec = {
  kind: "error_recurrence",
  fingerprint: "fp_1",
  checkEveryMinutes: 5,
  maxHours: 2,
  note: "tell me if it comes back",
};

const healthRecovery: WatchSpec = {
  kind: "health_recovery",
  report: "health",
  fromSeverity: "crit",
  checkEveryMinutes: 5,
  maxHours: 2,
  note: "tell me when prod is healthy",
};

describe("run_start", () => {
  it("is satisfied once startedAt exists, whatever the current status is", async () => {
    const outcome = await check(
      runStart,
      deps({
        readRun: async () =>
          run({
            status: "COMPLETED_WITH_ERRORS",
            queuedAt: new Date("2026-07-27T11:56:00.000Z"),
            startedAt: new Date("2026-07-27T11:58:00.000Z"),
          }),
      })
    );

    expect(outcome.result).toBe("satisfied");
    expect(outcome.facts.waitMs).toBe(2 * 60_000);
    expect(outcome.facts.waitBasis).toBe("queued_at");
    expect(outcome.facts.waitLabel).toBe("queued for 2m");
  });

  it("labels a wait with no queuedAt as time from creation, never as a queue wait", async () => {
    const outcome = await check(
      runStart,
      deps({ readRun: async () => run({ status: "PENDING" }) })
    );

    expect(outcome.result).toBe("pending");
    expect(outcome.facts.waitBasis).toBe("created_at");
    expect(outcome.facts.waitLabel).toBe("time from creation: 5m");
    expect(outcome.facts.queueWaitReliable).toBe(false);
  });

  // A resume/retry doesn't restamp queuedAt, so the leftover value is not a queue wait.
  it("does not measure a resumed run's wait from its stale queuedAt", async () => {
    const outcome = await check(
      runStart,
      deps({
        readRun: async () =>
          run({ status: "WAITING_TO_RESUME", queuedAt: new Date("2026-07-27T11:50:00.000Z") }),
      })
    );

    expect(outcome.facts.queueWaitReliable).toBe(false);
    expect(outcome.facts.waitBasis).toBe("created_at");
    // 11:55 -> 12:00, not 11:50 -> 12:00.
    expect(outcome.facts.waitMs).toBe(5 * 60_000);
    expect(outcome.facts.waitLabel).toBe("waiting to resume; time from creation: 5m");
  });

  it("says retry, not resume, for a run waiting on a retry", async () => {
    const outcome = await check(
      runStart,
      deps({
        readRun: async () =>
          run({
            status: "RETRYING_AFTER_FAILURE",
            queuedAt: new Date("2026-07-27T11:50:00.000Z"),
          }),
      })
    );

    expect(outcome.facts.waitLabel).toBe("waiting to retry; time from creation: 5m");
  });

  it("is terminal_unsatisfied when the run reached a terminal status without starting", async () => {
    const outcome = await check(
      runStart,
      deps({ readRun: async () => run({ status: "CANCELED" }) })
    );

    expect(outcome.result).toBe("terminal_unsatisfied");
    expect(outcome.facts.reason).toBe("never_started");
  });

  it("is terminal_unsatisfied when the run is gone from the environment", async () => {
    const outcome = await check(runStart, deps({ readRun: async () => null }));
    expect(outcome.result).toBe("terminal_unsatisfied");
    expect(outcome.facts.reason).toBe("run_not_found");
  });

  it("is unavailable — never a verdict — when the reader fails", async () => {
    const outcome = await check(
      runStart,
      deps({
        readRun: async () => {
          throw new Error("postgres is down");
        },
      })
    );

    expect(outcome.result).toBe("unavailable");
    expect(outcome.facts.reason).toBe("check_failed");
  });
});

describe("run_finished", () => {
  it("is satisfied on a terminal status, with the outcome and execution duration", async () => {
    const outcome = await check(
      runFinished,
      deps({
        readRun: async () =>
          run({
            status: "COMPLETED_SUCCESSFULLY",
            queuedAt: new Date("2026-07-27T11:56:00.000Z"),
            startedAt: new Date("2026-07-27T11:57:00.000Z"),
            completedAt: new Date("2026-07-27T11:59:30.000Z"),
          }),
      })
    );

    expect(outcome.result).toBe("satisfied");
    expect(outcome.facts.outcome).toBe("COMPLETED_SUCCESSFULLY");
    expect(outcome.facts.durationMs).toBe(150_000);
  });

  it("is pending while the run is still executing", async () => {
    const outcome = await check(
      runFinished,
      deps({
        readRun: async () =>
          run({ status: "EXECUTING", startedAt: new Date("2026-07-27T11:58:00.000Z") }),
      })
    );

    expect(outcome.result).toBe("pending");
    expect(outcome.facts.durationMs).toBeNull();
  });
});

describe("backlog_drain", () => {
  it("is satisfied at depth 0", async () => {
    const outcome = await check(
      backlogDrain,
      deps({ readQueueDepth: async () => ({ depth: 0, source: "live_queue", current: true }) })
    );

    expect(outcome.result).toBe("satisfied");
    expect(outcome.facts).toMatchObject({ depth: 0, depthSource: "live_queue" });
  });

  it("is pending while runs are still queued", async () => {
    const outcome = await check(
      backlogDrain,
      deps({
        readQueueDepth: async () => ({ depth: 42, source: "queue_metrics", current: true }),
      })
    );

    expect(outcome.result).toBe("pending");
    expect(outcome.facts.depth).toBe(42);
  });

  it("is unavailable — never drained — when a zero comes from a stale bucket", async () => {
    const asOf = new Date("2026-07-27T11:50:00.000Z");
    const outcome = await check(
      backlogDrain,
      deps({
        readQueueDepth: async () => ({
          depth: 0,
          source: "queue_metrics",
          current: false,
          asOf,
        }),
      })
    );

    expect(outcome.result).toBe("unavailable");
    expect(outcome.facts).toMatchObject({
      reason: "depth_stale",
      depth: 0,
      depthAsOf: asOf.toISOString(),
      depthApproximate: true,
    });
  });

  it("stays pending on a stale non-zero depth, marked approximate", async () => {
    const outcome = await check(
      backlogDrain,
      deps({
        readQueueDepth: async () => ({
          depth: 7,
          source: "queue_metrics",
          current: false,
          asOf: new Date("2026-07-27T11:50:00.000Z"),
        }),
      })
    );

    expect(outcome.result).toBe("pending");
    expect(outcome.facts).toMatchObject({ depth: 7, depthApproximate: true });
  });

  it("is terminal_unsatisfied when the queue doesn't exist", async () => {
    const outcome = await check(
      backlogDrain,
      deps({ readQueueDepth: async () => null, queueExists: async () => false })
    );

    expect(outcome.result).toBe("terminal_unsatisfied");
    expect(outcome.facts.reason).toBe("queue_not_found");
  });

  it("is unavailable when the queue exists but its depth can't be read", async () => {
    const outcome = await check(
      backlogDrain,
      deps({ readQueueDepth: async () => null, queueExists: async () => true })
    );

    expect(outcome.result).toBe("unavailable");
    expect(outcome.facts.reason).toBe("depth_unavailable");
  });

  it("is unavailable when the depth reader throws", async () => {
    const outcome = await check(
      backlogDrain,
      deps({
        readQueueDepth: async () => {
          throw new Error("clickhouse timeout");
        },
      })
    );

    expect(outcome.result).toBe("unavailable");
  });
});

function recurrence(overrides: Partial<WatchErrorRecurrence> = {}): WatchErrorRecurrence {
  return {
    occurredAt: new Date("2026-07-27T11:30:00.000Z"),
    occurredAtPrecision: "minute",
    countSince: 3,
    countApproximate: false,
    lastSeenAt: new Date("2026-07-27T11:45:00.000Z"),
    ...overrides,
  };
}

describe("error_recurrence", () => {
  it("is satisfied on the first occurrence after `since`", async () => {
    const outcome = await check(
      errorRecurrence,
      deps({ readErrorRecurrence: async () => recurrence() })
    );

    expect(outcome.result).toBe("satisfied");
    expect(outcome.facts).toMatchObject({
      occurredAt: "2026-07-27T11:30:00.000Z",
      occurredAtPrecision: "minute",
      countSince: 3,
      countApproximate: false,
      since: SINCE.toISOString(),
    });
  });

  it("carries the precision of an occurrence in the watch's creation minute", async () => {
    const occurredAt = new Date("2026-07-27T11:00:40.000Z");
    const outcome = await check(
      errorRecurrence,
      deps({
        readErrorRecurrence: async () =>
          recurrence({
            occurredAt,
            occurredAtPrecision: "exact",
            countSince: 1,
            countApproximate: true,
            lastSeenAt: occurredAt,
          }),
      })
    );

    expect(outcome.result).toBe("satisfied");
    expect(outcome.facts).toMatchObject({
      occurredAt: occurredAt.toISOString(),
      occurredAtPrecision: "exact",
      countSince: 1,
      countApproximate: true,
    });
  });

  it("is pending when the error has never been seen at all", async () => {
    const outcome = await check(errorRecurrence, deps({ readErrorRecurrence: async () => null }));
    expect(outcome.result).toBe("pending");
    expect(outcome.facts).toMatchObject({ countSince: 0, lastSeenAt: null });
  });

  it("is pending when the error was last seen before `since`", async () => {
    const lastSeenAt = new Date("2026-07-27T10:30:00.000Z");
    const outcome = await check(
      errorRecurrence,
      deps({
        readErrorRecurrence: async () =>
          recurrence({ occurredAt: null, occurredAtPrecision: null, countSince: 0, lastSeenAt }),
      })
    );

    expect(outcome.result).toBe("pending");
    expect(outcome.facts).toMatchObject({ countSince: 0, lastSeenAt: lastSeenAt.toISOString() });
  });

  it("passes the watch's `since` to the reader, not the clock", async () => {
    let seen: Date | undefined;
    await check(
      errorRecurrence,
      deps({
        readErrorRecurrence: async (_fingerprint, since) => {
          seen = since;
          return null;
        },
      })
    );
    expect(seen).toEqual(SINCE);
  });

  it("is unavailable when the reader throws", async () => {
    const outcome = await check(
      errorRecurrence,
      deps({
        readErrorRecurrence: async () => {
          throw new Error("clickhouse down");
        },
      })
    );
    expect(outcome.result).toBe("unavailable");
  });

  // The model cites the API error id; ClickHouse stores the raw fingerprint.
  it("strips the `error_` prefix before reading, and reports the raw fingerprint", async () => {
    let seen: string | undefined;
    const outcome = await check(
      { ...errorRecurrence, fingerprint: "error_abc123" } as WatchSpec,
      deps({
        readErrorRecurrence: async (fingerprint) => {
          seen = fingerprint;
          return null;
        },
      })
    );

    expect(seen).toBe("abc123");
    expect(outcome.facts.fingerprint).toBe("abc123");
  });

  it("passes a raw fingerprint through unchanged", async () => {
    let seen: string | undefined;
    await check(
      { ...errorRecurrence, fingerprint: "abc123" } as WatchSpec,
      deps({
        readErrorRecurrence: async (fingerprint) => {
          seen = fingerprint;
          return null;
        },
      })
    );

    expect(seen).toBe("abc123");
  });
});

describe("health_recovery", () => {
  it("is satisfied when the report is trustworthy and ok", async () => {
    const outcome = await check(
      healthRecovery,
      deps({ readHealth: async () => ({ trustworthy: true, severity: "ok" }) })
    );

    expect(outcome.result).toBe("satisfied");
    expect(outcome.facts).toMatchObject({ severity: "ok", trustworthy: true });
  });

  it("is pending while the report is still warn or crit", async () => {
    for (const severity of ["warn", "crit"] as const) {
      const outcome = await check(
        healthRecovery,
        deps({ readHealth: async () => ({ trustworthy: true, severity }) })
      );
      expect(outcome.result).toBe("pending");
      expect(outcome.facts.severity).toBe(severity);
    }
  });

  it("NEVER fires recovery off an untrustworthy report, even when it says ok", async () => {
    const outcome = await check(
      healthRecovery,
      deps({ readHealth: async () => ({ trustworthy: false, severity: "ok" }) })
    );

    expect(outcome.result).toBe("pending");
    expect(outcome.facts).toMatchObject({ trustworthy: false, reason: "untrustworthy" });
  });

  it("is unavailable when the report can't be produced", async () => {
    const outcome = await check(healthRecovery, deps({ readHealth: async () => null }));
    expect(outcome.result).toBe("unavailable");
    expect(outcome.facts.reason).toBe("report_unavailable");
  });
});

const queueAbove: WatchSpec = {
  kind: "queue_depth_above",
  queue: "email-sends",
  threshold: 500,
  checkEveryMinutes: 5,
  maxHours: 2,
  note: "tell me if it grows past 500",
};

describe("run_finished — status awareness", () => {
  // Without the final status, "finished" and "failed" are the same `condition_met`.
  it("keeps the final status on a completion, whatever it was", async () => {
    for (const status of ["COMPLETED_SUCCESSFULLY", "COMPLETED_WITH_ERRORS", "CRASHED"]) {
      const outcome = await check(
        runFinished,
        deps({
          readRun: async () =>
            run({
              status,
              startedAt: new Date("2026-07-27T11:56:00.000Z"),
              completedAt: new Date("2026-07-27T11:59:00.000Z"),
            }),
        })
      );
      expect(outcome.result).toBe("satisfied");
      expect(outcome.observed).toMatchObject({
        kind: "run_finished",
        verified: true,
        finalStatus: status,
        durationMs: 180_000,
      });
    }
  });

  it("never claims a final status for a run that is still going", async () => {
    const outcome = await check(
      runFinished,
      deps({ readRun: async () => run({ status: "EXECUTING" }) })
    );
    expect(outcome.result).toBe("pending");
    expect(outcome.observed).toMatchObject({ kind: "run_finished", finalStatus: null });
  });

  it("observes nothing verifiable when the run is gone", async () => {
    const outcome = await check(runFinished, deps({ readRun: async () => null }));
    expect(outcome.result).toBe("terminal_unsatisfied");
    expect(outcome.observed).toMatchObject({ kind: "run_finished", finalStatus: null });
  });
});

describe("run_failed", () => {
  const runFailed: WatchSpec = {
    kind: "run_failed",
    runId: "run_1",
    checkEveryMinutes: 1,
    maxHours: 2,
    note: "tell me if it fails",
  };

  const finished = (status: string) =>
    run({
      status,
      startedAt: new Date("2026-07-27T11:56:00.000Z"),
      completedAt: new Date("2026-07-27T11:59:00.000Z"),
    });

  it("is satisfied by a failing terminal status", async () => {
    for (const status of ["COMPLETED_WITH_ERRORS", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT"]) {
      const outcome = await check(runFailed, deps({ readRun: async () => finished(status) }));
      expect(outcome.result).toBe("satisfied");
      expect(outcome.observed).toMatchObject({
        kind: "run_failed",
        verified: true,
        finalStatus: status,
        durationMs: 180_000,
      });
    }
  });

  it("becomes impossible — not pending — once the run succeeds", async () => {
    const outcome = await check(
      runFailed,
      deps({ readRun: async () => finished("COMPLETED_SUCCESSFULLY") })
    );
    expect(outcome.result).toBe("terminal_unsatisfied");
    expect(outcome.observed).toMatchObject({ finalStatus: "COMPLETED_SUCCESSFULLY" });
  });

  it("treats a cancellation as terminal too — it will not fail now", async () => {
    const outcome = await check(runFailed, deps({ readRun: async () => finished("CANCELED") }));
    expect(outcome.result).toBe("terminal_unsatisfied");
  });

  it("keeps waiting while the run is still going, with no verdict on the row", async () => {
    const outcome = await check(
      runFailed,
      deps({ readRun: async () => run({ status: "EXECUTING" }) })
    );
    expect(outcome.result).toBe("pending");
    expect(outcome.observed).toMatchObject({ kind: "run_failed", finalStatus: null });
  });

  it("is unavailable, never a verdict, when the reader throws", async () => {
    const outcome = await check(
      runFailed,
      deps({
        readRun: async () => {
          throw new Error("postgres is down");
        },
      })
    );
    expect(outcome.result).toBe("unavailable");
    expect(outcome.observed).toMatchObject({ kind: "run_failed", verified: false });
  });
});

describe("queue_depth_above", () => {
  it("is the drain check with the comparison inverted", async () => {
    const above = await check(
      queueAbove,
      deps({ readQueueDepth: async () => ({ depth: 612, source: "live_queue", current: true }) })
    );
    expect(above.result).toBe("satisfied");
    expect(above.observed).toMatchObject({
      kind: "queue_depth_above",
      verified: true,
      depth: 612,
      threshold: 500,
    });

    const below = await check(
      queueAbove,
      deps({ readQueueDepth: async () => ({ depth: 500, source: "live_queue", current: true }) })
    );
    // Exactly at the threshold is not above it.
    expect(below.result).toBe("pending");
  });

  it("stays pending on an empty queue and is terminal only when the queue is gone", async () => {
    const empty = await check(
      queueAbove,
      deps({ readQueueDepth: async () => ({ depth: 0, source: "live_queue", current: true }) })
    );
    expect(empty.result).toBe("pending");

    const gone = await check(
      queueAbove,
      deps({ readQueueDepth: async () => null, queueExists: async () => false })
    );
    expect(gone.result).toBe("terminal_unsatisfied");
  });

  it("refuses a stale zero, and marks a stale non-zero approximate", async () => {
    const stale = await check(
      queueAbove,
      deps({
        readQueueDepth: async () => ({
          depth: 0,
          source: "queue_metrics",
          current: false,
          asOf: new Date("2026-07-27T11:40:00.000Z"),
        }),
      })
    );
    expect(stale.result).toBe("unavailable");
    expect(stale.observed).toMatchObject({ kind: "queue_depth_above", verified: false });

    const staleAbove = await check(
      queueAbove,
      deps({
        readQueueDepth: async () => ({
          depth: 900,
          source: "queue_metrics",
          current: false,
          asOf: new Date("2026-07-27T11:40:00.000Z"),
        }),
      })
    );
    expect(staleAbove.result).toBe("satisfied");
    expect(staleAbove.facts).toMatchObject({ depthApproximate: true, threshold: 500 });
  });

  it("reports the depth it read, so the headline needs no second look", async () => {
    const outcome = await check(
      queueAbove,
      deps({ readQueueDepth: async () => ({ depth: 612, source: "live_queue", current: true }) })
    );
    expect(outcome.observed).toMatchObject({ depth: 612, threshold: 500 });
  });
});

const queueBelow: WatchSpec = {
  kind: "queue_depth_below",
  queue: "email-sends",
  threshold: 100,
  checkEveryMinutes: 5,
  maxHours: 2,
  note: "tell me when it's back below 100",
};

const queueStalled: WatchSpec = {
  kind: "queue_stalled",
  queue: "email-sends",
  ticks: 3,
  checkEveryMinutes: 5,
  maxHours: 2,
  note: "tell me if it stops moving",
};

const queueAge: WatchSpec = {
  kind: "queue_oldest_age",
  queue: "email-sends",
  thresholdMinutes: 5,
  checkEveryMinutes: 5,
  maxHours: 2,
  note: "tell me if runs wait longer than 5 minutes",
};

describe("queue_depth_below", () => {
  it("is satisfied at or under the threshold, and the boundary counts", async () => {
    const under = await check(queueBelow, deps({ readQueueDepth: async () => live(42) }));
    expect(under.result).toBe("satisfied");
    expect(under.observed).toMatchObject({
      kind: "queue_depth_below",
      verified: true,
      depth: 42,
      threshold: 100,
    });

    // Unlike `above`, the boundary itself answers: 100 is back below 100.
    const boundary = await check(queueBelow, deps({ readQueueDepth: async () => live(100) }));
    expect(boundary.result).toBe("satisfied");

    const over = await check(queueBelow, deps({ readQueueDepth: async () => live(101) }));
    expect(over.result).toBe("pending");
  });

  it("never satisfies off a stale reading, however low it looks", async () => {
    const outcome = await check(queueBelow, deps({ readQueueDepth: async () => stale(3) }));
    expect(outcome.result).toBe("unavailable");
    expect(outcome.facts).toMatchObject({ reason: "depth_stale", depthApproximate: true });
    expect(outcome.observed).toMatchObject({ kind: "queue_depth_below", verified: false });
  });

  it("stays pending on a stale reading that is still above the line", async () => {
    const outcome = await check(queueBelow, deps({ readQueueDepth: async () => stale(400) }));
    expect(outcome.result).toBe("pending");
    expect(outcome.facts).toMatchObject({ depth: 400, depthApproximate: true });
  });

  it("is terminal only when the queue is gone, and unavailable when unreadable", async () => {
    const gone = await check(
      queueBelow,
      deps({ readQueueDepth: async () => null, queueExists: async () => false })
    );
    expect(gone.result).toBe("terminal_unsatisfied");
    expect(gone.facts.reason).toBe("queue_not_found");

    const unreadable = await check(
      queueBelow,
      deps({ readQueueDepth: async () => null, queueExists: async () => true })
    );
    expect(unreadable.result).toBe("unavailable");
  });
});

describe("queue_stalled — the stateful check", () => {
  const depths = (depth: number) => deps({ readQueueDepth: async () => live(depth) });

  it("counts checks that watched the depth fail to fall, and fires at K", async () => {
    const first = await check(queueStalled, depths(42));
    expect(first.result).toBe("pending");
    expect(first.facts).toMatchObject({ notDecreasingStreak: 0, previousDepth: null, ticks: 3 });

    const second = await check(queueStalled, depths(42), first.facts);
    expect(second.facts.notDecreasingStreak).toBe(1);

    const third = await check(queueStalled, depths(45), second.facts);
    expect(third.facts.notDecreasingStreak).toBe(2);
    expect(third.result).toBe("pending");

    const fourth = await check(queueStalled, depths(45), third.facts);
    expect(fourth.result).toBe("satisfied");
    expect(fourth.observed).toMatchObject({
      kind: "queue_stalled",
      verified: true,
      depth: 45,
      notDecreasingStreak: 3,
      ticks: 3,
    });
  });

  it("resets the streak the moment the queue makes progress", async () => {
    const first = await check(queueStalled, depths(42));
    const second = await check(queueStalled, depths(42), first.facts);
    expect(second.facts.notDecreasingStreak).toBe(1);

    const moved = await check(queueStalled, depths(30), second.facts);
    expect(moved.facts.notDecreasingStreak).toBe(0);
    expect(moved.result).toBe("pending");
  });

  // An `unavailable` tick never overwrites the previous observation, so the streak freezes across the gap.
  it("freezes the streak across a data gap and resumes counting after it", async () => {
    const first = await check(queueStalled, depths(42));
    const second = await check(queueStalled, depths(42), first.facts);
    expect(second.facts.notDecreasingStreak).toBe(1);

    const gap = await check(
      queueStalled,
      deps({ readQueueDepth: async () => null, queueExists: async () => true }),
      second.facts
    );
    expect(gap.result).toBe("unavailable");
    expect(gap.observed).toMatchObject({ verified: false, notDecreasingStreak: 1 });

    const parked = { checkFailed: true, detail: "clickhouse down", previous: second.facts };
    const resumed = await check(queueStalled, depths(42), previousCheckFacts(parked));
    expect(resumed.facts.notDecreasingStreak).toBe(2);
    expect(resumed.result).toBe("pending");

    const fires = await check(queueStalled, depths(42), resumed.facts);
    expect(fires.result).toBe("satisfied");
  });

  it("refuses a stale reading outright rather than sampling it", async () => {
    const first = await check(queueStalled, depths(42));
    const outcome = await check(
      queueStalled,
      deps({ readQueueDepth: async () => stale(42) }),
      first.facts
    );
    expect(outcome.result).toBe("unavailable");
    expect(outcome.facts.reason).toBe("depth_stale");
  });

  it("is never satisfied by an empty queue — that is a drain, not a stall", async () => {
    const first = await check(queueStalled, depths(0));
    const second = await check(queueStalled, depths(0), first.facts);
    const third = await check(queueStalled, depths(0), second.facts);
    const fourth = await check(queueStalled, depths(0), third.facts);
    expect(fourth.result).toBe("pending");
    expect(fourth.facts.notDecreasingStreak).toBe(0);
  });

  it("starts over rather than trusting junk state", async () => {
    for (const previous of [null, {}, { depth: "42" }, { severity: "ok" }]) {
      const outcome = await check(queueStalled, depths(42), previous as Record<string, unknown>);
      expect(outcome.facts.notDecreasingStreak).toBe(0);
      expect(outcome.result).toBe("pending");
    }
  });

  it("is terminal when the queue is gone", async () => {
    const outcome = await check(
      queueStalled,
      deps({ readQueueDepth: async () => null, queueExists: async () => false })
    );
    expect(outcome.result).toBe("terminal_unsatisfied");
    expect(outcome.facts.reason).toBe("queue_not_found");
  });
});

describe("previousCheckFacts", () => {
  it("reads the tick's raw facts, the endpoint's envelope, and unwraps a failure", () => {
    const facts = { depth: 42, notDecreasingStreak: 2 };
    expect(previousCheckFacts(facts)).toEqual(facts);
    expect(previousCheckFacts({ result: "pending", facts, observed: {}, final: false })).toEqual(
      facts
    );
    expect(
      previousCheckFacts({
        checkFailed: true,
        previous: { checkFailed: true, previous: facts },
      })
    ).toEqual(facts);
  });

  it("has no previous observation to offer when there was none", () => {
    expect(previousCheckFacts(null)).toBeNull();
    expect(previousCheckFacts(undefined)).toBeNull();
    expect(previousCheckFacts("nonsense")).toBeNull();
    expect(previousCheckFacts([1, 2])).toBeNull();
    expect(previousCheckFacts({ checkFailed: true })).toBeNull();
  });
});

describe("queue_oldest_age", () => {
  const age = (ageMs: number | null, current = true) =>
    deps({
      readQueueOldestAge: async () => ({
        ageMs,
        source: "live_queue" as const,
        current,
        asOf: NOW,
      }),
    });

  it("is satisfied once the oldest wait passes the SLA, and not on the boundary", async () => {
    const over = await check(queueAge, age(12 * 60_000));
    expect(over.result).toBe("satisfied");
    expect(over.facts).toMatchObject({ ageMs: 720_000, ageLabel: "12m", thresholdMinutes: 5 });
    expect(over.observed).toMatchObject({
      kind: "queue_oldest_age",
      verified: true,
      ageMs: 720_000,
      thresholdMinutes: 5,
    });

    const exactly = await check(queueAge, age(5 * 60_000));
    expect(exactly.result).toBe("pending");

    const under = await check(queueAge, age(5 * 60_000 - 1));
    expect(under.result).toBe("pending");
  });

  it("is pending on an empty queue", async () => {
    const outcome = await check(queueAge, age(null));
    expect(outcome.result).toBe("pending");
    expect(outcome.observed).toMatchObject({ ageMs: null, verified: true });
  });

  it("never satisfies, and never clears, off a stale reading", async () => {
    const stalePastSla = await check(queueAge, age(60 * 60_000, false));
    expect(stalePastSla.result).toBe("unavailable");
    expect(stalePastSla.facts.reason).toBe("age_stale");
    expect(stalePastSla.observed).toMatchObject({ kind: "queue_oldest_age", verified: false });

    const staleUnderSla = await check(queueAge, age(1_000, false));
    expect(staleUnderSla.result).toBe("unavailable");
  });

  it("is terminal when the queue is gone, unavailable when it can't be read", async () => {
    const gone = await check(
      queueAge,
      deps({ readQueueOldestAge: async () => null, queueExists: async () => false })
    );
    expect(gone.result).toBe("terminal_unsatisfied");
    expect(gone.facts.reason).toBe("queue_not_found");

    const unreadable = await check(
      queueAge,
      deps({ readQueueOldestAge: async () => null, queueExists: async () => true })
    );
    expect(unreadable.result).toBe("unavailable");
    expect(unreadable.facts.reason).toBe("age_unavailable");
  });

  it("is unavailable — never a verdict — when the reader throws", async () => {
    const outcome = await check(
      queueAge,
      deps({
        readQueueOldestAge: async () => {
          throw new Error("redis is down");
        },
      })
    );
    expect(outcome.result).toBe("unavailable");
    expect(outcome.observed).toMatchObject({ kind: "queue_oldest_age", verified: false });
  });
});

describe("observations", () => {
  it("marks the observation unverified when a reader throws", async () => {
    const outcome = await check(
      runFinished,
      deps({
        readRun: async () => {
          throw new Error("postgres is down");
        },
      })
    );
    expect(outcome.result).toBe("unavailable");
    expect(outcome.observed).toMatchObject({ kind: "run_finished", verified: false });
  });

  it("never records a severity off an untrustworthy health report", async () => {
    const outcome = await check(
      healthRecovery,
      deps({ readHealth: async () => ({ trustworthy: false, severity: "ok" }) })
    );
    expect(outcome.result).toBe("pending");
    expect(outcome.observed).toMatchObject({
      kind: "health_recovery",
      verified: false,
      severity: null,
    });
  });

  it("gives every kind an observation of its own kind", async () => {
    const specs: WatchSpec[] = [
      runStart,
      runFinished,
      backlogDrain,
      queueAbove,
      queueBelow,
      queueStalled,
      queueAge,
      errorRecurrence,
      healthRecovery,
    ];
    for (const spec of specs) {
      const outcome = await check(spec, deps());
      expect(outcome.observed.kind).toBe(spec.kind);
    }
  });
});
