// Vertical slice V1: a MIRRORED run's birth + one transition through the durable prepare protocol,
// proven end-to-end against REAL Postgres + REAL Redis (testcontainers, no mocks).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import { preparedUnitKey } from "./snapshotKeys.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

describe("TaskRunExecutionSnapshotStore (dual-write)", () => {
  containerTest(
    "mirrors a birth and a transition: Postgres holds both rows, Redis holds the finalized head, nothing pending",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions);
      const decorator = new TaskRunExecutionSnapshotStore(delegate, {
        store,
        mode: "dual-write",
        logicalRunStoreRoute: "logical:1",
      });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        // Birth.
        await decorator.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: {
            id: birthId,
            createdAt: new Date(),
            engine: "V2",
            executionStatus: "RUN_CREATED",
            description: "Run was created",
            runStatus: "PENDING",
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          },
        });

        // Nothing pending after the birth finalized, and the Redis head is the birth.
        expect(await raw.exists(preparedUnitKey(runId))).toBe(0);
        expect((await store.getLatest(runId))?.id).toBe(birthId);

        // Transition.
        await decorator.createExecutionSnapshot({
          id: transitionId,
          createdAt: new Date(),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING", description: "Run started" },
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });

        // (a) Postgres holds the TaskRun and BOTH TRES rows.
        expect(await prisma.taskRun.count({ where: { id: runId } })).toBe(1);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(2);

        // (b) Redis holds the finalized head; the prepared unit is cleared, not pending.
        expect((await store.getLatest(runId))?.id).toBe(transitionId);
        expect(await raw.exists(preparedUnitKey(runId))).toBe(0);

        // (c) Dual-write reads pass through to Postgres and see the correct head.
        const head = await decorator.findLatestExecutionSnapshot(runId);
        expect(head?.id).toBe(transitionId);

        // (d) The published head equals the last entry: no half-applied unit is ever visible.
        expect((await store.getLatest(runId))?.id).toBe(transitionId);
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );

  containerTest(
    "a throw after prepare rolls the transaction back and aborts the prepared unit",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions);

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();

        // A committed birth via a plain (no-fault) decorator.
        const born = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: "logical:1",
        });
        await born.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: {
            id: birthId,
            createdAt: new Date(),
            engine: "V2",
            executionStatus: "RUN_CREATED",
            description: "Run was created",
            runStatus: "PENDING",
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          },
        });

        // A decorator that throws after the prepare completes, before the commit.
        const faulty = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: "logical:1",
          hooks: {
            afterPrepare: () => {
              throw new Error("__inject_after_prepare__");
            },
          },
        });

        await expect(
          faulty.createExecutionSnapshot({
            id: generateInternalId(),
            createdAt: new Date(),
            run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
            snapshot: { executionStatus: "EXECUTING", description: "Run started" },
            previousSnapshotId: birthId,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          })
        ).rejects.toThrow(/__inject_after_prepare__/);

        // The transaction rolled back: only the birth TRES row persisted.
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(1);
        // The prepared unit was aborted: no pending record remains.
        expect(await raw.exists(preparedUnitKey(runId))).toBe(0);
        // The committed head is still the birth: no partial transition is visible.
        expect((await store.getLatest(runId))?.id).toBe(birthId);
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );
});
