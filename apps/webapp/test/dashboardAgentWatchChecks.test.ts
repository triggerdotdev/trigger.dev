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

  it("flags a stale queuedAt on a resumed run rather than trusting it", async () => {
    const outcome = await check(
      runStart,
      deps({
        readRun: async () =>
          run({ status: "WAITING_TO_RESUME", queuedAt: new Date("2026-07-27T11:50:00.000Z") }),
      })
    );

    expect(outcome.facts.queueWaitReliable).toBe(false);
    expect(outcome.facts.waitBasis).toBe("queued_at");
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
      deps({ readQueueDepth: async () => ({ depth: 0, source: "live_queue" }) })
    );

    expect(outcome.result).toBe("satisfied");
    expect(outcome.facts).toMatchObject({ depth: 0, depthSource: "live_queue" });
  });

  it("is pending while runs are still queued", async () => {
    const outcome = await check(
      backlogDrain,
      deps({ readQueueDepth: async () => ({ depth: 42, source: "queue_metrics" }) })
    );

    expect(outcome.result).toBe("pending");
    expect(outcome.facts.depth).toBe(42);
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

describe("error_recurrence", () => {
  it("is satisfied on the first occurrence after `since`", async () => {
    const occurredAt = new Date("2026-07-27T11:30:00.000Z");
    const outcome = await check(
      errorRecurrence,
      deps({ readErrorRecurrence: async () => ({ occurredAt, countSince: 3 }) })
    );

    expect(outcome.result).toBe("satisfied");
    expect(outcome.facts).toMatchObject({
      occurredAt: occurredAt.toISOString(),
      countSince: 3,
      since: SINCE.toISOString(),
    });
  });

  it("is pending while nothing has recurred", async () => {
    const outcome = await check(errorRecurrence, deps({ readErrorRecurrence: async () => null }));
    expect(outcome.result).toBe("pending");
    expect(outcome.facts.countSince).toBe(0);
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
