// Versioned-namespace fail-closed read (M2). A birth stamps the state version onto the run-state
// hash; a keyspace whose state version the running code does not understand (or is missing) resolves
// to `unknown` so the resolver can FAIL CLOSED rather than treat a future v2 payload as a clean miss.
import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { SNAPSHOT_STATE_VERSION, residencyKey, snapshotKeys } from "./snapshotKeys.js";
import type { SnapshotEntryInput } from "./redisSnapshotStore.js";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;

function entry(runId: string, id: string): SnapshotEntryInput {
  return {
    id,
    engine: "V2",
    executionStatus: "EXECUTING",
    description: "d",
    runId,
    runStatus: "EXECUTING",
    createdAt: new Date().toISOString(),
    environmentId: "env_1",
    environmentType: "DEVELOPMENT",
    projectId: "proj_1",
    organizationId: "org_1",
  };
}

describe("state version", () => {
  redisTest(
    "a birth stamps the current state version on the run-state hash",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const runId = "run_sv_1";
        await store.append({ entry: entry(runId, "s0"), kind: "birth", isTerminal: false });
        expect(await raw.hget(snapshotKeys(runId).seq, "sv")).toBe(SNAPSHOT_STATE_VERSION);
        expect(await store.readStateVersion(runId)).toEqual({ kind: "known" });
      } finally {
        await Promise.all([store.quit(), raw.quit().catch(() => {})]);
      }
    }
  );

  redisTest(
    "classifies a run with no keyspace as absent (a genuine miss)",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      try {
        expect(await store.readStateVersion("run_never")).toEqual({ kind: "absent" });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("fails closed on an unknown state version", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
    const raw = createRedisClient(redisOptions, { onError: () => {} });
    try {
      const runId = "run_sv_future";
      await store.append({ entry: entry(runId, "s0"), kind: "birth", isTerminal: false });
      // Simulate a payload written by a future protocol version under the same key.
      await raw.hset(snapshotKeys(runId).seq, "sv", "2");
      const result = await store.readStateVersion(runId);
      expect(result).toEqual({ kind: "unknown", version: "2" });
    } finally {
      await Promise.all([store.quit(), raw.quit().catch(() => {})]);
    }
  });

  redisTest(
    "fails closed when the keyspace exists but carries no state version",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const runId = "run_sv_missing";
        await store.append({ entry: entry(runId, "s0"), kind: "birth", isTerminal: false });
        await raw.hdel(snapshotKeys(runId).seq, "sv");
        expect(await store.readStateVersion(runId)).toEqual({ kind: "unknown", version: null });
      } finally {
        await Promise.all([store.quit(), raw.quit().catch(() => {})]);
      }
    }
  );
});

describe("birth residency marker", () => {
  redisTest("stamps residency on the no-TTL res key, readable back", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
    const raw = createRedisClient(redisOptions, { onError: () => {} });
    try {
      const runId = "run_res_1";
      await store.append({
        entry: entry(runId, "s0"),
        kind: "birth",
        isTerminal: false,
        birthMode: "redis-only",
      });
      expect(await store.readBirthResidency(runId)).toBe("redis-only");
      expect(await raw.get(residencyKey(runId))).toBe("redis-only");
      // The residency marker never expires, even after a terminal transition TTLs the run state.
      expect(await raw.pttl(residencyKey(runId))).toBe(-1);
    } finally {
      await Promise.all([store.quit(), raw.quit().catch(() => {})]);
    }
  });

  redisTest("survives the terminal TTL applied to the run-state keys", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
    const raw = createRedisClient(redisOptions, { onError: () => {} });
    try {
      const runId = "run_res_2";
      await store.append({
        entry: entry(runId, "s0"),
        kind: "birth",
        isTerminal: false,
        birthMode: "redis-only",
      });
      await store.append({
        entry: { ...entry(runId, "s1"), executionStatus: "FINISHED" },
        kind: "transition",
        isTerminal: true,
      });
      // Run-state keys carry the completion TTL; the residency marker does not.
      expect(await raw.pttl(snapshotKeys(runId).seq)).toBeGreaterThan(0);
      expect(await raw.pttl(residencyKey(runId))).toBe(-1);
      expect(await store.readBirthResidency(runId)).toBe("redis-only");
    } finally {
      await Promise.all([store.quit(), raw.quit().catch(() => {})]);
    }
  });
});
