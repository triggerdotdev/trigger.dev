// A lost Redis append leaves the mirrored head stale while Postgres moves on. The repair job's whole
// job is to close that gap, and it can only do so by re-appending the POSTGRES head: reading through
// the decorator would serve Redis's own stale head back to it and it would conclude there is nothing
// to repair.
//
// Container-free on purpose: every behaviour asserted here is a decision the decorator makes about
// which store it reads and what it hands the append script. The append script's own idempotency and
// its no-keyspace refusal are proved against a real Redis in redisSnapshotStore.test.ts, and this
// file asserts that the repair routes into those two outcomes rather than around them.
import { describe, expect, it } from "vitest";
import type { AppendResult, RedisSnapshotStore, SnapshotRead } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreMode,
} from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";

/** The seven statuses the decorator's transition path can lose an append for. */
const TRANSITION_STATUSES = [
  "EXECUTING",
  "EXECUTING_WITH_WAITPOINTS",
  "PENDING_CANCEL",
  "PENDING_EXECUTING",
  "QUEUED_EXECUTING",
  "RUN_CREATED",
  "DELAYED",
] as const;

type PgRow = Awaited<ReturnType<RunStore["findLatestExecutionSnapshot"]>>;

function pgHead(overrides: {
  id: string;
  runId: string;
  executionStatus: string;
  createdAt: Date;
  previousSnapshotId?: string | null;
  completedWaitpointOrder?: string[];
  completedWaitpoints?: { id: string }[];
}): PgRow {
  return {
    id: overrides.id,
    engine: "V2",
    executionStatus: overrides.executionStatus,
    description: "repair fixture",
    isValid: true,
    error: null,
    previousSnapshotId: overrides.previousSnapshotId ?? null,
    runId: overrides.runId,
    runStatus: "EXECUTING",
    batchId: null,
    attemptNumber: 1,
    environmentId: "env_1",
    environmentType: "PRODUCTION",
    projectId: "proj_1",
    organizationId: "org_1",
    completedWaitpoints: overrides.completedWaitpoints ?? [],
    completedWaitpointOrder: overrides.completedWaitpointOrder ?? [],
    checkpointId: null,
    checkpoint: null,
    workerId: null,
    runnerId: null,
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
    lastHeartbeatAt: null,
    metadata: null,
  } as unknown as PgRow;
}

type Appended = Parameters<RedisSnapshotStore["append"]>[0];

/**
 * Stands in for the append script. It answers with whichever outcome the scenario is about and
 * records what it was handed, which is the only way to assert the repair never asks for a delete or
 * an expiry.
 */
class RecordingRedis {
  readonly appends: Appended[] = [];
  readonly calls: string[] = [];

  constructor(
    private head: SnapshotRead | null,
    private outcome: AppendResult = {
      outcome: "written",
      seq: 9,
      ttl: "none",
      cycleMismatch: false,
    }
  ) {}

  async getLatest(_runId: string): Promise<SnapshotRead | null> {
    this.calls.push("getLatest");
    return this.head;
  }

  async append(args: Appended): Promise<AppendResult> {
    this.calls.push("append");
    this.appends.push(args);
    return this.outcome;
  }

  async dropRun(): Promise<void> {
    this.calls.push("dropRun");
  }
}

function redisHead(id: string, createdAt: Date): SnapshotRead {
  return {
    id,
    seq: 4,
    isValid: true,
    entry: { id, createdAt: createdAt.toISOString() },
    raw: "{}",
  };
}

/**
 * Only the two collaborators the repair reads through are supplied. `findLatestExecutionSnapshot` on
 * the delegate IS the Postgres truth; a repair that reaches for the decorated view instead sees the
 * stale mirror.
 */
function harness(opts: {
  pg: PgRow;
  redis: RecordingRedis;
  mode?: SnapshotStoreMode;
  onDelegateRead?: () => void;
}) {
  const delegate = {
    findLatestExecutionSnapshot: async () => {
      opts.onDelegateRead?.();
      return opts.pg;
    },
  } as unknown as RunStore;

  const decorated = new TaskRunExecutionSnapshotStore(delegate, {
    store: opts.redis as unknown as RedisSnapshotStore,
    mode: opts.mode ?? "redis-read",
  });

  return decorated;
}

