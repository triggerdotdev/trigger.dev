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

postgresBlipTest(
  "createExecutionSnapshot recovers from a mid-statement blip (retry + idempotency)",
  { timeout: 120_000 },
  async ({ prisma, blip }) => {
    const client = prisma as PrismaClient;
    const { run, env } = await setupSnapshotIdFixture(client);

    let totalRetries = 0;
    const store = new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: prisma as never,
      infraRetry: {
        options: { enabled: true, maxAttempts: 15, backoffMinMs: 10, backoffMaxMs: 60 },
        onRetry: () => {
          totalRetries++;
        },
      },
    });

    await store.findRun({ id: run.id }, prisma as never); // warm the pool

    // Kill the snapshot statement mid-flight (the adapter cannot absorb this transparently, unlike an
    // idle drop), and loop until at least one iteration actually catches a blip. Every op must still
    // succeed with exactly one row: the classifier recognises the adapter's connection-loss error, the
    // retry reissues the transaction, and the stable id keeps a committed-but-lost attempt a no-op.
    let caught = 0;
    for (let i = 0; i < 12 && caught < 1; i++) {
      const id = generateInternalId();
      const before = totalRetries;

      const opPromise = store.createExecutionSnapshot(snapshotInput(run.id, env, id));
      await blip
        .severDuringNextStatement({
          queryContains: "TaskRunExecutionSnapshot",
          timeoutMs: 8000,
          pollMs: 2,
        })
        .catch(() => {}); // a missed catch (op finished first) is fine; the loop tries again

      const created = await opPromise;
      expect(created.id).toBe(id);
      expect(await client.taskRunExecutionSnapshot.count({ where: { id } })).toBe(1);

      if (totalRetries > before) caught++;
    }

    expect(caught).toBeGreaterThanOrEqual(1);
  }
);
