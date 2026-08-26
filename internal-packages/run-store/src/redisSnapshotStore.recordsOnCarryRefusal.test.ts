// A refused carry-forward mints a replacement cycle inside the same call. That replacement must
// carry the records, not just the ids: the resolver's coverage check requires every distinct id to
// resolve through exactly one half, so a cycle holding ids with no records makes a legitimate
// resume fail loud.
import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import {
  RedisSnapshotStore,
  type CompletedWaitpointRecord,
  type SnapshotEntryInput,
} from "./redisSnapshotStore.js";

function entry(over: Partial<SnapshotEntryInput> = {}): SnapshotEntryInput {
  return {
    id: "snap_1",
    engine: "V2",
    executionStatus: "RUN_CREATED",
    description: "created",
    runId: "run_1",
    runStatus: "PENDING",
    createdAt: "2026-08-21T00:00:00.000Z",
    environmentId: "env_1",
    environmentType: "PRODUCTION",
    projectId: "proj_1",
    organizationId: "org_1",
    ...over,
  };
}

function record(id: string, output: string): CompletedWaitpointRecord {
  return {
    id,
    friendlyId: `waitpoint_${id}`,
    type: "MANUAL",
    completedAt: "2026-08-25T00:00:00.000Z",
    outputType: "application/json",
    outputIsError: false,
    output: { inline: output },
  };
}

async function recordsAt(
  raw: ReturnType<typeof createRedisClient>,
  cycleSeq: number
): Promise<CompletedWaitpointRecord[] | undefined> {
  const stored = await raw.hget(`snap:{run_1}:wp:${cycleSeq}`, "records");
  return stored ? (JSON.parse(stored) as CompletedWaitpointRecord[]) : undefined;
}

describe("a refused carry-forward", () => {
  redisTest("mints a replacement that carries the records", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const raw = createRedisClient(redisOptions, { onError: () => {} });
    try {
      await store.append({
        entry: entry({ id: "snap_1" }),
        kind: "birth",
        isTerminal: false,
        cycle: {
          kind: "new",
          completedWaitpoints: [{ id: "w_a", index: 0 }],
          records: [record("w_a", "first")],
        },
      });

      // Lose everything except the cycle key, as under maxmemory eviction. The carried pointer is
      // now untrustworthy, so the store refuses it.
      await raw.del("snap:{run_1}:e", "snap:{run_1}:idx", "snap:{run_1}:cur", "snap:{run_1}:seq");

      const carried = await store.append({
        entry: entry({ id: "snap_2" }),
        kind: "birth",
        isTerminal: false,
        cycle: {
          kind: "carryForward",
          cycleSeq: 1,
          completedWaitpoints: [{ id: "w_b", index: 0 }],
          records: [record("w_b", "second")],
        },
      });

      expect(carried).toMatchObject({ outcome: "written", cycleMismatch: true });

      // The replacement holds the CARRIED records, not the dead incarnation's.
      const read = await store.getLatest("run_1");
      const mintedSeq = read?.cycle?.cycleSeq;
      expect(mintedSeq).toBeDefined();

      const records = await recordsAt(raw, mintedSeq!);
      expect(records).toHaveLength(1);
      expect(records?.[0]?.id).toBe("w_b");
      expect(records?.[0]?.output).toEqual({ inline: "second" });
    } finally {
      await Promise.all([store.quit(), raw.quit().catch(() => {})]);
    }
  });

  // The reachable production shape. Every copy-forward append (dequeue, checkpoint, attempt)
  // re-passes the same refs and carries no records of its own, so this is the case a refusal
  // actually meets. Before the decorator read the surviving cycle's records, this minted a
  // replacement holding ids with no records, permanently.
  redisTest("keeps the records when the caller carried refs but none", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const raw = createRedisClient(redisOptions, { onError: () => {} });
    try {
      await store.append({
        entry: entry({ id: "snap_1" }),
        kind: "birth",
        isTerminal: false,
        cycle: {
          kind: "new",
          completedWaitpoints: [{ id: "w_a", index: 0 }],
          records: [record("w_a", "first")],
        },
      });

      // What the decorator now does for a records-less carry: read the surviving cycle's
      // records and carry those into the refusal branch.
      const carried = await store.getCycleRecords("run_1", 1);
      expect(carried).toHaveLength(1);

      await raw.del("snap:{run_1}:e", "snap:{run_1}:idx", "snap:{run_1}:cur", "snap:{run_1}:seq");

      await store.append({
        entry: entry({ id: "snap_2" }),
        kind: "birth",
        isTerminal: false,
        cycle: {
          kind: "carryForward",
          cycleSeq: 1,
          completedWaitpoints: [{ id: "w_a", index: 0 }],
          records: carried,
        },
      });

      const read = await store.getLatest("run_1");
      const records = await recordsAt(raw, read!.cycle!.cycleSeq);

      expect(records).toHaveLength(1);
      expect(records?.[0]?.id).toBe("w_a");
    } finally {
      await Promise.all([store.quit(), raw.quit().catch(() => {})]);
    }
  });

  // Without refs there is nothing to mint from, so the entry is written with no pointer. That is
  // the older behaviour and it stays: no pointer is safe, a pointer with no records is not.
  redisTest("writes no pointer when the caller carried no refs", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const raw = createRedisClient(redisOptions, { onError: () => {} });
    try {
      await store.append({
        entry: entry({ id: "snap_1" }),
        kind: "birth",
        isTerminal: false,
        cycle: {
          kind: "new",
          completedWaitpoints: [{ id: "w_a", index: 0 }],
          records: [record("w_a", "first")],
        },
      });

      await raw.del("snap:{run_1}:e", "snap:{run_1}:idx", "snap:{run_1}:cur", "snap:{run_1}:seq");

      const carried = await store.append({
        entry: entry({ id: "snap_2" }),
        kind: "birth",
        isTerminal: false,
        cycle: { kind: "carryForward", cycleSeq: 1 },
      });

      expect(carried).toMatchObject({ outcome: "written", cycleMismatch: true });
      const read = await store.getLatest("run_1");
      expect(read?.cycle).toBeUndefined();
    } finally {
      await Promise.all([store.quit(), raw.quit().catch(() => {})]);
    }
  });
});
