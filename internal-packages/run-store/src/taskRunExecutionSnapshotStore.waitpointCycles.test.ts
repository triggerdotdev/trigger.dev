// The completed-waitpoint path, which every other suite here was blind to.
//
// Two defects hid behind that blindness. The decorator passed no cycle to `append`, so no
// wp:<cycleSeq> key was ever written and the Redis waitpoint side was permanently empty. And the
// since-window hydration returned an empty `completedWaitpointOrder`, which is the index oracle the
// engine uses to give each completed waitpoint its position in a batch — an empty order resumes
// every batched triggerAndWait with `index: undefined`.
//
// So these tests all use a snapshot that ACTUALLY carries waitpoints. A test that does not cannot
// tell a working cycle from a missing one.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { entryFromCreateRun } from "./snapshotEntry.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  seedSnapshotWaitpoints,
  type SnapshotFixtureEnv,
} from "./testFixtures/snapshotIdFixture.js";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;

function build(
  prisma: never,
  redisOptions: never,
  mode: "dual-write" | "redis-read" = "redis-read"
) {
  const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
  const writes: { site: string; outcome: string }[] = [];
  const decorated = new TaskRunExecutionSnapshotStore(
    new PostgresRunStore({ prisma, readOnlyPrisma: prisma }) as unknown as RunStore,
    {
      store: redis,
      mode,
      metrics: {
        recordWrite: (site, outcome) => writes.push({ site, outcome }),
        recordAppendFailed: () => {},
        recordRead: () => {},
      },
    }
  );
  return { decorated, redis, writes };
}

