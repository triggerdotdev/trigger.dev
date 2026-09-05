// A lost transition append is survivable for a Postgres-backed run: Postgres already committed and
// holds the head, so the decorator records the failure, enqueues a Postgres-based repair, and
// returns. For a redis-only-BORN run Postgres holds no snapshot, so a lost transition is
// unrecoverable — the repair cannot help — and the append must THROW so the caller sees the loss,
// mirroring the birth path. The gate is keyed on the run's FIXED birth residency, not the live dial.
import { describe, expect, it } from "vitest";
import {
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreModeResolver,
} from "./taskRunExecutionSnapshotStore.js";
import type { RedisSnapshotStore } from "./redisSnapshotStore.js";
import type { RunRegime } from "./runRegimeCache.js";
import type { RunStore } from "./types.js";

const ORG = "org_a";

function harness(opts: {
  /** The run's fixed birth residency, as this process knows it. */
  regime: RunRegime;
  /** When set, append RESOLVES with this outcome instead of rejecting (the returned-outcome path). */
  appendResult?: { outcome: string; actualCur?: string; seq?: number };
}) {
  const delegateCalls: string[] = [];
  const repairs: string[] = [];
  const regime = new Map<string, RunRegime>([["run_1", opts.regime]]);

  const redis = new Proxy({} as RedisSnapshotStore, {
    get: (_t, prop) => {
      if (prop === "regimeFor") return (runId: string) => regime.get(runId);
      if (prop === "recordRegime")
        return (runId: string, r: RunRegime) => {
          regime.set(runId, r);
        };
      if (prop === "append") {
        return () =>
          opts.appendResult
            ? Promise.resolve(opts.appendResult)
            : Promise.reject(new Error("redis append boom"));
      }
      // No waitpoints in this transition, so #resolveCycle never probes.
      return () => Promise.resolve(null);
    },
  });

  const delegate = new Proxy({} as Record<string, unknown>, {
    get:
      (_t, prop) =>
      (...__: unknown[]) => {
        delegateCalls.push(String(prop));
        return Promise.resolve({ id: "run_1" });
      },
  }) as unknown as RunStore;

  // A plain dual-write dial, only so the transition takes the mirror path; the fatality is decided
  // by the run's regime above, never by this.
  const modeResolver: SnapshotStoreModeResolver = {
    resolve: () => "dual-write",
  };

  const decorated = new TaskRunExecutionSnapshotStore(delegate, {
    store: redis,
    mode: "dual-write",
    modeResolver,
    onAppendFailure: async ({ runId }) => {
      repairs.push(runId);
    },
  });
  return { decorated, delegateCalls, repairs };
}

function completeParams() {
  return [
    "run_1",
    {
      completedAt: new Date(),
      outputType: "application/json",
      usageDurationMs: 1,
      costInCents: 0,
      snapshot: {
        id: "snap_1",
        executionStatus: "FINISHED",
        description: "Run completed",
        runStatus: "COMPLETED_SUCCESSFULLY",
        attemptNumber: 1,
        environmentId: "env_1",
        environmentType: "PRODUCTION",
        projectId: "proj_1",
        organizationId: ORG,
      },
    },
    { select: { id: true } },
  ] as never[];
}

describe("transition append fatality is decided by the run's fixed residency", () => {
  it("throws and enqueues NO repair when the run was born redis-only", async () => {
    const { decorated, repairs } = harness({ regime: "redis-only" });

    await expect(
      (decorated.completeAttemptSuccess as (...a: never[]) => Promise<unknown>)(...completeParams())
    ).rejects.toThrow(/redis append boom/);
    expect(repairs).toEqual([]);
  });

  it("does NOT throw and enqueues a repair for a Postgres-backed run", async () => {
    const { decorated, repairs } = harness({ regime: "postgres" });

    await expect(
      (decorated.completeAttemptSuccess as (...a: never[]) => Promise<unknown>)(...completeParams())
    ).resolves.toBeDefined();
    expect(repairs).toEqual(["run_1"]);
  });
});

// The append that RESOLVES with a non-persisting outcome (forked / skippedNoKeyspace) is the gap the
// thrown-error path above always covered: for a redis-only-born run the repair reads an empty
// Postgres, so the outcome must be fatal here too, not enqueued for a doomed repair or silently dropped.
describe("a non-persisting append outcome is fatal for a redis-only-born run", () => {
  it("throws and enqueues NO repair when a transition forks for a redis-only-born run", async () => {
    const { decorated, repairs } = harness({
      regime: "redis-only",
      appendResult: { outcome: "forked", actualCur: "snap_other" },
    });

    await expect(
      (decorated.completeAttemptSuccess as (...a: never[]) => Promise<unknown>)(...completeParams())
    ).rejects.toThrow(/unrecoverable at redis-only/);
    expect(repairs).toEqual([]);
  });

  it("throws when a transition is skippedNoKeyspace for a redis-only-born run", async () => {
    const { decorated, repairs } = harness({
      regime: "redis-only",
      appendResult: { outcome: "skippedNoKeyspace" },
    });

    await expect(
      (decorated.completeAttemptSuccess as (...a: never[]) => Promise<unknown>)(...completeParams())
    ).rejects.toThrow(/unrecoverable at redis-only/);
    expect(repairs).toEqual([]);
  });

  it("for a Postgres-backed run, a fork still enqueues a repair and a skip is a no-op", async () => {
    const forked = harness({
      regime: "postgres",
      appendResult: { outcome: "forked", actualCur: "snap_other" },
    });
    await expect(
      (forked.decorated.completeAttemptSuccess as (...a: never[]) => Promise<unknown>)(
        ...completeParams()
      )
    ).resolves.toBeDefined();
    expect(forked.repairs).toEqual(["run_1"]);

    const skipped = harness({
      regime: "postgres",
      appendResult: { outcome: "skippedNoKeyspace" },
    });
    await expect(
      (skipped.decorated.completeAttemptSuccess as (...a: never[]) => Promise<unknown>)(
        ...completeParams()
      )
    ).resolves.toBeDefined();
    expect(skipped.repairs).toEqual([]);
  });
});
