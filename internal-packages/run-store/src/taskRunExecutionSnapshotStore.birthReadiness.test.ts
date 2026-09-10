// The redis-only BIRTH readiness gate. When the MemoryDB is not ready, a redis-only dial must not mint a
// new redis-primary run: it degrades to a mirrored birth (still fully written to Postgres) so nothing is
// stranded on an unready cluster, while enrollment is untouched. It gates NEW births ALONE: an existing
// redis-primary run's transition follows durable residency and is never redirected, even at not-ready.
// Proven end-to-end against REAL Postgres + REAL Redis (testcontainers, no mocks).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";

function birthSnapshot(env: Awaited<ReturnType<typeof seedSnapshotEnvironment>>, id: string) {
  return {
    id,
    createdAt: new Date(),
    engine: "V2" as const,
    executionStatus: "RUN_CREATED" as const,
    description: "Run was created",
    runStatus: "PENDING" as const,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

function transitionInput(
  env: Awaited<ReturnType<typeof seedSnapshotEnvironment>>,
  runId: string,
  id: string,
  previousSnapshotId: string
) {
  return {
    id,
    createdAt: new Date(),
    run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING" as const, description: "Run started" },
    previousSnapshotId,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

function tresCount(prisma: PrismaClient, id: string): Promise<number> {
  return prisma.taskRunExecutionSnapshot.count({ where: { id } });
}

describe("TaskRunExecutionSnapshotStore redis-only birth readiness gate", () => {
  containerTest(
    "a redis-only birth is capped to mirrored (writes Postgres) while NOT ready",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();

        const notReady = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          resolveDial: () => "redis-only",
          logicalRunStoreRoute: ROUTE,
          redisPrimaryBirthReady: () => false,
        });

        await notReady.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        // Degraded to mirrored: the birth snapshot IS written to Postgres, and the durable residency is
        // mirrored, never redis-primary. Enrollment (the redis-only dial) is unchanged.
        expect(await tresCount(prisma, birthId)).toBe(1);
        expect(await store.readBirthResidency(runId)).toBe("mirrored");
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a redis-only birth is redis-primary (no Postgres row) once ready",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();

        const ready = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          resolveDial: () => "redis-only",
          logicalRunStoreRoute: ROUTE,
          redisPrimaryBirthReady: () => true,
        });

        await ready.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        expect(await tresCount(prisma, birthId)).toBe(0);
        expect(await store.readBirthResidency(runId)).toBe("redis-primary");
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "an already redis-primary run's transition is NEVER redirected by a later not-ready gate",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        // Born redis-primary while ready.
        const ready = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          resolveDial: () => "redis-only",
          logicalRunStoreRoute: ROUTE,
          redisPrimaryBirthReady: () => true,
        });
        await ready.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        // A DIFFERENT store instance that is now NOT ready runs the transition. The transition follows the
        // run's durable redis-primary residency, not the birth gate: still no Postgres row.
        const nowNotReady = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          resolveDial: () => "redis-only",
          logicalRunStoreRoute: ROUTE,
          redisPrimaryBirthReady: () => false,
        });
        await nowNotReady.createExecutionSnapshot(
          transitionInput(env, runId, transitionId, birthId)
        );

        expect(await tresCount(prisma, transitionId)).toBe(0);
        expect(await store.readBirthResidency(runId)).toBe("redis-primary");
      } finally {
        await store.quit();
      }
    }
  );
});
