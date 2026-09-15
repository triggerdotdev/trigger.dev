// Deterministic co-location proof (no infra): a run's state, residency, prepared-unit, and its partition
// pending stream all carry the SAME `{pNNN}` hash tag, so Redis Cluster routes them to one slot — which is
// what lets prepare + finalize + pending-index touch a single slot atomically (no CROSSSLOT). Same hash tag
// => same slot is a Redis guarantee, so asserting tag equality proves co-location without spinning a cluster.
import { describe, expect, it } from "vitest";
import {
  PENDING_PARTITION_COUNT,
  partitionTag,
  pendingStreamKeyForRun,
  preparedUnitKey,
  residencyKey,
  runToPartition,
  snapshotKeys,
} from "./snapshotKeys.js";

const hashTag = (key: string): string | undefined => key.match(/\{([^}]*)\}/)?.[1];

function allKeysForRun(runId: string): string[] {
  const core = snapshotKeys(runId);
  return [
    core.e,
    core.idx,
    core.cur,
    core.seq,
    residencyKey(runId),
    preparedUnitKey(runId),
    pendingStreamKeyForRun(runId),
  ];
}

describe("snapshot key co-location", () => {
  const runIds = ["run_1", "run_2", "run_abc123", "c".repeat(25), "k".repeat(24) + "01"];

  it("every key for a run carries the run's single {pNNN} partition hash tag", () => {
    for (const runId of runIds) {
      const expected = partitionTag(runToPartition(runId));
      const tags = allKeysForRun(runId).map(hashTag);
      expect(new Set(tags)).toEqual(new Set([expected]));
    }
  });

  it("runToPartition is deterministic and bounded to [0, 256)", () => {
    for (const runId of runIds) {
      const p = runToPartition(runId);
      expect(p).toBe(runToPartition(runId)); // stable
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(PENDING_PARTITION_COUNT);
    }
  });

  it("partitionTag is a zero-padded three-digit pNNN", () => {
    expect(partitionTag(7)).toBe("p007");
    expect(partitionTag(45)).toBe("p045");
    expect(partitionTag(255)).toBe("p255");
  });

  it("runs that fall in different partitions get different tags (so they may occupy different slots)", () => {
    // run_1 and run_2 are known to hash to different partitions; assert the tags differ when the
    // partitions differ, which is the only case where cross-run co-location is not required.
    const a = "run_1";
    const b = "run_2";
    if (runToPartition(a) !== runToPartition(b)) {
      expect(hashTag(snapshotKeys(a).e)).not.toBe(hashTag(snapshotKeys(b).e));
    }
  });
});
