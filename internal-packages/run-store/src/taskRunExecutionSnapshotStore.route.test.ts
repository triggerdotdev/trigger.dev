// Item 2: a versioned SnapshotRoute, stamped on the queue message from a run's BIRTH residency, lets a
// POLL-LAGGING consumer honor the run's true residency. Without it, a transition whose org dial reads
// `undefined` (a fresh pod that has not yet observed enrollment) diverts to Postgres and strands the
// resident run's MemoryDB head. Proven end-to-end against REAL Postgres + REAL Redis (no mocks).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  SnapshotWriteUnavailableError,
} from "./taskRunExecutionSnapshotStore.js";
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

function realResolver(store: RedisSnapshotStore, prisma: PrismaClient) {
  return new SnapshotResidencyResolver({
    store,
    taskRunExists: async (id) => (await prisma.taskRun.count({ where: { id } })) > 0,
  });
}

function tresCount(prisma: PrismaClient, id: string): Promise<number> {
  return prisma.taskRunExecutionSnapshot.count({ where: { id } });
}

describe("TaskRunExecutionSnapshotStore snapshot-route propagation", () => {
  containerTest(
    "poll lag (resolveDial -> undefined): a valid mirrored route mirrors the transition; WITHOUT it the same dial diverts to Postgres and strands the head",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const route: SnapshotRouteWire = {
          version: 1,
          residency: "mirrored",
          organizationId: env.organizationId,
        };

        // Both runs are born mirrored while the org dial is dual-write.
        const birthWriter = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => "dual-write",
          logicalRunStoreRoute: ROUTE,
        });

        // A fresh pod whose dial poll has NOT yet observed enrollment: resolveDial returns undefined.
        const lagging = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => undefined,
          residencyResolver: realResolver(store, prisma),
          logicalRunStoreRoute: ROUTE,
        });

        // WITH the route: the lagging consumer honors the run's true residency -> mirrors.
        const withRun = generateInternalId();
        const withBirth = generateInternalId();
        const withTransition = generateInternalId();
        await birthWriter.createRun({
          data: buildCreateRunData(withRun, env),
          snapshot: birthSnapshot(env, withBirth),
        });
        expect(await store.readBirthResidency(withRun)).toBe("mirrored");
        await lagging.createExecutionSnapshot(
          transitionInput(env, withRun, withTransition, withBirth, route)
        );
        expect(await tresCount(prisma, withTransition)).toBe(1); // mirrored => Postgres row written
        expect((await store.getLatest(withRun))?.id).toBe(withTransition); // head advanced

        // WITHOUT the route: the same undefined dial takes the inert postgres shortcut and strands
        // the MemoryDB head at birth. This is the divergence the route exists to prevent.
        const noRun = generateInternalId();
        const noBirth = generateInternalId();
        const noTransition = generateInternalId();
        await birthWriter.createRun({
          data: buildCreateRunData(noRun, env),
          snapshot: birthSnapshot(env, noBirth),
        });
        await lagging.createExecutionSnapshot(transitionInput(env, noRun, noTransition, noBirth));
        expect(await tresCount(prisma, noTransition)).toBe(1); // straight-through Postgres row
        expect((await store.getLatest(noRun))?.id).toBe(noBirth); // head STRANDED at birth
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a valid redis route on a run with no durable birth state FAILS CLOSED, never diverts to Postgres",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        // Born postgres-only (never enrolled): no MemoryDB birth key.
        const inert = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => undefined,
          logicalRunStoreRoute: ROUTE,
        });
        await inert.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        expect(await store.readBirthResidency(runId)).toBeUndefined();

        const lagging = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => undefined,
          residencyResolver: realResolver(store, prisma),
          logicalRunStoreRoute: ROUTE,
        });
        const redisRoute: SnapshotRouteWire = {
          version: 1,
          residency: "redis-primary",
          organizationId: env.organizationId,
        };
        await expect(
          lagging.createExecutionSnapshot(
            transitionInput(env, runId, transitionId, birthId, redisRoute)
          )
        ).rejects.toBeInstanceOf(SnapshotWriteUnavailableError);
        expect(await tresCount(prisma, transitionId)).toBe(0);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a MALFORMED route field (unparseable version) + resolveDial undefined resolves via the durable resolver (mirrored), never the postgres shortcut",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

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

        const lagging = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => undefined,
          residencyResolver: realResolver(store, prisma),
          logicalRunStoreRoute: ROUTE,
        });
        // A version this build does not understand: present (so never shortcut) but unparseable.
        const malformed = { version: 2, residency: "mirrored", organizationId: env.organizationId };
        await lagging.createExecutionSnapshot(
          transitionInput(
            env,
            runId,
            transitionId,
            birthId,
            malformed as unknown as SnapshotRouteWire
          )
        );
        expect(await tresCount(prisma, transitionId)).toBe(1); // mirrored via the resolver
        expect((await store.getLatest(runId))?.id).toBe(transitionId); // head advanced, not postgres
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "cold pod (resolveDial -> undefined, registry not yet polled) honors a valid redis-primary route",
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

        const cold = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => undefined,
          residencyResolver: realResolver(store, prisma),
          logicalRunStoreRoute: ROUTE,
        });
        const route: SnapshotRouteWire = {
          version: 1,
          residency: "redis-primary",
          organizationId: env.organizationId,
        };
        await cold.createExecutionSnapshot(
          transitionInput(env, runId, transitionId, birthId, route)
        );
        expect(await tresCount(prisma, transitionId)).toBe(0); // redis-primary => no Postgres row
        expect((await store.getLatest(runId))?.id).toBe(transitionId); // MemoryDB head advanced
      } finally {
        await store.quit();
      }
    }
  );
});
