// The deterministic watch checks, driven through their REAL functions with plain
// fake readers injected (the waitingRunDiagnosis pattern — no mocks, no IO).
//
// What's pinned here is the four-valued contract: satisfied / pending /
// terminal_unsatisfied, and the rule that a broken data source is `unavailable`
// and never a verdict. Plus the wait LABEL, which must never call a
// time-from-creation a queue wait (VERDICTS.md §4).
import { describe, expect, it } from "vitest";
import {
  checkWatch,
  type WatchCheckDeps,
  type WatchErrorRecurrence,
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
    readErrorRecurrence: async () => null,
    readHealth: async () => null,
    ...overrides,
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

function check(spec: WatchSpec, d: WatchCheckDeps) {
  return checkWatch(spec, d, { now: NOW, since: SINCE });
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
    // Queue wait = startedAt - queuedAt, labelled as a queue wait because
    // queuedAt exists.
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

  // A resume/retry doesn't restamp queuedAt, so the leftover value is not this
  // attempt's queue entry — it must not be measured from, let alone worded as
  // queue latency.
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
    // 11:55 -> 12:00, not 11:50 -> 12:00, and never called a queue wait.
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

  // The one mistake this watch must never make: an analytics bucket that was
  // empty minutes ago says nothing about the runs queued since.
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

  // A stale non-zero depth is still evidence the queue wasn't empty — reported,
  // and marked as the approximation it is.
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

  // The creation-minute case: the count can't be split, so it's a lower bound and
  // the facts say so rather than quoting a number the data can't support.
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

  // Seen before the watch, not since: still pending, and the facts carry when it
  // was last seen so the narration can say that instead of just "nothing".
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

// ---------------------------------------------------------------------------
// The observed outcome — the second half of a resolved result (§4.2).
//
// The resolution says HOW a watch ended; the observation says what was true when
// it did. These pin the observations the presentation actually splits on.
// ---------------------------------------------------------------------------

const queueAbove: WatchSpec = {
  kind: "queue_depth_above",
  queue: "email-sends",
  threshold: 500,
  checkEveryMinutes: 5,
  maxHours: 2,
  note: "tell me if it grows past 500",
};

describe("run_finished — status awareness", () => {
  // The reader PRESERVES the final status. Without it "finished" and "failed"
  // are the same `condition_met` and the banner cannot tell them apart.
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
    // Exactly AT the threshold is not above it.
    expect(below.result).toBe("pending");
  });

  // A quiet queue can grow at any moment — that is what this watch is for. Only
  // the queue disappearing makes the condition impossible.
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

  // The freshness fence is shared verbatim with backlog_drain: a stale empty
  // bucket can no more prove "still below" than it can prove "drained".
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
      errorRecurrence,
      healthRecovery,
    ];
    for (const spec of specs) {
      const outcome = await check(spec, deps());
      expect(outcome.observed.kind).toBe(spec.kind);
    }
  });
});
