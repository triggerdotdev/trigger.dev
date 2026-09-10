// Finding 82-1: the one-run-per-unit guard must hold for POSTGRES residency too. `#residencyFor`
// caches the transaction's residency on the FIRST snapshot write, so once a bound-run write resolves
// to `postgres`, a later FOREIGN-run write in the same transaction reused that cached `postgres` and
// took the inert early-return path BEFORE `#assertBoundRun` ran — silently writing another run's
// snapshot into the bound transaction. The fix asserts the actual run id BEFORE residency resolution.
// Proven end-to-end against REAL Postgres + REAL Redis (testcontainers, no mocks).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

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

// A never-enrolled org (resolveDial -> undefined): every write resolves to `postgres` residency with
// no MemoryDB read, exercising the inert early-return path the caching bug lived on.
function postgresWriter(delegate: PostgresRunStore, store: RedisSnapshotStore) {
  return new TaskRunExecutionSnapshotStore(delegate, {
    store,
    mode: "dual-write",
    resolveDial: () => undefined,
    logicalRunStoreRoute: "logical:1",
  });
}

describe("TaskRunExecutionSnapshotStore (item 6) foreign-run guard under postgres residency", () => {
  containerTest(
    "a foreign-run write reusing the transaction's cached postgres residency is rejected before the Postgres mutation",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);

        const boundRunId = generateInternalId();
        const boundBirthId = generateInternalId();
        const boundTransitionId = generateInternalId();

        const foreignRunId = generateInternalId();
        const foreignBirthId = generateInternalId();
        const foreignTransitionId = generateInternalId();

        const w = postgresWriter(delegate, store);

        // Both runs exist as real Postgres rows, so a leaked foreign write would SUCCEED (no FK error to
        // mask the bug): the only thing that can stop it is the one-run guard.
        await w.createRun({
          data: buildCreateRunData(boundRunId, env),
          snapshot: birthSnapshot(env, boundBirthId),
        });
        await w.createRun({
          data: buildCreateRunData(foreignRunId, env),
          snapshot: birthSnapshot(env, foreignBirthId),
        });

        await expect(
          w.runInTransaction(boundRunId, async (txStore) => {
            // First write is the bound run: it resolves + CACHES `postgres` residency for the unit.
            await txStore.createExecutionSnapshot(
              transitionInput(env, boundRunId, boundTransitionId, boundBirthId)
            );
            // Second write names a DIFFERENT run. With the cached `postgres` residency it must still be
            // rejected — one prepared unit is exactly one run.
            await txStore.createExecutionSnapshot(
              transitionInput(env, foreignRunId, foreignTransitionId, foreignBirthId)
            );
          })
        ).rejects.toThrow(/exactly one run/);

        // The rejected transaction rolled back: neither the bound nor the foreign transition persisted.
        expect(await tresCount(prisma, foreignTransitionId)).toBe(0);
        expect(await tresCount(prisma, boundTransitionId)).toBe(0);
      } finally {
        await store.quit();
      }
    }
  );
});
