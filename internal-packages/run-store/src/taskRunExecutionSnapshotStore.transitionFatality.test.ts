// A lost transition append is survivable below redis-only: Postgres already committed and holds the
// head, so the decorator records the failure, enqueues a Postgres-based repair, and returns. At
// redis-only Postgres holds no snapshot, so a lost transition is unrecoverable — the repair cannot
// help — and the append must THROW so the caller sees the loss, mirroring the birth path.
import { describe, expect, it } from "vitest";
import {
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreMode,
  type SnapshotStoreModeResolver,
} from "./taskRunExecutionSnapshotStore.js";
import type { RedisSnapshotStore } from "./redisSnapshotStore.js";
import type { RunStore } from "./types.js";

const ORG = "org_a";

function harness(opts: {
  global: SnapshotStoreMode;
  forOrg: SnapshotStoreMode;
  /** When set, append RESOLVES with this outcome instead of rejecting (the returned-outcome path). */
  appendResult?: { outcome: string; actualCur?: string; seq?: number };
}) {
  const delegateCalls: string[] = [];
  const repairs: string[] = [];

  const redis = new Proxy({} as RedisSnapshotStore, {
    get: (_t, prop) => {
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

  const modeResolver: SnapshotStoreModeResolver = {
    resolve: (organizationId?: string) =>
      organizationId === undefined ? opts.global : opts.forOrg,
  };

  const decorated = new TaskRunExecutionSnapshotStore(delegate, {
    store: redis,
    mode: opts.global,
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

describe("transition append fatality is decided by the organisation dial", () => {
  it("throws and enqueues NO repair when the org resolves to redis-only", async () => {
    const { decorated, repairs } = harness({ global: "dual-write", forOrg: "redis-only" });

    await expect(
      (decorated.completeAttemptSuccess as (...a: never[]) => Promise<unknown>)(...completeParams())
    ).rejects.toThrow(/redis append boom/);
    expect(repairs).toEqual([]);
  });

  it("does NOT throw and enqueues a repair below redis-only", async () => {
    const { decorated, repairs } = harness({ global: "dual-write", forOrg: "dual-write" });

    await expect(
      (decorated.completeAttemptSuccess as (...a: never[]) => Promise<unknown>)(...completeParams())
    ).resolves.toBeDefined();
    expect(repairs).toEqual(["run_1"]);
  });
});

// The append that RESOLVES with a non-persisting outcome (forked / skippedNoKeyspace) is the gap the
// thrown-error path above always covered: at redis-only the repair reads an empty Postgres, so the
// outcome must be fatal here too, not enqueued for a doomed repair or silently dropped.
describe("a non-persisting append outcome is fatal at redis-only", () => {
  it("throws and enqueues NO repair when a transition forks at redis-only", async () => {
    const { decorated, repairs } = harness({
      global: "dual-write",
      forOrg: "redis-only",
      appendResult: { outcome: "forked", actualCur: "snap_other" },
    });

    await expect(
      (decorated.completeAttemptSuccess as (...a: never[]) => Promise<unknown>)(...completeParams())
    ).rejects.toThrow(/unrecoverable at redis-only/);
    expect(repairs).toEqual([]);
  });

  it("throws when a transition is skippedNoKeyspace at redis-only", async () => {
    const { decorated, repairs } = harness({
      global: "dual-write",
      forOrg: "redis-only",
      appendResult: { outcome: "skippedNoKeyspace" },
    });

    await expect(
      (decorated.completeAttemptSuccess as (...a: never[]) => Promise<unknown>)(...completeParams())
    ).rejects.toThrow(/unrecoverable at redis-only/);
    expect(repairs).toEqual([]);
  });

  it("below redis-only, a fork still enqueues a repair and a skip is a no-op", async () => {
    const forked = harness({
      global: "dual-write",
      forOrg: "dual-write",
      appendResult: { outcome: "forked", actualCur: "snap_other" },
    });
    await expect(
      (forked.decorated.completeAttemptSuccess as (...a: never[]) => Promise<unknown>)(
        ...completeParams()
      )
    ).resolves.toBeDefined();
    expect(forked.repairs).toEqual(["run_1"]);

    const skipped = harness({
      global: "dual-write",
      forOrg: "dual-write",
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
