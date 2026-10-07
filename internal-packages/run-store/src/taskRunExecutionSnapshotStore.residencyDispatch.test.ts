// Milestone M9: reads dispatch on each run's DURABLE residency (resolved from the MemoryDB birth key),
// not the constructed dial, so backward-dialing (redis-only -> lower) preserves residency.
// Proven end-to-end against REAL Postgres + REAL Redis (testcontainers, no mocks).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  SnapshotReadUnavailableError,
} from "./taskRunExecutionSnapshotStore.js";
import { SnapshotResidencyResolver } from "./snapshotResidencyResolver.js";
import { residencyKey } from "./snapshotKeys.js";
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

// A Postgres-only snapshot row, newer than any MemoryDB head, so a read served from MemoryDB is
// distinguishable from one served from Postgres.
async function insertPostgresOnlySnapshot(
  prisma: PrismaClient,
  env: Awaited<ReturnType<typeof seedSnapshotEnvironment>>,
  runId: string,
  id: string,
  createdAt: Date
) {
  await prisma.taskRunExecutionSnapshot.create({
    data: {
      id,
      runId,
      engine: "V2",
      executionStatus: "EXECUTING",
      description: "Postgres-only newer head",
      runStatus: "EXECUTING",
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
      createdAt,
    },
  });
}

function realResolver(store: RedisSnapshotStore) {
  return new SnapshotResidencyResolver({
    store,
  });
}

describe("TaskRunExecutionSnapshotStore (M9) residency-keyed reads", () => {
  containerTest(
    "a redis-primary run reads from MemoryDB at a LOWERED dial, never Postgres, and fails closed on a Redis miss",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        // Born REDIS-PRIMARY at redis-only.
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.createExecutionSnapshot(transitionInput(env, runId, transitionId, birthId));

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        // Dial turned DOWN to redis-read and to dual-write: BOTH still read the redis-primary head.
        for (const mode of ["redis-read", "dual-write"] as const) {
          const reader = new TaskRunExecutionSnapshotStore(delegate, {
            store,
            mode,
            logicalRunStoreRoute: ROUTE,
            residencyResolver: realResolver(store),
          });
          const head = await reader.findLatestExecutionSnapshot(runId);
          expect(head?.id).toBe(transitionId);
        }

        // Drop the redis-primary snapshot state (marker survives): the read fails closed, NOT to Postgres.
        await store.dropRun(runId);
        expect(await store.readBirthResidency(runId)).toBe("redis-primary");
        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-read",
          logicalRunStoreRoute: ROUTE,
          residencyResolver: realResolver(store),
        });
        await expect(reader.findLatestExecutionSnapshot(runId)).rejects.toBeInstanceOf(
          SnapshotReadUnavailableError
        );
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a mirrored run never serves a Redis head older than committed Postgres",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        // Postgres carries a NEWER head than the MemoryDB birth.
        const pgOnlyId = generateInternalId();
        await insertPostgresOnlySnapshot(
          prisma,
          env,
          runId,
          pgOnlyId,
          new Date(Date.now() + 5_000)
        );

        const redisReader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-read",
          logicalRunStoreRoute: ROUTE,
          residencyResolver: realResolver(store),
        });
        expect((await redisReader.findLatestExecutionSnapshot(runId))?.id).toBe(pgOnlyId);

        const dualReader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
          residencyResolver: realResolver(store),
        });
        expect((await dualReader.findLatestExecutionSnapshot(runId))?.id).toBe(pgOnlyId);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a NEW run born at the lowered dual-write dial gets mirrored residency and reads Postgres",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        expect(await store.readBirthResidency(runId)).toBe("mirrored");
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(1);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a postgres-resident run read at redis-only passes through to Postgres (mixed residency)",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const snapshotId = generateInternalId();

        // A run that exists in Postgres only: no MemoryDB keyspace, no residency marker.
        await delegate.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, snapshotId),
        });
        expect(await store.readBirthResidency(runId)).toBeUndefined();

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          residencyResolver: realResolver(store),
        });
        // Immutable residency: the redis-only dial does NOT reclassify it. It reads Postgres.
        expect((await reader.findLatestExecutionSnapshot(runId))?.id).toBe(snapshotId);
      } finally {
        await store.quit();
      }
    }
  );
});

describe("TaskRunExecutionSnapshotStore default residency resolver", () => {
  containerTest(
    "the default (uninjected) resolver dispatches on residency too",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        // A dual-write reader with NO injected resolver still routes the redis-primary run to Redis.
        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
        });
        expect((await reader.findLatestExecutionSnapshot(runId))?.id).toBe(birthId);
        // residencyKey exists (this run really is redis-primary).
        expect(await store.readBirthResidency(runId)).toBe("redis-primary");
        expect(residencyKey(runId)).toContain(runId);
      } finally {
        await store.quit();
      }
    }
  );
});
