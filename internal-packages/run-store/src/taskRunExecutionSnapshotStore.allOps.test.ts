// Item 3: EVERY snapshot-producing RunStore op must participate in the transaction-sized prepared
// unit, not just createRun/createExecutionSnapshot/lockRunToWorker. This proves the internal snapshot
// writes of cancellation, attempt completion, expiry, parked-run expiry and reschedule mirror to
// MemoryDB (mirrored) or become redis-primary (redis-only) instead of bypassing the mirror, and that
// the two conditional no-op paths prepare nothing. Proven end-to-end against REAL Postgres + REAL
// Redis (testcontainers, no mocks).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import { snapshotKeys } from "./snapshotKeys.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";
import type { SnapshotFixtureEnv } from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";

function birthSnapshot(env: SnapshotFixtureEnv, id: string) {
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

function completionData(env: SnapshotFixtureEnv, snapshotId: string) {
  return {
    completedAt: new Date(),
    output: "{}",
    outputType: "application/json",
    usageDurationMs: 100,
    costInCents: 0,
    snapshot: {
      id: snapshotId,
      createdAt: new Date(),
      executionStatus: "FINISHED" as const,
      description: "Attempt completed",
      runStatus: "COMPLETED_SUCCESSFULLY" as const,
      attemptNumber: 1,
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    },
  };
}

function expireData(env: SnapshotFixtureEnv, snapshotId: string) {
  return {
    error: { type: "STRING_ERROR" as const, raw: "expired" },
    completedAt: new Date(),
    expiredAt: new Date(),
    snapshot: {
      id: snapshotId,
      createdAt: new Date(),
      engine: "V2" as const,
      executionStatus: "FINISHED" as const,
      description: "Run expired",
      runStatus: "EXPIRED" as const,
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    },
  };
}

function rescheduleData(env: SnapshotFixtureEnv, snapshotId: string, delayUntil: Date) {
  return {
    delayUntil,
    snapshot: {
      id: snapshotId,
      createdAt: new Date(),
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    },
  };
}

function cancelledInput(env: SnapshotFixtureEnv, runId: string, snapshotId: string) {
  return {
    data: {
      ...buildCreateRunData(runId, env),
      status: "CANCELED" as const,
      error: { type: "STRING_ERROR", raw: "cancelled" } as const,
      completedAt: new Date(),
      updatedAt: new Date(),
      attemptNumber: 0 as const,
    },
    snapshot: {
      id: snapshotId,
      createdAt: new Date(),
      engine: "V2" as const,
      executionStatus: "FINISHED" as const,
      description: "Run was cancelled",
      runStatus: "CANCELED" as const,
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    },
  };
}

function mirrored(delegate: PostgresRunStore, store: RedisSnapshotStore) {
  return new TaskRunExecutionSnapshotStore(delegate, {
    store,
    mode: "dual-write",
    resolveDial: () => "dual-write",
    logicalRunStoreRoute: ROUTE,
  });
}

function redisPrimary(delegate: PostgresRunStore, store: RedisSnapshotStore) {
  return new TaskRunExecutionSnapshotStore(delegate, {
    store,
    mode: "redis-only",
    resolveDial: () => "redis-only",
    logicalRunStoreRoute: ROUTE,
  });
}

function tresCount(prisma: Parameters<typeof seedSnapshotEnvironment>[0], id: string) {
  return prisma.taskRunExecutionSnapshot.count({ where: { id } });
}

describe("TaskRunExecutionSnapshotStore all snapshot-producing ops (mirrored)", () => {
  containerTest(
    "completeAttemptSuccess mirrors: TRES row + head advances",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const completionId = generateInternalId();
        const writer = mirrored(delegate, store);

        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.completeAttemptSuccess(runId, completionData(env, completionId), {
          select: { id: true },
        });

        expect(await tresCount(prisma, completionId)).toBe(1);
        expect((await store.getLatest(runId))?.id).toBe(completionId);
        expect((await prisma.taskRun.findFirstOrThrow({ where: { id: runId } })).status).toBe(
          "COMPLETED_SUCCESSFULLY"
        );
      } finally {
        await store.quit();
      }
    }
  );

  containerTest("expireRun mirrors: TRES row + head advances", async ({ prisma, redisOptions }) => {
    const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      const birthId = generateInternalId();
      const expireId = generateInternalId();
      const writer = mirrored(delegate, store);

      await writer.createRun({
        data: buildCreateRunData(runId, env),
        snapshot: birthSnapshot(env, birthId),
      });
      await writer.expireRun(runId, expireData(env, expireId), { select: { id: true } });

      expect(await tresCount(prisma, expireId)).toBe(1);
      expect((await store.getLatest(runId))?.id).toBe(expireId);
      expect((await prisma.taskRun.findFirstOrThrow({ where: { id: runId } })).status).toBe(
        "EXPIRED"
      );
    } finally {
      await store.quit();
    }
  });

  containerTest(
    "createCancelledRun mirrors: TRES row + head is the cancellation",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const cancelId = generateInternalId();
        const writer = mirrored(delegate, store);

        await writer.createCancelledRun(cancelledInput(env, runId, cancelId));

        expect(await tresCount(prisma, cancelId)).toBe(1);
        expect((await store.getLatest(runId))?.id).toBe(cancelId);
        expect((await prisma.taskRun.findFirstOrThrow({ where: { id: runId } })).status).toBe(
          "CANCELED"
        );
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "rescheduleRun (with snapshot) mirrors: TRES row + head advances",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const rescheduleId = generateInternalId();
        const delayUntil = new Date(Date.now() + 60_000);
        const writer = mirrored(delegate, store);

        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.rescheduleRun(runId, rescheduleData(env, rescheduleId, delayUntil));

        expect(await tresCount(prisma, rescheduleId)).toBe(1);
        expect((await store.getLatest(runId))?.id).toBe(rescheduleId);
        expect(
          (
            await prisma.taskRun.findFirstOrThrow({ where: { id: runId } })
          ).delayUntil?.toISOString()
        ).toBe(delayUntil.toISOString());
      } finally {
        await store.quit();
      }
    }
  );
});

