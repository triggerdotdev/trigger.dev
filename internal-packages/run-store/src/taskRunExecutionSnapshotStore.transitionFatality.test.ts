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

function harness(opts: { global: SnapshotStoreMode; forOrg: SnapshotStoreMode }) {
  const delegateCalls: string[] = [];
  const repairs: string[] = [];

  const redis = new Proxy({} as RedisSnapshotStore, {
    get: (_t, prop) => {
      if (prop === "append") {
        return () => Promise.reject(new Error("redis append boom"));
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
