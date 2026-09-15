// Milestone M9: reads dispatch on each run's DURABLE residency (resolved from the MemoryDB birth key),
// not the constructed dial, so backward-dialing (redis-only -> lower) is lossless; plus HALT semantics.
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
  SnapshotWriteHaltedError,
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

function realResolver(store: RedisSnapshotStore, prisma: PrismaClient) {
  return new SnapshotResidencyResolver({
    store,
    taskRunExists: async (id) => (await prisma.taskRun.count({ where: { id } })) > 0,
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

        // A Postgres row planted for the SAME run: a wrongful fallback would return it.
        const pgOnlyId = generateInternalId();
        await insertPostgresOnlySnapshot(
          prisma,
          env,
          runId,
          pgOnlyId,
          new Date(Date.now() + 5_000)
        );

        // Dial turned DOWN to redis-read and to dual-write: BOTH still read the redis-primary head.
        for (const mode of ["redis-read", "dual-write"] as const) {
          const reader = new TaskRunExecutionSnapshotStore(delegate, {
            store,
            mode,
            logicalRunStoreRoute: ROUTE,
            residencyResolver: realResolver(store, prisma),
          });
          const head = await reader.findLatestExecutionSnapshot(runId);
          expect(head?.id).toBe(transitionId); // the MemoryDB head, never the newer Postgres row
        }

        // Drop the redis-primary snapshot state (marker survives): the read fails closed, NOT to Postgres.
        await store.dropRun(runId);
        expect(await store.readBirthResidency(runId)).toBe("redis-primary");
        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-read",
          logicalRunStoreRoute: ROUTE,
          residencyResolver: realResolver(store, prisma),
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
    "a mirrored run reads MemoryDB-head at redis-read and Postgres at dual-write",
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
          residencyResolver: realResolver(store, prisma),
        });
        expect((await redisReader.findLatestExecutionSnapshot(runId))?.id).toBe(birthId);

        const dualReader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
          residencyResolver: realResolver(store, prisma),
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
          residencyResolver: realResolver(store, prisma),
        });
        // Immutable residency: the redis-only dial does NOT reclassify it. It reads Postgres.
        expect((await reader.findLatestExecutionSnapshot(runId))?.id).toBe(snapshotId);
      } finally {
        await store.quit();
      }
    }
  );
});

describe("TaskRunExecutionSnapshotStore (M9) halt", () => {
  containerTest(
    "a redis-only birth is rejected under halt, nothing half-written, and unhalting restores it",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();

        let halted = true;
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          halted: () => halted,
        });

        await expect(
          writer.createRun({
            data: buildCreateRunData(runId, env),
            snapshot: birthSnapshot(env, birthId),
          })
        ).rejects.toBeInstanceOf(SnapshotWriteHaltedError);

        // No residency change, nothing half-written: no run, no state, no marker, nothing pending.
        expect(await prisma.taskRun.count({ where: { id: runId } })).toBe(0);
        expect(await store.getLatest(runId)).toBeNull();
        expect(await store.readBirthResidency(runId)).toBeUndefined();
        expect(await store.hasPreparedUnit(runId)).toBe(false);

        // Dial back: the birth now succeeds redis-primary.
        halted = false;
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        expect(await store.readBirthResidency(runId)).toBe("redis-primary");
        expect((await store.getLatest(runId))?.id).toBe(birthId);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "an existing redis-primary run's transition is rejected under halt, its state unchanged",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        let halted = false;
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          halted: () => halted,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        halted = true;
        await expect(
          writer.createExecutionSnapshot(transitionInput(env, runId, transitionId, birthId))
        ).rejects.toBeInstanceOf(SnapshotWriteHaltedError);

        // The head is still the birth, nothing pending, residency untouched.
        expect((await store.getLatest(runId))?.id).toBe(birthId);
        expect(await store.hasPreparedUnit(runId)).toBe(false);
        expect(await store.readBirthResidency(runId)).toBe("redis-primary");
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a halted mirrored read prefers the complete Postgres copy over the MemoryDB head",
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
        const pgOnlyId = generateInternalId();
        await insertPostgresOnlySnapshot(
          prisma,
          env,
          runId,
          pgOnlyId,
          new Date(Date.now() + 5_000)
        );

        let halted = false;
        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-read",
          logicalRunStoreRoute: ROUTE,
          residencyResolver: realResolver(store, prisma),
          halted: () => halted,
        });

        // Unhalted redis-read serves the MemoryDB birth head.
        expect((await reader.findLatestExecutionSnapshot(runId))?.id).toBe(birthId);

        // Halted: prefer the complete Postgres copy (the newer row).
        halted = true;
        expect((await reader.findLatestExecutionSnapshot(runId))?.id).toBe(pgOnlyId);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a mirrored (dual-write) birth still proceeds under halt: halt only stops redis-primary writes",
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
          halted: () => true,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        expect(await prisma.taskRun.count({ where: { id: runId } })).toBe(1);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(1);
        expect(await store.readBirthResidency(runId)).toBe("mirrored");
      } finally {
        await store.quit();
      }
    }
  );

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