describe("TaskRunExecutionSnapshotStore all snapshot-producing ops (redis-primary)", () => {
  containerTest(
    "completeAttemptSuccess: NO TRES row, head advances, run mutation lands",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const completionId = generateInternalId();
        const writer = redisPrimary(delegate, store);

        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.completeAttemptSuccess(runId, completionData(env, completionId), {
          select: { id: true },
        });

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
        expect((await store.getLatest(runId))?.id).toBe(completionId);
        expect((await prisma.taskRun.findFirstOrThrow({ where: { id: runId } })).status).toBe(
          "COMPLETED_SUCCESSFULLY"
        );
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "expireRun: NO TRES row, head advances, run mutation lands",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const expireId = generateInternalId();
        const writer = redisPrimary(delegate, store);

        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.expireRun(runId, expireData(env, expireId), { select: { id: true } });

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
        expect((await store.getLatest(runId))?.id).toBe(expireId);
        expect((await prisma.taskRun.findFirstOrThrow({ where: { id: runId } })).status).toBe(
          "EXPIRED"
        );
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "createCancelledRun: NO TRES row, run row created, head is the cancellation",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const cancelId = generateInternalId();
        const writer = redisPrimary(delegate, store);

        await writer.createCancelledRun(cancelledInput(env, runId, cancelId));

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
        expect(await prisma.taskRun.count({ where: { id: runId } })).toBe(1);
        expect((await prisma.taskRun.findFirstOrThrow({ where: { id: runId } })).status).toBe(
          "CANCELED"
        );
        expect((await store.getLatest(runId))?.id).toBe(cancelId);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "rescheduleRun (with snapshot): NO TRES row, head advances, delay lands",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const rescheduleId = generateInternalId();
        const delayUntil = new Date(Date.now() + 60_000);
        const writer = redisPrimary(delegate, store);

        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.rescheduleRun(runId, rescheduleData(env, rescheduleId, delayUntil));

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
        expect((await store.getLatest(runId))?.id).toBe(rescheduleId);
        expect(
          (
            await prisma.taskRun.findFirstOrThrow({ where: { id: runId } })
          ).delayUntil?.toISOString()
        ).toBe(delayUntil.toISOString());
      } finally {
        await store.quit();
      }
    }
  );
});

