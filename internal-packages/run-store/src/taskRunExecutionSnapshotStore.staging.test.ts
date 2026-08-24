// Inside a transaction the Redis append cannot run until the Postgres side commits, or a rollback
// leaves Redis holding a transition that never happened. These tests observe the buffer from inside
// the callback, so the deferral is proved rather than assumed.
import { describe, expect } from "vitest";
import { postgresAndRedisTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { entryFromCreateRun } from "./snapshotEntry.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  type SnapshotFixtureEnv,
} from "./testFixtures/snapshotIdFixture.js";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;

function build(prisma: never, redisOptions: never, mode: "off" | "dual-write" = "dual-write") {
  const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
  const decorated = new TaskRunExecutionSnapshotStore(
    new PostgresRunStore({ prisma, readOnlyPrisma: prisma }) as unknown as RunStore,
    { store: redis, mode }
  );
  return { decorated, redis };
}

async function seedBirth(
  decorated: TaskRunExecutionSnapshotStore,
  redis: RedisSnapshotStore,
  runId: string,
  env: SnapshotFixtureEnv
): Promise<void> {
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
}

function snapshotInput(runId: string, env: SnapshotFixtureEnv, id: string, description: string) {
  return {
    id,
    run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING" as const, description },
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

describe("the staging facade", () => {
  postgresAndRedisTest("flushes the append after the commit", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = build(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      await seedBirth(decorated, redis, runId, env);
      const id = generateInternalId();

      await decorated.runInTransaction(runId, async (store, tx) => {
        await store.createExecutionSnapshot(snapshotInput(runId, env, id, "Run started"), tx);

        // Still inside the transaction: nothing has reached Redis yet.
        expect(await redis.getById(runId, id)).toBeNull();
      });

      expect(await redis.getById(runId, id)).not.toBeNull();
      expect(await prisma.taskRunExecutionSnapshot.count({ where: { id } })).toBe(1);
    } finally {
      await redis.quit();
    }
  });

  postgresAndRedisTest(
    "writes nothing to Redis when the transaction rolls back",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await seedBirth(decorated, redis, runId, env);
        const id = generateInternalId();

        await expect(
          decorated.runInTransaction(runId, async (store, tx) => {
            await store.createExecutionSnapshot(snapshotInput(runId, env, id, "Run started"), tx);
            throw new Error("rolled back");
          })
        ).rejects.toThrow("rolled back");

        // Both sides agree that the transition never happened.
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { id } })).toBe(0);
        expect(await redis.getById(runId, id)).toBeNull();
      } finally {
        await redis.quit();
      }
    }
  );

  postgresAndRedisTest("flushes several staged appends in order", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = build(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      await seedBirth(decorated, redis, runId, env);
      const first = generateInternalId();
      const second = generateInternalId();

      await decorated.runInTransaction(runId, async (store, tx) => {
        await store.createExecutionSnapshot(snapshotInput(runId, env, first, "First"), tx);
        await store.createExecutionSnapshot(snapshotInput(runId, env, second, "Second"), tx);
      });

      const firstRead = await redis.getById(runId, first);
      const secondRead = await redis.getById(runId, second);
      expect(firstRead).not.toBeNull();
      expect(secondRead).not.toBeNull();
      // Order matters: the log is append-only and its seq is what orders a read.
      expect(firstRead!.seq).toBeLessThan(secondRead!.seq);
    } finally {
      await redis.quit();
    }
  });

  postgresAndRedisTest(
    "hands the transaction callback a decorated store",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await seedBirth(decorated, redis, runId, env);
        let seen: unknown;

        await decorated.runInTransaction(runId, async (store) => {
          seen = store;
        });

        expect(seen).toBeInstanceOf(TaskRunExecutionSnapshotStore);
        expect((seen as TaskRunExecutionSnapshotStore).mode).toBe("dual-write");
      } finally {
        await redis.quit();
      }
    }
  );

  postgresAndRedisTest(
    "hands the transaction callback the plain delegate at mode off",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never, "off");
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await decorated.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: {
            id: generateInternalId(),
            engine: "V2",
            executionStatus: "RUN_CREATED",
            description: "Run was created",
            runStatus: "PENDING",
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          },
        });
        let seen: unknown;

        await decorated.runInTransaction(runId, async (store) => {
          seen = store;
        });

        expect(seen).not.toBeInstanceOf(TaskRunExecutionSnapshotStore);
        expect(await redis.getLatest(runId)).toBeNull();
      } finally {
        await redis.quit();
      }
    }
  );

  postgresAndRedisTest(
    "wraps the store handle from forWaitpointCompletion",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const handle = await decorated.forWaitpointCompletion(generateInternalId(), {
          routeKind: "MANUAL",
        } as never);

        // No snapshot write goes through this handle today. Wrapping it is what stops a future one
        // from bypassing the decorator with no signal.
        expect(handle).toBeInstanceOf(TaskRunExecutionSnapshotStore);
      } finally {
        await redis.quit();
      }
    }
  );

  postgresAndRedisTest(
    "returns the plain handle from forWaitpointCompletion at mode off",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never, "off");
      try {
        const handle = await decorated.forWaitpointCompletion(generateInternalId(), {
          routeKind: "MANUAL",
        } as never);

        expect(handle).not.toBeInstanceOf(TaskRunExecutionSnapshotStore);
      } finally {
        await redis.quit();
      }
    }
  );
});
