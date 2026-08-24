import { expect, it, describe } from "vitest";
import {
  diffLatest,
  diffSince,
  SnapshotComparator,
  type DivergenceClass,
  type NormalizedSnapshot,
} from "./snapshotComparator.js";

function norm(over: Partial<NormalizedSnapshot> = {}): NormalizedSnapshot {
  const base: NormalizedSnapshot = {
    id: "s1", engine: "V2", executionStatus: "RUN_CREATED", description: "d",
    isValid: true, error: null, previousSnapshotId: null, runId: "r1",
    runStatus: "PENDING", batchId: null, attemptNumber: null,
    environmentId: "env", environmentType: "DEVELOPMENT", projectId: "p",
    organizationId: "o", checkpointId: null, workerId: null, runnerId: null,
    createdAt: 1000, updatedAt: 1000, metadata: null,
    completedWaitpointOrder: [], waitpointIdSet: [],
  };
  return { ...base, ...over };
}

describe("diffLatest", () => {
  it("no divergence when the two sides match", () => {
    expect(diffLatest(norm(), norm())).toEqual([]);
  });

  it("reports a scalar difference by field", () => {
    expect(diffLatest(norm(), norm({ executionStatus: "EXECUTING" }))).toEqual([
      { field: "executionStatus", class: "scalar", pg: "RUN_CREATED", redis: "EXECUTING" },
    ]);
  });

  it("compares createdAt and updatedAt by strict equality", () => {
    expect(diffLatest(norm(), norm({ createdAt: 1001 }))).toEqual([
      { field: "createdAt", class: "scalar", pg: 1000, redis: 1001 },
    ]);
  });

  it("classifies a validity mismatch", () => {
    const d = diffLatest(norm({ isValid: true }), norm({ isValid: false, error: "boom" }));
    expect(d.map((x) => x.field).sort()).toEqual(["error", "isValid"]);
    expect(d.find((x) => x.field === "isValid")!.class).toBe("validity");
  });

  it("classifies completedWaitpointOrder differences as order, repeats significant", () => {
    expect(
      diffLatest(
        norm({ completedWaitpointOrder: ["a", "a", "b"] }),
        norm({ completedWaitpointOrder: ["a", "b"] })
      )
    ).toEqual([
      { field: "completedWaitpointOrder", class: "order", pg: ["a", "a", "b"], redis: ["a", "b"] },
    ]);
  });

  it("classifies waitpoint id set differences, order-insensitive", () => {
    expect(diffLatest(norm({ waitpointIdSet: ["a", "b"] }), norm({ waitpointIdSet: ["a", "b"] }))).toEqual([]);
    const d2 = diffLatest(norm({ waitpointIdSet: ["a", "b"] }), norm({ waitpointIdSet: ["a"] }));
    expect(d2[0]).toMatchObject({ field: "waitpointIdSet", class: "waitpointIdSet" });
  });

  it("does NOT emit a divergence for a rotated idempotency key — invisible at id-set granularity", () => {
    expect(diffLatest(norm({ waitpointIdSet: ["w1"] }), norm({ waitpointIdSet: ["w1"] }))).toEqual([]);
  });

  it("missingInRedis when the row exists only in Postgres", () => {
    expect(diffLatest(norm(), null)).toEqual([expect.objectContaining({ class: "missingInRedis" })]);
  });

  it("missingInPg when the row exists only in Redis", () => {
    expect(diffLatest(null, norm())).toEqual([expect.objectContaining({ class: "missingInPg" })]);
  });

  it("raises unknownField for a key on neither the compared nor excluded list", () => {
    const d = diffLatest(norm(), { ...norm(), somethingNew: 1 } as NormalizedSnapshot);
    expect(d).toEqual([expect.objectContaining({ field: "somethingNew", class: "unknownField" })]);
  });
});

describe("diffSince", () => {
  const cursor = { id: "s1", createdAtMs: 1000 };

  it("a Postgres-only entry at the cursor ms is a lost append (missingInRedis), never a tie", () => {
    const pg = [norm({ id: "s2", createdAt: 1000, previousSnapshotId: "s1" })];
    expect(diffSince({ pg, redis: [], cursor })).toEqual([
      expect.objectContaining({ field: "s2", class: "missingInRedis" }),
    ]);
  });

  it("a Redis-only chain-boundary surplus at the cursor ms is expected:redisSurplusAtCursorTie", () => {
    const redis = [norm({ id: "s2", createdAt: 1000, previousSnapshotId: "s1" })];
    expect(diffSince({ pg: [], redis, cursor })).toEqual([
      expect.objectContaining({ field: "s2", class: "expected:redisSurplusAtCursorTie" }),
    ]);
  });

  it("a Redis-only surplus that is NOT a chain boundary is a real missingInPg", () => {
    const redis = [norm({ id: "s3", createdAt: 1000, previousSnapshotId: "s2" })];
    expect(diffSince({ pg: [], redis, cursor })).toEqual([
      expect.objectContaining({ field: "s3", class: "missingInPg" }),
    ]);
  });

  it("a Redis-only surplus above the cursor ms is a real missingInPg", () => {
    const redis = [norm({ id: "s2", createdAt: 1500, previousSnapshotId: "s1" })];
    expect(diffSince({ pg: [], redis, cursor })).toEqual([
      expect.objectContaining({ field: "s2", class: "missingInPg" }),
    ]);
  });
});

describe("SnapshotComparator", () => {
  it("shouldSample honours the injected rng and percent", () => {
    expect(new SnapshotComparator({ samplePercent: 10, rng: () => 0.05 }).shouldSample()).toBe(true);
    expect(new SnapshotComparator({ samplePercent: 10, rng: () => 0.5 }).shouldSample()).toBe(false);
  });

  it("record emits one metric per divergence, tagged by class and op, and returns void", () => {
    const seen: Array<{ op: string; cls: DivergenceClass }> = [];
    const cmp = new SnapshotComparator({
      samplePercent: 100,
      metrics: {
        recordDivergence: (op, cls) => seen.push({ op, cls }),
        recordSample: () => {},
      },
    });
    const ret = cmp.record("getLatest", [
      { field: "executionStatus", class: "scalar" },
      { field: "idempotencyKey", class: "expected:rotatedIdempotencyKey" },
    ]);
    expect(ret).toBeUndefined();
    expect(seen).toEqual([
      { op: "getLatest", cls: "scalar" },
      { op: "getLatest", cls: "expected:rotatedIdempotencyKey" },
    ]);
  });
});
