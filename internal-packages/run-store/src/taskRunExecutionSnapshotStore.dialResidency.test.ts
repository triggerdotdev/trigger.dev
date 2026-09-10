// W1: writes resolve residency PER RUN on a shared store. A birth follows the org's CURRENT dial; a
// transition follows the RUN's IMMUTABLE durable residency (never the live dial), so a lowered dial
// drains a resident run rather than freezing its head. A never-enrolled org (resolveDial -> undefined)
// stays genuinely inert: plain Postgres passthrough, no MemoryDB touch, caller transaction honored.
// Proven end-to-end against REAL Postgres + REAL Redis (testcontainers, no mocks).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  SnapshotWriteUnavailableError,
  type SnapshotStoreDial,
} from "./taskRunExecutionSnapshotStore.js";
import { SnapshotResidencyResolver } from "./snapshotResidencyResolver.js";
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

function realResolver(store: RedisSnapshotStore, prisma: PrismaClient) {
  return new SnapshotResidencyResolver({
    store,
    taskRunExists: async (id) => (await prisma.taskRun.count({ where: { id } })) > 0,
  });
}

function tresCount(prisma: PrismaClient, id: string): Promise<number> {
  return prisma.taskRunExecutionSnapshot.count({ where: { id } });
}

describe("TaskRunExecutionSnapshotStore (W1) per-run write residency", () => {
  containerTest(
    "a never-enrolled org (resolveDial -> undefined) is inert: birth and transition pass straight through to Postgres, no MemoryDB birth key",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        // A resolver whose store would surface any MemoryDB read; an inert transition must never call it.
        let resolverCalls = 0;
        const countingResolver = new SnapshotResidencyResolver({
          store,
          taskRunExists: async (id) => {
            resolverCalls++;
            return (await prisma.taskRun.count({ where: { id } })) > 0;
          },
        });

        const inert = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => undefined,
          residencyResolver: countingResolver,
          logicalRunStoreRoute: ROUTE,
        });

        await inert.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await inert.createExecutionSnapshot(transitionInput(env, runId, transitionId, birthId));

        // Both snapshots landed in Postgres exactly as the undecorated store would write them.
        expect(await tresCount(prisma, birthId)).toBe(1);
        expect(await tresCount(prisma, transitionId)).toBe(1);
        // No MemoryDB home was created, and no residency resolve was needed.
        expect(await store.readBirthResidency(runId)).toBeUndefined();
        expect(await store.getLatest(runId)).toBeNull();
        expect(resolverCalls).toBe(0);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a redis-primary run's TRANSITION at a LOWERED dial stays redis-primary: no TRES row, MemoryDB head advances",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        // Born redis-primary while the org dial is redis-only.
        const birthWriter = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          resolveDial: () => "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        await birthWriter.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        expect(await store.readBirthResidency(runId)).toBe("redis-primary");

        // The org dial is turned DOWN to dual-write. A transition must honor the RUN's residency, not
        // the live dial: redis-primary, so still NO TRES row, and the MemoryDB head advances.
        const loweredWriter = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => "dual-write",
          residencyResolver: realResolver(store, prisma),
          logicalRunStoreRoute: ROUTE,
        });
        await loweredWriter.createExecutionSnapshot(
          transitionInput(env, runId, transitionId, birthId)
        );

        expect(await tresCount(prisma, transitionId)).toBe(0); // redis-primary => no Postgres row
        expect((await store.getLatest(runId))?.id).toBe(transitionId); // MemoryDB head advanced
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a mirrored run keeps mirroring after the org dials to off (drain, not freeze): transition writes a TRES row and advances the MemoryDB head",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        // Born mirrored at dual-write.
        const birthWriter = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => "dual-write",
          logicalRunStoreRoute: ROUTE,
        });
        await birthWriter.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        expect(await store.readBirthResidency(runId)).toBe("mirrored");

        // The org dials to OFF (enrolled, drained). The resident mirrored run keeps mirroring: its
        // transition writes both the Postgres TRES row AND advances the MemoryDB head.
        const offWriter = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => "off",
          residencyResolver: realResolver(store, prisma),
          logicalRunStoreRoute: ROUTE,
        });
        await offWriter.createExecutionSnapshot(transitionInput(env, runId, transitionId, birthId));

        expect(await tresCount(prisma, transitionId)).toBe(1); // mirrored => Postgres row written
        expect((await store.getLatest(runId))?.id).toBe(transitionId); // MemoryDB head advanced too
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a BIRTH follows the org's live dial: off is inert postgres, redis-only is redis-primary",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);

        const cases: Array<{
          dial: SnapshotStoreDial;
          residency: string | undefined;
          tres: number;
        }> = [
          { dial: "off", residency: undefined, tres: 1 }, // inert: postgres row, no birth key
          { dial: "redis-only", residency: "redis-primary", tres: 0 }, // redis-primary: no TRES row
        ];

        for (const c of cases) {
          const runId = generateInternalId();
          const birthId = generateInternalId();
          const writer = new TaskRunExecutionSnapshotStore(delegate, {
            store,
            mode: "redis-only",
            resolveDial: () => c.dial,
            logicalRunStoreRoute: ROUTE,
          });
          await writer.createRun({
            data: buildCreateRunData(runId, env),
            snapshot: birthSnapshot(env, birthId),
          });
          expect(await store.readBirthResidency(runId)).toBe(c.residency);
          expect(await tresCount(prisma, birthId)).toBe(c.tres);
        }
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a transition whose durable residency is unresolvable (redis-primary state aged out, marker survives) FAILS CLOSED, never diverts to Postgres",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          resolveDial: () => "redis-only",
          residencyResolver: realResolver(store, prisma),
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        // Drop the redis-primary state but leave the residency marker (the 14-day-TTL expiry shape):
        // the resolver now returns `expired`, which names no writable residency.
        await store.dropRun(runId);
        expect(await store.readBirthResidency(runId)).toBe("redis-primary");

        // The transition must THROW rather than guess a residency: guessing postgres would divert a
        // redis-primary run's transition to a Postgres row that reads never consult -> divergence.
        await expect(
          writer.createExecutionSnapshot(transitionInput(env, runId, transitionId, birthId))
        ).rejects.toBeInstanceOf(SnapshotWriteUnavailableError);
        // Nothing was written to Postgres for the transition.
        expect(await tresCount(prisma, transitionId)).toBe(0);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a bare PrismaClient passed as a routing hint is accepted and still mirrors; an OPEN interactive transaction is rejected",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => "dual-write",
          logicalRunStoreRoute: ROUTE,
        });

        // The run engine forwards a bare PrismaClient so the routing delegate can pick the owning DB by
        // id. That is a routing hint, not an open transaction: the write is accepted and still mirrors.
        const runId = generateInternalId();
        const birthId = generateInternalId();
        await writer.createRun(
          { data: buildCreateRunData(runId, env), snapshot: birthSnapshot(env, birthId) },
          prisma
        );
        expect(await store.readBirthResidency(runId)).toBe("mirrored");
        expect(await tresCount(prisma, birthId)).toBe(1);

        // An OPEN interactive transaction cannot own the prepare protocol's commit boundary: rejected.
        const runId2 = generateInternalId();
        const birthId2 = generateInternalId();
        await expect(
          prisma.$transaction((txClient) =>
            writer.createRun(
              { data: buildCreateRunData(runId2, env), snapshot: birthSnapshot(env, birthId2) },
              txClient
            )
          )
        ).rejects.toThrow(/cannot mirror a write inside a caller-supplied transaction/);
      } finally {
        await store.quit();
      }
    }
  );
});
