// A redis-primary run's snapshot state ages out after it finishes (the TTL is only armed by a FINISHED
// entry). Once that happens a read is permanently unservable, which callers must be able to tell
// apart from a transient MemoryDB problem: expiry throws the non-retriable SnapshotStateExpiredError
// (still a SnapshotReadUnavailableError), while a MemoryDB error or a quarantined run keeps throwing
// the plain, retriable SnapshotReadUnavailableError. Real Postgres + real Redis, no mocks.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore, type PreparedPgUnit } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  SnapshotReadUnavailableError,
  SnapshotStateExpiredError,
} from "./taskRunExecutionSnapshotStore.js";
import type { SnapshotResidencyResolver } from "./snapshotResidencyResolver.js";
import type { SnapshotRouteWire } from "./snapshotResidency.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  type SnapshotFixtureEnv,
} from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";

// The route a queue message carries for a redis-primary run: the dequeue passes this, not the org id.
function redisPrimaryRoute(env: SnapshotFixtureEnv): SnapshotRouteWire {
  return { version: 1, residency: "redis-primary", organizationId: env.organizationId };
}

// The three route-carried reads: head, by-id point read, and the read-since window.
function routeReads(
  reader: TaskRunExecutionSnapshotStore,
  runId: string,
  snapshotId: string,
  route: SnapshotRouteWire,
  client: Parameters<TaskRunExecutionSnapshotStore["findExecutionSnapshot"]>[1]
) {
  return {
    latest: () => reader.findLatestExecutionSnapshot(runId, undefined, undefined, route),
    byId: () => reader.findExecutionSnapshot({ where: { runId, id: snapshotId } }, client, route),
    window: () =>
      reader.findManyExecutionSnapshots(
        {
          where: { runId, isValid: true, createdAt: { gt: new Date(0) } },
          include: { checkpoint: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        },
        client,
        route
      ),
  };
}

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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the read to reject");
}

function expectExpired(error: unknown, runId: string) {
  expect((error as Error).name).toBe("SnapshotStateExpiredError");
  expect((error as SnapshotReadUnavailableError).retriable).toBe(false);
  expect((error as SnapshotReadUnavailableError).runId).toBe(runId);
  expect(error).toBeInstanceOf(SnapshotReadUnavailableError);
  expect(error).toBeInstanceOf(SnapshotStateExpiredError);
}

function expectRetriableUnavailable(error: unknown) {
  expect(error).toBeInstanceOf(SnapshotReadUnavailableError);
  expect((error as Error).name).toBe("SnapshotReadUnavailableError");
  expect((error as SnapshotReadUnavailableError).retriable).toBe(true);
}

// Births a redis-primary run, finishes it, then drops its MemoryDB state as the post-finish TTL would.
async function finishedAndExpired(
  writer: TaskRunExecutionSnapshotStore,
  store: RedisSnapshotStore,
  env: SnapshotFixtureEnv
) {
  const runId = generateInternalId();
  const birthId = generateInternalId();
  const finishedId = generateInternalId();
  await writer.createRun({
    data: buildCreateRunData(runId, env),
    snapshot: birthSnapshot(env, birthId),
  });
  await writer.createExecutionSnapshot({
    id: finishedId,
    createdAt: new Date(),
    run: { id: runId, status: "COMPLETED_SUCCESSFULLY", attemptNumber: 1 },
    snapshot: { executionStatus: "FINISHED", description: "Run finished" },
    previousSnapshotId: birthId,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  });
  expect((await store.getLatest(runId))?.entry.executionStatus).toBe("FINISHED");
  await store.dropRun(runId);
  expect(await store.getLatest(runId)).toBeNull();
  expect(await store.readBirthResidency(runId)).toBe("redis-primary");
  return { runId, finishedId };
}