describe("TaskRunExecutionSnapshotStore no-phantom-entry conditional paths", () => {
  containerTest(
    "rescheduleRun WITHOUT a snapshot mirrors nothing: head stays, no prepared unit",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const delayUntil = new Date(Date.now() + 60_000);
        const writer = mirrored(delegate, store);

        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.rescheduleRun(runId, { delayUntil });

        // The delay landed, but nothing new mirrored: the head is still the birth, no unit prepared.
        expect(
          (
            await prisma.taskRun.findFirstOrThrow({ where: { id: runId } })
          ).delayUntil?.toISOString()
        ).toBe(delayUntil.toISOString());
        expect((await store.getLatest(runId))?.id).toBe(birthId);
        expect(await store.hasPreparedUnit(runId)).toBe(false);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "expireParkedRun no-op (P2025) mirrors nothing: head stays, no prepared unit",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const writer = mirrored(delegate, store);

        // The run is PENDING, not PENDING_VERSION, so expireParkedRun's guarded update matches nothing.
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        const result = await writer.expireParkedRun(runId, {
          error: { type: "STRING_ERROR", raw: "expired" },
          completedAt: new Date(),
          expiredAt: new Date(),
          statusReason: "VERSION_NEVER_ARRIVED",
          snapshot: {
            id: generateInternalId(),
            createdAt: new Date(),
            engine: "V2",
            executionStatus: "FINISHED",
            description: "Parked run expired",
            runStatus: "EXPIRED",
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          },
        });

        expect(result.count).toBe(0);
        expect((await store.getLatest(runId))?.id).toBe(birthId);
        expect(await store.hasPreparedUnit(runId)).toBe(false);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "expireParkedRun that acts (PENDING_VERSION) mirrors: head advances",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const expireId = generateInternalId();
        const writer = mirrored(delegate, store);

        await writer.createRun({
          data: { ...buildCreateRunData(runId, env), status: "PENDING_VERSION" },
          snapshot: { ...birthSnapshot(env, birthId), runStatus: "PENDING_VERSION" },
        });
        const result = await writer.expireParkedRun(runId, {
          error: { type: "STRING_ERROR", raw: "expired" },
          completedAt: new Date(),
          expiredAt: new Date(),
          statusReason: "VERSION_NEVER_ARRIVED",
          snapshot: {
            id: expireId,
            createdAt: new Date(),
            engine: "V2",
            executionStatus: "FINISHED",
            description: "Parked run expired",
            runStatus: "EXPIRED",
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          },
        });

        expect(result.count).toBe(1);
        expect(await tresCount(prisma, expireId)).toBe(1);
        expect((await store.getLatest(runId))?.id).toBe(expireId);
      } finally {
        await store.quit();
      }
    }
  );
});

describe("TaskRunExecutionSnapshotStore ordering and terminal TTL", () => {
  containerTest(
    "TWO snapshot ops in ONE runInTransaction form one ordered unit; head is the last",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const rescheduleId = generateInternalId();
        const completionId = generateInternalId();
        const delayUntil = new Date(Date.now() + 60_000);
        const writer = mirrored(delegate, store);

        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.runInTransaction(runId, async (txStore) => {
          await txStore.rescheduleRun(runId, rescheduleData(env, rescheduleId, delayUntil));
          await txStore.completeAttemptSuccess(runId, completionData(env, completionId), {
            select: { id: true },
          });
        });

        expect(await tresCount(prisma, rescheduleId)).toBe(1);
        expect(await tresCount(prisma, completionId)).toBe(1);
        expect((await store.getLatest(runId))?.id).toBe(completionId);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a terminal op applies the completion TTL to the run keys",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const completionId = generateInternalId();
        const writer = mirrored(delegate, store);

        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        // The birth is non-terminal, so its keys carry no TTL yet.
        expect(await raw.pttl(snapshotKeys(runId).e)).toBe(-1);

        await writer.completeAttemptSuccess(runId, completionData(env, completionId), {
          select: { id: true },
        });

        const ttl = await raw.pttl(snapshotKeys(runId).e);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(60_000);
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );
});
