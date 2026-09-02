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
});
