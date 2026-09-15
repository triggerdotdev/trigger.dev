// Item 8d: a terminal MIRRORED run's residency marker expires WITH its state (its Postgres copy is
// authoritative after 14 days, so no permanent per-run marker accumulates), while a REDIS-PRIMARY marker
// is kept forever so an expired redis-primary run resolves to expired/fail-closed rather than empty
// Postgres. Proven against REAL Redis (testcontainers, no mocks).
import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { RedisSnapshotStore, type SnapshotEntryInput } from "./redisSnapshotStore.js";
import { residencyKey, snapshotKeys } from "./snapshotKeys.js";

function entry(runId: string, id: string): SnapshotEntryInput {
  return {
    id,
    engine: "V2",
    executionStatus: "EXECUTING",
    description: "d",
    runId,
    runStatus: "EXECUTING",
    createdAt: "2026-09-04T00:00:00.000Z",
    environmentId: "env_1",
    environmentType: "PRODUCTION",
    projectId: "proj_1",
    organizationId: "org_1",
  };
}

describe("residency marker retention (item 8d)", () => {
  redisTest(
    "a terminal mirrored run's marker gets the terminal TTL; a redis-primary marker stays permanent",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions);
      try {
        const m = "run_mirrored_marker";
        await store.append({
          entry: entry(m, "m0"),
          kind: "birth",
          isTerminal: false,
          birthMode: "mirrored",
        });
        await store.append({
          entry: entry(m, "m1"),
          kind: "transition",
          isTerminal: true,
          expectedCur: "m0",
        });
        // Mirrored: the residency marker now expires with the state (a positive TTL is set).
        expect(await raw.pttl(residencyKey(m))).toBeGreaterThan(0);
        expect(await raw.pttl(snapshotKeys(m).cur)).toBeGreaterThan(0);

        const r = "run_primary_marker";
        await store.append({
          entry: entry(r, "r0"),
          kind: "birth",
          isTerminal: false,
          birthMode: "redis-primary",
        });
        await store.append({
          entry: entry(r, "r1"),
          kind: "transition",
          isTerminal: true,
          expectedCur: "r0",
        });
        // Redis-primary: the marker is permanent (-1 = no TTL) while its state keys DO expire.
        expect(await raw.pttl(residencyKey(r))).toBe(-1);
        expect(await raw.pttl(snapshotKeys(r).cur)).toBeGreaterThan(0);
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );
});
