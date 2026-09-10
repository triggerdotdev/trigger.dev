// Performance / inactive-path invariants, proven against REAL Postgres + REAL Redis (no infra mocks):
//   Inv 1: a never-enrolled org (resolveDial -> undefined, no route) never consults the residency
//          resolver on birth OR transition — the inert Postgres passthrough. (See also
//          taskRunExecutionSnapshotStore.dialResidency.test.ts "never-enrolled ... inert".)
//   Inv 3: a transition carrying a VALID mirrored route resolves residency from MemoryDB and performs
//          ZERO Postgres `taskRunExists` lookups.
// The injected resolver / taskRunExists are counted with spy CLOSURES; the databases themselves are real.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import { SnapshotResidencyResolver } from "./snapshotResidencyResolver.js";
import type { SnapshotRouteWire } from "./snapshotResidency.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";
type Env = Awaited<ReturnType<typeof seedSnapshotEnvironment>>;

function birthSnapshot(env: Env, id: string) {
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
  env: Env,
  runId: string,
  id: string,
  previousSnapshotId: string,
  snapshotRoute?: SnapshotRouteWire
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
    snapshotRoute,
  };
}

function tresCount(prisma: PrismaClient, id: string): Promise<number> {
  return prisma.taskRunExecutionSnapshot.count({ where: { id } });
}

// Counts every resolve() so an inert path can be proven to never consult the resolver at all.
class CountingResolver extends SnapshotResidencyResolver {
  resolveCalls = 0;
  override resolve(runId: string) {
    this.resolveCalls++;
    return super.resolve(runId);
  }
}

describe("TaskRunExecutionSnapshotStore inactive-path performance invariants", () => {
  containerTest(
    "Inv 1: a never-enrolled org's birth and transition NEVER consult the residency resolver (inert passthrough)",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        const resolver = new CountingResolver({
          store,
          taskRunExists: async (id) => (await prisma.taskRun.count({ where: { id } })) > 0,
        });
        const inert = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => undefined,
          residencyResolver: resolver,
          logicalRunStoreRoute: ROUTE,
        });

        await inert.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await inert.createExecutionSnapshot(transitionInput(env, runId, transitionId, birthId));

        // Both rows landed in Postgres, no MemoryDB birth key, and the resolver was never consulted.
        expect(await tresCount(prisma, birthId)).toBe(1);
        expect(await tresCount(prisma, transitionId)).toBe(1);
        expect(await store.readBirthResidency(runId)).toBeUndefined();
        expect(resolver.resolveCalls).toBe(0);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "Inv 3: a carried mirrored route resolves from MemoryDB and performs ZERO Postgres taskRunExists lookups",
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

        // taskRunExists is a Postgres existence read; a committed-run resolution must never reach it.
        let taskRunExistsCalls = 0;
        const resolver = new SnapshotResidencyResolver({
          store,
          taskRunExists: async (id) => {
            taskRunExistsCalls++;
            return (await prisma.taskRun.count({ where: { id } })) > 0;
          },
        });

        // A lagging pod (resolveDial -> undefined) that honors the carried route rather than shortcutting.
        const routed = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => undefined,
          residencyResolver: resolver,
          logicalRunStoreRoute: ROUTE,
        });
        const route: SnapshotRouteWire = {
          version: 1,
          residency: "mirrored",
          organizationId: env.organizationId,
        };
        await routed.createExecutionSnapshot(
          transitionInput(env, runId, transitionId, birthId, route)
        );

        expect(await tresCount(prisma, transitionId)).toBe(1); // mirrored => Postgres row written
        expect((await store.getLatest(runId))?.id).toBe(transitionId); // head advanced
        expect(taskRunExistsCalls).toBe(0); // residency came from MemoryDB; no Postgres existence lookup
      } finally {
        await store.quit();
      }
    }
  );
});
