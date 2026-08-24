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
      readPercent: 100,
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