async function seedRun(
  decorated: TaskRunExecutionSnapshotStore,
  redis: RedisSnapshotStore,
  env: SnapshotFixtureEnv
): Promise<string> {
  const runId = generateInternalId();
  const snapshot = {
    id: generateInternalId(),
    engine: "V2" as const,
    executionStatus: "RUN_CREATED" as const,
    description: "Run was created",
    runStatus: "PENDING" as const,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
  await redis.append({
    entry: entryFromCreateRun({ id: snapshot.id, runId, createdAt: new Date() }, snapshot),
    kind: "birth",
    isTerminal: false,
  });
  await decorated.createRun({ data: buildCreateRunData(runId, env), snapshot });
  return runId;
}

function resumeInput(
  runId: string,
  env: SnapshotFixtureEnv,
  completedWaitpoints: { id: string; index?: number }[],
  description = "Run resumed"
) {
  return {
    id: generateInternalId(),
    run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING" as const, description },
    completedWaitpoints,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

describe("completed-waitpoint cycles", () => {
  containerTest("a resume append mints a cycle key", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = build(prisma as never, redisOptions as never);
    const probe = createRedisClient(redisOptions, { onError: () => {} });
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = await seedRun(decorated, redis, env);
      const [wpA, wpB] = await seedSnapshotWaitpoints(prisma, env, 2);

      const created = await decorated.createExecutionSnapshot(
        resumeInput(runId, env, [
          { id: wpA, index: 0 },
          { id: wpB, index: 1 },
        ])
      );

      // The key exists at all — before the fix, none was ever written.
      const cycleKeys = await probe.keys(`snap:{${runId}}:wp:*`);
      expect(cycleKeys.length).toBe(1);

      const ids = await redis.getSnapshotWaitpointIds(runId, created.id);
      expect(ids.present).toBe(true);
      expect(ids.order).toEqual([wpA, wpB]);
      expect(ids.distinctIds).toEqual([wpA, wpB]);
    } finally {
      await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
    }
  });

  containerTest(
    "a copy-forward reuses the cycle and writes no second key",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA, wpB] = await seedSnapshotWaitpoints(prisma, env, 2);
        const waitpoints = [
          { id: wpA, index: 0 },
          { id: wpB, index: 1 },
        ];

        await decorated.createExecutionSnapshot(resumeInput(runId, env, waitpoints, "resume"));
        // The same id set again: this is the copy-forward every dequeue and checkpoint site does.
        const second = await decorated.createExecutionSnapshot(
          resumeInput(runId, env, waitpoints, "carry one")
        );
        const third = await decorated.createExecutionSnapshot(
          resumeInput(runId, env, waitpoints, "carry two")
        );

        // Still ONE key. Re-minting per entry is the write amplification the pointer model removes.
        expect((await probe.keys(`snap:{${runId}}:wp:*`)).length).toBe(1);

        // And every entry still resolves the same order.
        for (const id of [second.id, third.id]) {
          expect((await redis.getSnapshotWaitpointIds(runId, id)).order).toEqual([wpA, wpB]);
        }
      } finally {
        await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest(
    "a newly-differing id set mints a second cycle",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA, wpB] = await seedSnapshotWaitpoints(prisma, env, 2);

        await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [{ id: wpA, index: 0 }], "first wait")
        );
        const second = await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [{ id: wpB, index: 0 }], "second wait")
        );

        expect((await probe.keys(`snap:{${runId}}:wp:*`)).length).toBe(2);
        expect((await redis.getSnapshotWaitpointIds(runId, second.id)).order).toEqual([wpB]);
      } finally {
        await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest(
    "the same ids in a different order are a new cycle",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA, wpB] = await seedSnapshotWaitpoints(prisma, env, 2);

        await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [
            { id: wpA, index: 0 },
            { id: wpB, index: 1 },
          ])
        );
        // Order IS the index oracle, so a reordering is a different cycle, not a carry-forward.
        const reordered = await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [
            { id: wpB, index: 0 },
            { id: wpA, index: 1 },
          ])
        );

        expect((await probe.keys(`snap:{${runId}}:wp:*`)).length).toBe(2);
        expect((await redis.getSnapshotWaitpointIds(runId, reordered.id)).order).toEqual([
          wpB,
          wpA,
        ]);
      } finally {
        await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest("a repeated id keeps both of its positions", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = build(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = await seedRun(decorated, redis, env);
      const [wpX] = await seedSnapshotWaitpoints(prisma, env, 1);

      // One run batched twice under a single idempotency key: the id repeats, and each position
      // must survive, because the runner matches results to positions.
      const created = await decorated.createExecutionSnapshot(
        resumeInput(runId, env, [
          { id: wpX, index: 0 },
          { id: wpX, index: 1 },
        ])
      );

      const ids = await redis.getSnapshotWaitpointIds(runId, created.id);
      expect(ids.order).toEqual([wpX, wpX]);
      expect(ids.distinctIds).toEqual([wpX]);
    } finally {
      await redis.quit();
    }
  });

  containerTest(
    "keeps a completed waitpoint that has no batch index",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA] = await seedSnapshotWaitpoints(prisma, env, 1);

        // Every wait.for, every single triggerAndWait and every token resumes with no batch index:
        // the engine passes `index: b.batchIndex ?? undefined`. Postgres records the id in the
        // completed-waitpoint join regardless. The ordered list cannot hold it, because its
        // positions ARE the indexes, so the complete set has to be stored separately or the wait's
        // result vanishes on a Redis read.
        const created = await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [{ id: wpA }], "single wait")
        );

        const ids = await redis.getSnapshotWaitpointIds(runId, created.id);
        expect(ids.present).toBe(true);
        expect(ids.distinctIds).toEqual([wpA]);
        // No position, so it is absent from the oracle. That part is correct.
        expect(ids.order).toEqual([]);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "matches the Postgres join for a mix of indexed and index-less waits",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA, wpB, wpC] = await seedSnapshotWaitpoints(prisma, env, 3);

        const created = await decorated.createExecutionSnapshot(
          resumeInput(
            runId,
            env,
            [{ id: wpA, index: 0 }, { id: wpB }, { id: wpC, index: 1 }],
            "mixed wait"
          )
        );

        // Parity with what Postgres holds is the actual requirement: the engine iterates the rows
        // this set fetches, and uses the order only to assign each one its index.
        const fromRedis = await redis.getSnapshotWaitpointIds(runId, created.id);
        const fromPostgres = await new PostgresRunStore({
          prisma,
          readOnlyPrisma: prisma,
        }).findSnapshotCompletedWaitpointIds(created.id, undefined, runId);

        expect([...fromRedis.distinctIds].sort()).toEqual([...fromPostgres].sort());
        expect(fromRedis.order).toEqual([wpA, wpC]);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "two consecutive index-less waits do not share a cycle",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA, wpB] = await seedSnapshotWaitpoints(prisma, env, 2);

        // Neither wait has a batch index, so both present an EMPTY order. Deciding carry-forward on
        // the order alone makes them compare equal, and the second silently inherits the first's
        // waitpoint set: its own result is never stored and a read returns the wrong id.
        const first = await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [{ id: wpA }], "first single wait")
        );
        const second = await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [{ id: wpB }], "second single wait")
        );

        expect((await redis.getSnapshotWaitpointIds(runId, first.id)).distinctIds).toEqual([wpA]);
        expect((await redis.getSnapshotWaitpointIds(runId, second.id)).distinctIds).toEqual([wpB]);
        expect((await probe.keys(`snap:{${runId}}:wp:*`)).length).toBe(2);
      } finally {
        await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest(
    "the same index-less wait repeated does still carry forward",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA] = await seedSnapshotWaitpoints(prisma, env, 1);

        // The copy-forward case must survive the stricter comparison: the same id set, still one key.
        await decorated.createExecutionSnapshot(resumeInput(runId, env, [{ id: wpA }], "wait"));
        const carried = await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [{ id: wpA }], "carry")
        );

        expect((await probe.keys(`snap:{${runId}}:wp:*`)).length).toBe(1);
        expect((await redis.getSnapshotWaitpointIds(runId, carried.id)).distinctIds).toEqual([wpA]);
      } finally {
        await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest(
    "the dequeue snapshot keeps an index-less waitpoint",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA, wpB] = await seedSnapshotWaitpoints(prisma, env, 2);
        const head = await redis.getLatest(runId);
        const snapshotId = generateInternalId();

        // Postgres connects completedWaitpointIds, the COMPLETE set. Building the Redis refs from
        // completedWaitpointOrder instead drops every id that has no position in it.
        await decorated.lockRunToWorker(runId, {
          lockedAt: new Date(),
          lockedById: undefined,
          lockedToVersionId: undefined,
          lockedQueueId: undefined,
          startedAt: new Date(),
          baseCostInCents: 0,
          machinePreset: "small-1x",
          taskVersion: "1.0.0",
          snapshot: {
            id: snapshotId,
            previousSnapshotId: head!.id,
            attemptNumber: 1,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
            completedWaitpointIds: [wpA, wpB],
            completedWaitpointOrder: [wpA],
          },
        } as never);

        const ids = await redis.getSnapshotWaitpointIds(runId, snapshotId);
        expect([...ids.distinctIds].sort()).toEqual([wpA, wpB].sort());
        expect(ids.order).toEqual([wpA]);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "findLatestExecutionSnapshot hydrates an index-less waitpoint row",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA] = await seedSnapshotWaitpoints(prisma, env, 1);

        await decorated.createExecutionSnapshot(resumeInput(runId, env, [{ id: wpA }], "single"));

        // The hot read hydrates the rows from the id set, so an incomplete set means the resume
        // gets no waitpoint at all.
        const latest = await decorated.findLatestExecutionSnapshot(runId);
        expect(latest!.completedWaitpoints.map((w) => w.id)).toEqual([wpA]);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "a refused carry mints a fresh cycle rather than writing a pointerless head",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA] = await seedSnapshotWaitpoints(prisma, env, 1);
        const snapshotId = generateInternalId();

        // Driven at the store, because the decorator cannot reach this state deliberately: its
        // probe reads the head first, sees the id set no longer matches, and mints a new cycle.
        // The refusal is only reachable when the key vanishes BETWEEN that probe and the append,
        // which is a race. Naming a cycle this incarnation never minted reproduces the same
        // refusal deterministically.
        const result = await redis.append({
          entry: {
            id: snapshotId,
            engine: "V2",
            executionStatus: "EXECUTING",
            description: "carry a cycle that was never minted",
            runId,
            runStatus: "EXECUTING",
            createdAt: new Date().toISOString(),
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          },
          kind: "transition",
          isTerminal: false,
          cycle: {
            kind: "carryForward",
            cycleSeq: 9999,
            completedWaitpoints: [{ id: wpA, index: 0 }],
          },
        });

        expect(result.outcome).toBe("written");
        if (result.outcome !== "written") return;

        // Refusing the pointer is right. Writing the entry with NO pointer is not: it becomes the
        // head, and a read of it answers present-with-nothing, which is the one answer that stops
        // the engine's read-repair from looking.
        expect(result.cycleMismatch).toBe(true);
        expect(result.cycleSeq).toBeGreaterThan(0);

        const ids = await redis.getSnapshotWaitpointIds(runId, snapshotId);
        expect(ids.present).toBe(true);
        expect(ids.distinctIds).toEqual([wpA]);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "a dangling pointer reads as not present, not as an empty set",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA] = await seedSnapshotWaitpoints(prisma, env, 1);

        const created = await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [{ id: wpA, index: 0 }], "resume")
        );

        // The entry keeps its pointer and the cycle key goes. Reachable by eviction, and by the
        // completion TTL, which is set on every key for a run at once but expires them separately.
        for (const key of await probe.keys(`snap:{${runId}}:wp:*`)) await probe.del(key);

        const ids = await redis.getSnapshotWaitpointIds(runId, created.id);
        // present:false is what sends the caller to Postgres, which still holds the join rows.
        // present:true with an empty set would suppress the engine's read-repair.
        expect(ids.present).toBe(false);
        expect(ids.distinctIds).toEqual([]);

        // And the projections the engine actually calls fall back rather than answering empty.
        const withPresence = await decorated.findSnapshotCompletedWaitpointIdsWithPresence(
          created.id,
          undefined,
          runId
        );
        expect(withPresence.ids).toEqual([wpA]);
      } finally {
        await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest(
    "the hot read falls back to Postgres when the cycle key is gone",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA] = await seedSnapshotWaitpoints(prisma, env, 1);

        await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [{ id: wpA, index: 0 }], "resume")
        );
        for (const key of await probe.keys(`snap:{${runId}}:wp:*`)) await probe.del(key);

        const latest = await decorated.findLatestExecutionSnapshot(runId);

        // Served from Postgres, so the waitpoint is still there and the resume is not silently
        // stripped of it.
        expect(latest!.completedWaitpoints.map((w) => w.id)).toEqual([wpA]);
      } finally {
        await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest(
    "findLatestExecutionSnapshot returns the index oracle",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA, wpB] = await seedSnapshotWaitpoints(prisma, env, 2);
        await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [
            { id: wpA, index: 0 },
            { id: wpB, index: 1 },
          ])
        );

        const latest = await decorated.findLatestExecutionSnapshot(runId);

        // completedWaitpointOrder is a scalar column, not the join. Empty here means every batched
        // waitpoint resumes with index undefined.
        expect(latest!.completedWaitpointOrder).toEqual([wpA, wpB]);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "the since-window head carries the index oracle",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA, wpB] = await seedSnapshotWaitpoints(prisma, env, 2);
        const first = await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [], "before the wait")
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [
            { id: wpA, index: 0 },
            { id: wpB, index: 1 },
          ])
        );

        const window = await decorated.findManyExecutionSnapshots({
          where: { runId, isValid: true, createdAt: { gt: first.createdAt } },
          include: { checkpoint: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        });

        // The head is first in a descending window. This is the row the engine reads the oracle off.
        expect(window[0]!.completedWaitpointOrder).toEqual([wpA, wpB]);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "the since-window falls back to Postgres when the head cycle key is gone",
    async ({ prisma, redisOptions }) => {
      // The hot read has always handled this. The since-window did not: its Lua returned the head's
      // order and distinct set but never its dangling flag, so the decorator's fallback guard was
      // dead code and an expired cycle key came back as an EMPTY order. Empty means "no indexed
      // waitpoints" to the engine, which is how a batched triggerAndWait resumes with every
      // position lost rather than falling back to the store that still knows them.
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA, wpB] = await seedSnapshotWaitpoints(prisma, env, 2);
        const first = await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [], "before the wait")
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        await decorated.createExecutionSnapshot(
          resumeInput(runId, env, [
            { id: wpA, index: 0 },
            { id: wpB, index: 1 },
          ])
        );

        // The entry hash survives; only the cycle key goes. The completion TTL is applied per key,
        // so this is a state the keyspace reaches on its own.
        for (const key of await probe.keys(`snap:{${runId}}:wp:*`)) await probe.del(key);

        const window = await decorated.findManyExecutionSnapshots({
          where: { runId, isValid: true, createdAt: { gt: first.createdAt } },
          include: { checkpoint: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        });

        expect(window[0]!.completedWaitpointOrder).toEqual([wpA, wpB]);
      } finally {
        await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest(
    "lockRunToWorker carries its resolved order into the cycle",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);
        const [wpA, wpB] = await seedSnapshotWaitpoints(prisma, env, 2);
        const head = await redis.getLatest(runId);
        const snapshotId = generateInternalId();

        await decorated.lockRunToWorker(runId, {
          lockedAt: new Date(),
          lockedById: undefined,
          lockedToVersionId: undefined,
          lockedQueueId: undefined,
          startedAt: new Date(),
          baseCostInCents: 0,
          machinePreset: "small-1x",
          taskVersion: "1.0.0",
          snapshot: {
            id: snapshotId,
            previousSnapshotId: head!.id,
            attemptNumber: 1,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
            completedWaitpointIds: [wpA, wpB],
            completedWaitpointOrder: [wpA, wpB],
          },
        } as never);

        const ids = await redis.getSnapshotWaitpointIds(runId, snapshotId);
        expect(ids.order).toEqual([wpA, wpB]);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "an append with no waitpoints writes no cycle key",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, redis, env);

        await decorated.createExecutionSnapshot(resumeInput(runId, env, [], "no waitpoints"));

        expect(await probe.keys(`snap:{${runId}}:wp:*`)).toEqual([]);
      } finally {
        await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
      }
    }
  );
});
