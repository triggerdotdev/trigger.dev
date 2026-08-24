import { expect, it, describe } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { snapshotRowsFromRedis, readRunSnapshotsForBackfill, type RunBackfillData } from "./snapshotBackfill.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";

function entry(over: Record<string, unknown> = {}) {
  return {
    id: "s1", engine: "V2", executionStatus: "EXECUTING", description: "d",
    runId: "r1", runStatus: "EXECUTING", createdAt: "2026-08-24T00:00:00.000Z",
    environmentId: "env", environmentType: "DEVELOPMENT", projectId: "p", organizationId: "o",
    ...over,
  };
}

describe("snapshotRowsFromRedis", () => {
  it("maps a valid entry with a cycle to a row + join ids from records (not order)", () => {
    const data: RunBackfillData = {
      runId: "r1",
      entries: [
        { id: "s1", seq: 1, raw: JSON.stringify(entry()), entry: entry(), cycle: { cycleSeq: 1, orderCount: 1 } },
      ],
      cycles: new Map([
        [1, {
          cycleSeq: 1,
          order: ["w_a"],
          records: [
            { id: "w_a", friendlyId: "f_a", type: "MANUAL", completedAt: "x", outputType: "application/json", outputIsError: false, output: null },
            { id: "w_b", friendlyId: "f_b", type: "MANUAL", completedAt: "x", outputType: "application/json", outputIsError: false, output: null },
          ],
        }],
      ]),
    };
    const { rows, report } = snapshotRowsFromRedis(data);
    expect(rows).toHaveLength(1);
    expect(rows[0].row.id).toBe("s1");
    expect(rows[0].row.isValid).toBe(true);
    expect(rows[0].row.completedWaitpointOrder).toEqual(["w_a"]);
    expect(rows[0].waitpointIds.sort()).toEqual(["w_a", "w_b"]);
    expect(report.unreconstructable).toEqual([]);
  });

  it("includes an invalid entry (isValid false)", () => {
    const e = entry({ id: "s2", error: "boom" });
    const data: RunBackfillData = {
      runId: "r1",
      entries: [{ id: "s2", seq: 2, raw: JSON.stringify(e), entry: e }],
      cycles: new Map(),
    };
    const { rows } = snapshotRowsFromRedis(data);
    expect(rows[0].row.isValid).toBe(false);
    expect(rows[0].row.error).toBe("boom");
    expect(rows[0].waitpointIds).toEqual([]);
  });

  it("reports a cycle without records as unreconstructable, not a guess", () => {
    const e = entry({ id: "s3" });
    const data: RunBackfillData = {
      runId: "r1",
      entries: [{ id: "s3", seq: 3, raw: JSON.stringify(e), entry: e, cycle: { cycleSeq: 2, orderCount: 1 } }],
      cycles: new Map([[2, { cycleSeq: 2, order: ["w_a"], records: null }]]),
    };
    const { rows, report } = snapshotRowsFromRedis(data);
    expect(rows[0].row.completedWaitpointOrder).toEqual(["w_a"]);
    expect(report.unreconstructable).toEqual([
      { runId: "r1", snapshotId: "s3", reason: "cycle-without-records" },
    ]);
  });
});

containerTest(
  "reads back every entry the store wrote, invalid ones included",
  async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const raw = createRedisClient(redisOptions);
    try {
      const base = {
        engine: "V2" as const, runId: "r1", runStatus: "EXECUTING", environmentId: "env",
        environmentType: "DEVELOPMENT", projectId: "p", organizationId: "o",
      };
      await store.append({
        entry: { ...base, id: "s1", executionStatus: "RUN_CREATED", description: "birth", createdAt: new Date().toISOString() },
        kind: "birth", isTerminal: false,
      });
      await store.append({
        entry: { ...base, id: "s2", executionStatus: "EXECUTING", description: "invalid", error: "boom", createdAt: new Date().toISOString(), previousSnapshotId: "s1" },
        kind: "transition", isTerminal: false,
      });

      const data = await readRunSnapshotsForBackfill(raw, "r1");
      expect(data).not.toBeNull();
      expect(data!.entries.map((e) => e.id).sort()).toEqual(["s1", "s2"]);
      const s2 = data!.entries.find((e) => e.id === "s2")!;
      expect(s2.seq).toBeGreaterThan(0); // seq came from the #s sidecar, not idx
      expect(s2.entry.error).toBe("boom");
    } finally {
      await store.quit();
      await raw.quit();
    }
  }
);
