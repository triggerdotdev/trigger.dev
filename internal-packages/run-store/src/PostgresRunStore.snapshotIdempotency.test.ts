// Re-applying the same caller-supplied snapshot id (as a connection-blip retry does) must be a
// no-op: one row, existing snapshot returned, links single. Without a supplied id each call is a
// distinct snapshot, so idempotency is opt-in via a stable id, never global.
import { describe, expect } from "vitest";
import { postgresTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import {
  seedSnapshotWaitpoints,
  setupSnapshotIdFixture,
} from "./testFixtures/snapshotIdFixture.js";

describe("PostgresRunStore execution-snapshot idempotency", () => {
  postgresTest(
    "re-applying the same supplied id returns the existing row, not a duplicate",
    async ({ prisma }) => {
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const { run, env } = await setupSnapshotIdFixture(prisma);
      const id = generateInternalId();

      const input = {
        id,
        run: { id: run.id, status: "EXECUTING" as const, attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING" as const, description: "Run started" },
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      };

      const first = await store.createExecutionSnapshot(input);
      const second = await store.createExecutionSnapshot(input);

      expect(first.id).toBe(id);
      expect(second.id).toBe(id);

      const count = await prisma.taskRunExecutionSnapshot.count({ where: { id } });
      expect(count).toBe(1);
    }
  );

  postgresTest("a replay keeps the completed-waitpoint links single", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma);
    const [waitpointId] = await seedSnapshotWaitpoints(prisma, env, 1);
    const id = generateInternalId();

    const input = {
      id,
      run: { id: run.id, status: "EXECUTING" as const, attemptNumber: 1 },
      snapshot: { executionStatus: "EXECUTING" as const, description: "Run continued" },
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
      completedWaitpoints: [{ id: waitpointId }],
    };

    await store.createExecutionSnapshot(input);
    await store.createExecutionSnapshot(input);

    const links = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "_completedWaitpoints" WHERE "A" = ${id}`;
    expect(Number(links[0]!.count)).toBe(1);
  });

  postgresTest(
    "without a supplied id, each call is a distinct snapshot (idempotency is opt-in)",
    async ({ prisma }) => {
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const { run, env } = await setupSnapshotIdFixture(prisma);

      const input = {
        run: { id: run.id, status: "EXECUTING" as const, attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING" as const, description: "Run started" },
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      };

      const a = await store.createExecutionSnapshot(input);
      const b = await store.createExecutionSnapshot(input);

      expect(a.id).not.toBe(b.id);
      const count = await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } });
      expect(count).toBe(2);
    }
  );

  postgresTest(
    "returns the hydrated checkpoint when a checkpointId is supplied",
    async ({ prisma }) => {
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const { run, env } = await setupSnapshotIdFixture(prisma);
      const checkpoint = await prisma.taskRunCheckpoint.create({
        data: {
          friendlyId: `checkpoint_${generateInternalId()}`,
          type: "DOCKER",
          location: "s3://bucket/key",
          projectId: env.projectId,
          runtimeEnvironmentId: env.id,
        },
      });
      const id = generateInternalId();

      const result = await store.createExecutionSnapshot({
        id,
        run: { id: run.id, status: "EXECUTING" as const, attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING" as const, description: "Checkpointed" },
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
        checkpointId: checkpoint.id,
      });

      expect(result.checkpointId).toBe(checkpoint.id);
      expect(result.checkpoint?.id).toBe(checkpoint.id);
    }
  );

  postgresTest(
    "two concurrent calls with the same id both resolve (no P2002) and leave exactly one snapshot",
    async ({ prisma }) => {
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const { run, env } = await setupSnapshotIdFixture(prisma);
      const id = generateInternalId();

      const input = {
        id,
        run: { id: run.id, status: "EXECUTING" as const, attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING" as const, description: "Concurrent" },
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      };

      // Both must resolve: the conflict-ignoring insert makes the second call a no-op at the database,
      // so neither races into a P2002 unique violation. Exactly one row lands.
      const [a, b] = await Promise.all([
        store.createExecutionSnapshot(input),
        store.createExecutionSnapshot(input),
      ]);

      expect(a.id).toBe(id);
      expect(b.id).toBe(id);
      expect(await prisma.taskRunExecutionSnapshot.count({ where: { id } })).toBe(1);
    }
  );

  postgresTest(
    "concurrent same-id calls do not duplicate completed-waitpoint links",
    async ({ prisma }) => {
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const { run, env } = await setupSnapshotIdFixture(prisma);
      const [wpA, wpB] = await seedSnapshotWaitpoints(prisma, env, 2);
      const id = generateInternalId();

      const input = {
        id,
        run: { id: run.id, status: "EXECUTING" as const, attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING" as const, description: "Concurrent links" },
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
        completedWaitpoints: [{ id: wpA }, { id: wpB }],
      };

      await Promise.all([
        store.createExecutionSnapshot(input),
        store.createExecutionSnapshot(input),
      ]);

      const links = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM "_completedWaitpoints" WHERE "A" = ${id}`;
      expect(Number(links[0]!.count)).toBe(2);
      expect(await prisma.taskRunExecutionSnapshot.count({ where: { id } })).toBe(1);
    }
  );

  postgresTest(
    "a caller-supplied transaction owns the write (rolls back with the caller tx, no separate retry)",
    async ({ prisma }) => {
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const { run, env } = await setupSnapshotIdFixture(prisma);
      const id = generateInternalId();

      const input = {
        id,
        run: { id: run.id, status: "EXECUTING" as const, attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING" as const, description: "Caller tx" },
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      };

      // The store must write inside the caller's transaction (never open its own or retry it): the row
      // is visible within the tx, and rolling the caller tx back removes it. This is the retry-protection
      // boundary from #maybeInfraRetry, observed on the snapshot write.
      await expect(
        prisma.$transaction(async (tx) => {
          await store.createExecutionSnapshot(input, tx);
          expect(await tx.taskRunExecutionSnapshot.count({ where: { id } })).toBe(1);
          throw new Error("rollback");
        })
      ).rejects.toThrow("rollback");

      expect(await prisma.taskRunExecutionSnapshot.count({ where: { id } })).toBe(0);
    }
  );
});
