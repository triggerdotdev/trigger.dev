// T6.1: the decorator overrides runInTransaction so snapshot writes the ENGINE performs inside its OWN
// transaction are mirrored as ONE transaction-sized PreparedPgUnit (ordered entries, one run). Without
// this, in-transaction transitions bypass the mirror and a mirrored run's MemoryDB head diverges.
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

describe("TaskRunExecutionSnapshotStore (T6.1) runInTransaction orchestration", () => {
  containerTest(
    "TWO transitions written in ONE engine runInTransaction both mirror as one unit; the MemoryDB head advances to the last",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const t1 = generateInternalId();
        const t2 = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => "dual-write",
          logicalRunStoreRoute: ROUTE,
        });

        // Birth (mirrored).
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        expect(await store.readBirthResidency(runId)).toBe("mirrored");

        // The engine writes TWO transitions inside ONE runInTransaction (its own tx). Both must mirror.
        await writer.runInTransaction(runId, async (txStore) => {
          await txStore.createExecutionSnapshot(transitionInput(env, runId, t1, birthId));
          await txStore.createExecutionSnapshot(transitionInput(env, runId, t2, t1));
        });

        // Both landed in Postgres (mirrored) AND the MemoryDB head advanced to the LAST transition.
        expect(await tresCount(prisma, t1)).toBe(1);
        expect(await tresCount(prisma, t2)).toBe(1);
        expect((await store.getLatest(runId))?.id).toBe(t2);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a runInTransaction with NO snapshot writes commits normally and mirrors nothing",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => "dual-write",
          logicalRunStoreRoute: ROUTE,
        });

        const value = await writer.runInTransaction(runId, async (txStore) => {
          // A non-snapshot read inside the tx; no snapshot entries are produced.
          await txStore.findRun({ id: runId });
          return 42;
        });
        expect(value).toBe(42);
        expect(await store.getLatest(runId)).toBeNull();
      } finally {
        await store.quit();
      }
    }
  );
});
