// Item 6 protocol guards: the prepared entries carry the fork guard (expectedCur), and one prepared
// unit is exactly one run. A stale head, a broken multi-entry chain, and a concurrent transition are
// all rejected with the Postgres write rolled back; a cross-run write inside a bound transaction throws.
// Proven end-to-end against REAL Postgres + REAL Redis (testcontainers, no mocks).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
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

function tresCount(
  prisma: Parameters<typeof seedSnapshotEnvironment>[0],
  id: string
): Promise<number> {
  return prisma.taskRunExecutionSnapshot.count({ where: { id } });
}

function writer(delegate: PostgresRunStore, store: RedisSnapshotStore) {
  return new TaskRunExecutionSnapshotStore(delegate, {
    store,
    mode: "dual-write",
    resolveDial: () => "dual-write",
    logicalRunStoreRoute: ROUTE,
  });
}

describe("TaskRunExecutionSnapshotStore (item 6) fork guard + one-run unit", () => {
  containerTest(
    "a transition asserting a STALE previous head is rejected (forkGuard) and its Postgres row rolls back",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const t1 = generateInternalId();
        const stale = generateInternalId();
        const w = writer(delegate, store);

        await w.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await w.createExecutionSnapshot(transitionInput(env, runId, t1, birthId));
        expect((await store.getLatest(runId))?.id).toBe(t1);

        // The head is now t1, but this transition still asserts previous = birthId: fork.
        await expect(
          w.createExecutionSnapshot(transitionInput(env, runId, stale, birthId))
        ).rejects.toThrow();
        expect(await tresCount(prisma, stale)).toBe(0); // rolled back
        expect((await store.getLatest(runId))?.id).toBe(t1); // head unchanged
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a multi-entry transaction with a BROKEN chain is rejected and both Postgres rows roll back",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const a = generateInternalId();
        const b = generateInternalId();
        const w = writer(delegate, store);

        await w.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        // Second entry asserts previous = birthId, but its predecessor in the unit staged head `a`: chain break.
        await expect(
          w.runInTransaction(runId, async (txStore) => {
            await txStore.createExecutionSnapshot(transitionInput(env, runId, a, birthId));
            await txStore.createExecutionSnapshot(transitionInput(env, runId, b, birthId));
          })
        ).rejects.toThrow();
        expect(await tresCount(prisma, a)).toBe(0);
        expect(await tresCount(prisma, b)).toBe(0);
        expect((await store.getLatest(runId))?.id).toBe(birthId); // head still the birth
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "two CONCURRENT transitions from the same head: exactly one commits, the other is rejected",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const x = generateInternalId();
        const y = generateInternalId();
        const w = writer(delegate, store);

        await w.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        const results = await Promise.allSettled([
          w.createExecutionSnapshot(transitionInput(env, runId, x, birthId)),
          w.createExecutionSnapshot(transitionInput(env, runId, y, birthId)),
        ]);
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const head = (await store.getLatest(runId))?.id;
        expect([x, y]).toContain(head);
        const loser = head === x ? y : x;
        expect(await tresCount(prisma, loser)).toBe(0); // the rejected transition rolled back
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a write for a DIFFERENT run inside a bound transaction is rejected before the Postgres mutation",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const other = generateInternalId();
        const birthId = generateInternalId();
        const foreign = generateInternalId();
        const w = writer(delegate, store);

        await w.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        await expect(
          w.runInTransaction(runId, async (txStore) => {
            // Bound to `runId`, but this snapshot names `other`: one unit is exactly one run.
            await txStore.createExecutionSnapshot(transitionInput(env, other, foreign, birthId));
          })
        ).rejects.toThrow(/exactly one run/);
        expect(await tresCount(prisma, foreign)).toBe(0);
      } finally {
        await store.quit();
      }
    }
  );
});