describe("repairRedisHead", () => {
  it.each(TRANSITION_STATUSES)(
    "re-appends the Postgres head for a lost %s append",
    async (executionStatus) => {
      const runId = "run_1";
      const lost = "snap_lost";
      const created = new Date("2026-01-01T00:00:10.000Z");
      const redis = new RecordingRedis(
        redisHead("snap_prev", new Date("2026-01-01T00:00:00.000Z"))
      );

      const store = harness({
        pg: pgHead({ id: lost, runId, executionStatus, createdAt: created }),
        redis,
      });

      await expect(store.repairRedisHead(runId, lost)).resolves.toBe("reappended");

      expect(redis.appends).toHaveLength(1);
      expect(redis.appends[0]!.kind).toBe("transition");
      expect(redis.appends[0]!.entry.id).toBe(lost);
      expect(redis.appends[0]!.entry.executionStatus).toBe(executionStatus);
      expect(redis.appends[0]!.entry.createdAt).toBe(created.toISOString());
    }
  );

  it("never asks the store to delete or expire anything", async () => {
    const redis = new RecordingRedis(redisHead("snap_prev", new Date("2026-01-01T00:00:00.000Z")));
    const store = harness({
      pg: pgHead({
        id: "snap_lost",
        runId: "run_1",
        executionStatus: "EXECUTING",
        createdAt: new Date("2026-01-01T00:00:10.000Z"),
      }),
      redis,
    });

    await store.repairRedisHead("run_1", "snap_lost");

    expect(redis.calls).not.toContain("dropRun");
  });

  it("appends without a compare-and-set, so a gap wider than one entry still restores the head", async () => {
    // Asserting cur would make the repair fail exactly when Redis is furthest behind, which is when
    // the stale head is doing the most damage.
    const redis = new RecordingRedis(
      redisHead("snap_two_back", new Date("2026-01-01T00:00:00.000Z"))
    );
    const store = harness({
      pg: pgHead({
        id: "snap_lost",
        runId: "run_1",
        executionStatus: "EXECUTING",
        createdAt: new Date("2026-01-01T00:00:10.000Z"),
        previousSnapshotId: "snap_one_back",
      }),
      redis,
    });

    await expect(store.repairRedisHead("run_1", "snap_lost")).resolves.toBe("reappended");
    expect(redis.appends[0]!.expectedCur).toBeUndefined();
  });

  it("reads the Postgres head rather than the mirrored view", async () => {
    let delegateReads = 0;
    // The mirror's head is a DIFFERENT, older snapshot. A repair reading the mirror would compare
    // that id against the one it was asked to repair, find no match, and abort.
    const redis = new RecordingRedis(redisHead("snap_stale", new Date("2026-01-01T00:00:00.000Z")));
    const store = harness({
      pg: pgHead({
        id: "snap_lost",
        runId: "run_1",
        executionStatus: "EXECUTING",
        createdAt: new Date("2026-01-01T00:00:10.000Z"),
      }),
      redis,
      onDelegateRead: () => {
        delegateReads += 1;
      },
    });

    await expect(store.repairRedisHead("run_1", "snap_lost")).resolves.toBe("reappended");
    expect(delegateReads).toBe(1);
  });

  it("carries the head's completed waitpoints so the repaired entry keeps its wait cycle", async () => {
    const redis = new RecordingRedis(redisHead("snap_prev", new Date("2026-01-01T00:00:00.000Z")));
    const store = harness({
      pg: pgHead({
        id: "snap_lost",
        runId: "run_1",
        executionStatus: "EXECUTING_WITH_WAITPOINTS",
        createdAt: new Date("2026-01-01T00:00:10.000Z"),
        completedWaitpoints: [{ id: "wp_a" }, { id: "wp_b" }],
        completedWaitpointOrder: ["wp_a"],
      }),
      redis,
    });

    await store.repairRedisHead("run_1", "snap_lost");

    expect(redis.appends[0]!.cycle?.kind).toBe("new");
    expect(redis.appends[0]!.cycle?.completedWaitpoints).toEqual([
      { id: "wp_a", index: 0 },
      { id: "wp_b" },
    ]);
  });

  it("reports a duplicate instead of treating an already-landed entry as a failure", async () => {
    const redis = new RecordingRedis(redisHead("snap_prev", new Date("2026-01-01T00:00:00.000Z")), {
      outcome: "duplicate",
      seq: 5,
    });
    const store = harness({
      pg: pgHead({
        id: "snap_lost",
        runId: "run_1",
        executionStatus: "EXECUTING",
        createdAt: new Date("2026-01-01T00:00:10.000Z"),
      }),
      redis,
    });

    await expect(store.repairRedisHead("run_1", "snap_lost")).resolves.toBe("duplicate");
  });

  it("does not resurrect a run that was never resident in Redis", async () => {
    // No keyspace is the record of non-residency. The append script refuses the transition and the
    // repair must report that, not retry it into existence some other way.
    const redis = new RecordingRedis(null, { outcome: "skippedNoKeyspace" });
    const store = harness({
      pg: pgHead({
        id: "snap_lost",
        runId: "run_1",
        executionStatus: "EXECUTING",
        createdAt: new Date("2026-01-01T00:00:10.000Z"),
      }),
      redis,
    });

    await expect(store.repairRedisHead("run_1", "snap_lost")).resolves.toBe("notResident");
    expect(redis.appends[0]!.kind).toBe("transition");
  });

  it("does nothing when the mirror already holds the Postgres head", async () => {
    const redis = new RecordingRedis(redisHead("snap_lost", new Date("2026-01-01T00:00:10.000Z")));
    const store = harness({
      pg: pgHead({
        id: "snap_lost",
        runId: "run_1",
        executionStatus: "EXECUTING",
        createdAt: new Date("2026-01-01T00:00:10.000Z"),
      }),
      redis,
    });

    await expect(store.repairRedisHead("run_1", "snap_lost")).resolves.toBe("alreadyCurrent");
    expect(redis.appends).toHaveLength(0);
  });

  it("refuses to append behind a mirror head that is newer than the Postgres head", async () => {
    // Appending an older entry at the tail would leave the chain claiming a state the run has left.
    const redis = new RecordingRedis(redisHead("snap_newer", new Date("2026-01-01T00:00:20.000Z")));
    const store = harness({
      pg: pgHead({
        id: "snap_lost",
        runId: "run_1",
        executionStatus: "EXECUTING",
        createdAt: new Date("2026-01-01T00:00:10.000Z"),
      }),
      redis,
    });

    await expect(store.repairRedisHead("run_1", "snap_lost")).resolves.toBe("redisAhead");
    expect(redis.appends).toHaveLength(0);
  });

  it("stops when the run has already transitioned past the lost snapshot", async () => {
    // The gap is now mid-history, and the newest entry is not the one that was lost. Appending the
    // current head here would be appending an entry that already landed normally.
    const redis = new RecordingRedis(redisHead("snap_prev", new Date("2026-01-01T00:00:00.000Z")));
    const store = harness({
      pg: pgHead({
        id: "snap_later",
        runId: "run_1",
        executionStatus: "EXECUTING",
        createdAt: new Date("2026-01-01T00:00:10.000Z"),
      }),
      redis,
    });

    await expect(store.repairRedisHead("run_1", "snap_lost")).resolves.toBe("notLatest");
    expect(redis.appends).toHaveLength(0);
  });

  it("touches Redis for no run when the deployment-wide dial is off", async () => {
    const redis = new RecordingRedis(redisHead("snap_prev", new Date("2026-01-01T00:00:00.000Z")));
    const store = harness({
      pg: pgHead({
        id: "snap_lost",
        runId: "run_1",
        executionStatus: "EXECUTING",
        createdAt: new Date("2026-01-01T00:00:10.000Z"),
      }),
      redis,
      mode: "off",
    });

    await expect(store.repairRedisHead("run_1", "snap_lost")).resolves.toBe("off");
    expect(redis.calls).toHaveLength(0);
  });
});