describe("TaskRunExecutionSnapshotStore expired redis-primary state", () => {
  containerTest(
    "findLatestExecutionSnapshot throws the non-retriable SnapshotStateExpiredError",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        const { runId } = await finishedAndExpired(writer, store, env);

        const error = await rejection(
          writer.findLatestExecutionSnapshot(runId, undefined, undefined, env.organizationId)
        );
        expectExpired(error, runId);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "findSnapshotCompletedWaitpointIds and findExecutionSnapshot throw SnapshotStateExpiredError",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        const { runId, finishedId } = await finishedAndExpired(writer, store, env);

        expectExpired(
          await rejection(
            writer.findSnapshotCompletedWaitpointIds(finishedId, prisma, runId, env.organizationId)
          ),
          runId
        );
        expectExpired(
          await rejection(
            writer.findExecutionSnapshot(
              { where: { runId, id: finishedId } },
              prisma,
              env.organizationId
            )
          ),
          runId
        );
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a MemoryDB error still throws the plain, retriable SnapshotReadUnavailableError",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const env = await seedSnapshotEnvironment(prisma);
      const writer = new TaskRunExecutionSnapshotStore(delegate, {
        store,
        mode: "redis-only",
        logicalRunStoreRoute: ROUTE,
      });
      const runId = generateInternalId();
      await writer.createRun({
        data: buildCreateRunData(runId, env),
        snapshot: birthSnapshot(env, generateInternalId()),
      });

      // MemoryDB becomes unreachable: residency resolves to error, never expired.
      await store.quit();

      expectRetriableUnavailable(
        await rejection(
          writer.findLatestExecutionSnapshot(runId, undefined, undefined, env.organizationId)
        )
      );
    }
  );

  containerTest(
    "a quarantined run still throws the plain, retriable SnapshotReadUnavailableError",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();

        // A birth held after prepare, before finalize, whose unit is then quarantined.
        const held = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          hooks: {
            beforeFinalize: () => {
              throw new Error("__hold__");
            },
          },
        });
        await expect(
          held.createRun({
            data: buildCreateRunData(runId, env),
            snapshot: birthSnapshot(env, generateInternalId()),
          })
        ).rejects.toThrow(/__hold__/);
        const raw = await store.readPreparedUnitRaw(runId);
        expect(raw).toBeDefined();
        const unit = JSON.parse(raw!) as PreparedPgUnit;
        expect((await store.quarantinePreparedUnit(unit, "redis-primary-null")).moved).toBe(true);
        expect((await store.readPendingState(runId)).quarantined).toBe(true);

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        expectRetriableUnavailable(
          await rejection(
            reader.findLatestExecutionSnapshot(runId, undefined, undefined, env.organizationId)
          )
        );
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "route-carried reads of an expired run throw SnapshotStateExpiredError, not the retriable miss",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        const { runId, finishedId } = await finishedAndExpired(writer, store, env);
        const reads = routeReads(writer, runId, finishedId, redisPrimaryRoute(env), prisma);

        expectExpired(await rejection(reads.latest()), runId);
        expectExpired(await rejection(reads.byId()), runId);
        expectExpired(await rejection(reads.window()), runId);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "route-carried reads of a run whose state is present still succeed",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        const runId = generateInternalId();
        const birthId = generateInternalId();
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        const reads = routeReads(writer, runId, birthId, redisPrimaryRoute(env), prisma);

        expect((await reads.latest()).id).toBe(birthId);
        expect((await reads.byId())?.id).toBe(birthId);
        expect((await reads.window()).map((s) => s.id)).toEqual([birthId]);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "route-carried reads with MemoryDB unreachable still throw the plain, retriable error",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const env = await seedSnapshotEnvironment(prisma);
      const writer = new TaskRunExecutionSnapshotStore(delegate, {
        store,
        mode: "redis-only",
        logicalRunStoreRoute: ROUTE,
      });
      const runId = generateInternalId();
      const birthId = generateInternalId();
      await writer.createRun({
        data: buildCreateRunData(runId, env),
        snapshot: birthSnapshot(env, birthId),
      });
      const reads = routeReads(writer, runId, birthId, redisPrimaryRoute(env), prisma);

      await store.quit();

      expectRetriableUnavailable(await rejection(reads.latest()));
      expectRetriableUnavailable(await rejection(reads.byId()));
      expectRetriableUnavailable(await rejection(reads.window()));
    }
  );

  containerTest(
    "a route-carried miss whose residency cannot be resolved keeps the retriable miss",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        const { runId, finishedId } = await finishedAndExpired(writer, store, env);

        // The state is gone, but the residency read fails: expiry is not proven, so stay retriable.
        const unresolved = {
          resolve: async () => ({ kind: "error" as const }),
        } as unknown as SnapshotResidencyResolver;
        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          residencyResolver: unresolved,
        });
        const reads = routeReads(reader, runId, finishedId, redisPrimaryRoute(env), prisma);

        const latest = await rejection(reads.latest());
        expectRetriableUnavailable(latest);
        expect((latest as Error).message).toMatch(/redis-primary head missing/);
        const byId = await rejection(reads.byId());
        expectRetriableUnavailable(byId);
        expect((byId as Error).message).toMatch(/redis-primary snapshot missing/);
        const window = await rejection(reads.window());
        expectRetriableUnavailable(window);
        expect((window as Error).message).toMatch(/redis-primary window missing/);
      } finally {
        await store.quit();
      }
    }
  );
});
