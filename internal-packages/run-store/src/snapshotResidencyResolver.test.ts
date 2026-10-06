// Durable residency protocol over real Postgres and Redis.
import { describe, expect } from "vitest";
import { containerTest, redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import {
  RedisSnapshotStore,
  type PreparedEntry,
  type PreparedPgUnit,
  type SnapshotEntryInput,
} from "./redisSnapshotStore.js";
import { snapshotKeys } from "./snapshotKeys.js";
import { SnapshotResidencyResolver } from "./snapshotResidencyResolver.js";

function entry(
  over: Partial<SnapshotEntryInput> & { id: string; runId: string }
): SnapshotEntryInput {
  return {
    engine: "V2",
    executionStatus: "EXECUTING",
    description: "d",
    runStatus: "EXECUTING",
    createdAt: "2026-08-21T00:00:00.000Z",
    environmentId: "env_1",
    environmentType: "PRODUCTION",
    projectId: "proj_1",
    organizationId: "org_1",
    ...over,
  };
}

function birthUnit(
  runId: string,
  residency: "mirrored" | "redis-primary",
  over: Partial<PreparedPgUnit> = {}
): PreparedPgUnit {
  const b: PreparedEntry = { entry: entry({ id: "b0", runId }), kind: "birth", isTerminal: false };
  return {
    protocolVersion: 1,
    transitionToken: "birth",
    postgresXid: "1",
    runId,
    organizationId: "org_1",
    residency,
    logicalRunStoreRoute: "logical:1",
    entries: [b],
    ...over,
  };
}

// A finalized birth: prepare then finalize, so the run-state keyspace and residency marker exist,
// exactly as a real committed birth does.
async function committedBirth(
  store: RedisSnapshotStore,
  runId: string,
  residency: "mirrored" | "redis-primary"
): Promise<void> {
  await store.prepare(birthUnit(runId, residency));
  await store.finalize(runId, "birth");
}

describe("SnapshotResidencyResolver durable resolution", () => {
  containerTest(
    "resolution uses durable state without a TaskRun probe or a cached answer",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      let existenceQueries = 0;
      // Instrument the old seam with a REAL query. It must be unused by the stateless resolver.
      const options = {
        store,
        taskRunExists: async (runId: string) => {
          existenceQueries++;
          return (await prisma.taskRun.count({ where: { id: runId } })) > 0;
        },
      };
      const resolver = new SnapshotResidencyResolver(options);
      try {
        expect(await resolver.resolve("run_never_created")).toEqual({ kind: "absent" });
        expect(existenceQueries).toBe(0);
        await committedBirth(store, "run_durable_only", "redis-primary");
        expect(await resolver.resolve("run_durable_only")).toEqual({
          kind: "committed",
          residency: "redis-primary",
        });
        await store.quit();
        expect(await resolver.resolve("run_durable_only")).toEqual({ kind: "error" });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("a finalized mirrored birth resolves committed mirrored", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_res_mirrored";
      await committedBirth(store, runId, "mirrored");
      const resolver = new SnapshotResidencyResolver({ store });
      expect(await resolver.resolve(runId)).toEqual({ kind: "committed", residency: "mirrored" });
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "a finalized redis-primary birth resolves committed redis-primary",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_res_redisprimary";
        await committedBirth(store, runId, "redis-primary");
        const resolver = new SnapshotResidencyResolver({ store });
        expect(await resolver.resolve(runId)).toEqual({
          kind: "committed",
          residency: "redis-primary",
        });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("a prepared-but-unfinalized birth resolves pendingBirth", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_res_pending";
      await store.prepare(birthUnit(runId, "redis-primary"));
      const resolver = new SnapshotResidencyResolver({ store });
      expect(await resolver.resolve(runId)).toEqual({ kind: "pendingBirth" });
      await store.finalize(runId, "birth");
      expect(await resolver.resolve(runId)).toEqual({
        kind: "committed",
        residency: "redis-primary",
      });
    } finally {
      await store.quit();
    }
  });

  redisTest("a run with no MemoryDB state resolves absent", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const resolver = new SnapshotResidencyResolver({ store });
      expect(await resolver.resolve("run_res_absent")).toEqual({ kind: "absent" });
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "a redis-primary run whose state expired (marker remaining) resolves expired",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_res_expired";
        await committedBirth(store, runId, "redis-primary");
        // Drop the run-state keys, leaving the no-TTL residency marker: the aged-out redis-primary run.
        await store.dropRun(runId);
        const resolver = new SnapshotResidencyResolver({ store });
        expect(await resolver.resolve(runId)).toEqual({ kind: "expired" });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a mirrored run whose state expired resolves absent (reads Postgres)",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_res_mirror_expired";
        await committedBirth(store, runId, "mirrored");
        await store.dropRun(runId);
        const resolver = new SnapshotResidencyResolver({ store });
        expect(await resolver.resolve(runId)).toEqual({ kind: "absent" });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("a MemoryDB read failure resolves error, fail closed", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      await store.quit();
      const resolver = new SnapshotResidencyResolver({ store });
      expect(await resolver.resolve("run_res_error")).toEqual({ kind: "error" });
    } finally {
      await store.quit();
    }
  });

  redisTest("an unknown state version fails closed to error", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const raw = createRedisClient(redisOptions);
    try {
      const runId = "run_res_badversion";
      await committedBirth(store, runId, "redis-primary");
      // Corrupt the stored state version: a value this build does not understand fails closed.
      await raw.hset(snapshotKeys(runId).seq, "sv", "999");
      const resolver = new SnapshotResidencyResolver({ store });
      expect(await resolver.resolve(runId)).toEqual({ kind: "error" });
    } finally {
      await raw.quit();
      await store.quit();
    }
  });
});
