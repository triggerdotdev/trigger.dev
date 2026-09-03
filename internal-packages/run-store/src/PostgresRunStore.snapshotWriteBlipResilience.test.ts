// The snapshot write must survive a connection blip on the pg driver adapter (the prod runtime):
// the pool discards the dead connection and reissues on a fresh one. The supplied id keeps any
// replay a no-op, so exactly one row lands. Idempotency under replay is proven directly in
// PostgresRunStore.snapshotIdempotency.test.ts; the retry loop and classifier in the database
// package's unit tests.
import { postgresBlipTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { setupSnapshotIdFixture } from "./testFixtures/snapshotIdFixture.js";

const infraRetry = {
  options: { enabled: true, maxAttempts: 12, backoffMinMs: 20, backoffMaxMs: 120 },
};

function snapshotInput(
  runId: string,
  env: { id: string; type: "DEVELOPMENT"; projectId: string; organizationId: string },
  id: string
) {
  return {
    id,
    run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING" as const, description: "Run continued after blip" },
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

postgresBlipTest(
  "createExecutionSnapshot recovers from a connection blip when infra-retry is enabled",
  { timeout: 60_000 },
  async ({ prisma, blip }) => {
    const client = prisma as PrismaClient;
    const { run, env } = await setupSnapshotIdFixture(client);
    const id = generateInternalId();

    const store = new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: prisma as never,
      infraRetry,
    });

    await store.findRun({ id: run.id }, prisma as never); // warm the pool
    await blip.severIdle();

    const created = await store.createExecutionSnapshot(snapshotInput(run.id, env, id));
    expect(created.id).toBe(id);

    const count = await client.taskRunExecutionSnapshot.count({ where: { id } });
    expect(count).toBe(1);
  }
);

postgresBlipTest(
  "createExecutionSnapshot survives an idle blip even without infra-retry (adapter pool reconnects)",
  { timeout: 60_000 },
  async ({ prisma, blip }) => {
    const client = prisma as PrismaClient;
    const { run, env } = await setupSnapshotIdFixture(client);
    const id = generateInternalId();

    const store = new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: prisma as never,
    });

    await store.findRun({ id: run.id }, prisma as never); // warm the pool
    await blip.severIdle();

    const created = await store.createExecutionSnapshot(snapshotInput(run.id, env, id));
    expect(created.id).toBe(id);
    expect(await client.taskRunExecutionSnapshot.count({ where: { id } })).toBe(1);
  }
);
