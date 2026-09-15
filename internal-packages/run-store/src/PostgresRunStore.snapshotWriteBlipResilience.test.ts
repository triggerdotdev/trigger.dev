// The snapshot write must survive a connection blip on the pg driver adapter (the prod runtime). A
// connection lost mid-statement is caught by the store's infra-retry: we inject the pg driver's real
// connection-loss error ONCE at the query seam (withOneShotBlip) and confirm the reissued insert
// recovers with exactly one row, while without retry the blip propagates. This replaces racing a live
// socket sever (which flaked on CI when the query finished before the sever landed). The retry loop
// and classifier are unit-tested in the database package; idempotency under replay in
// PostgresRunStore.snapshotIdempotency.test.ts.
import { postgresBlipTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { setupSnapshotIdFixture } from "./testFixtures/snapshotIdFixture.js";
import { withOneShotBlip } from "./testFixtures/oneShotBlip.js";

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
  "createExecutionSnapshot without infra-retry propagates a connection blip (retry is required to recover)",
  { timeout: 60_000 },
  async ({ prisma }) => {
    const client = prisma as PrismaClient;
    const { run, env } = await setupSnapshotIdFixture(client);
    const id = generateInternalId();

    // No infraRetry: the store runs the write once, so an injected connection loss surfaces to the
    // caller. Recovery with retry is proven deterministically by the mid-statement injection tests below.
    const faulting = withOneShotBlip(prisma, "taskRunExecutionSnapshot", "createMany");
    const store = new PostgresRunStore({
      prisma: faulting as never,
      readOnlyPrisma: faulting as never,
    });

    await expect(store.createExecutionSnapshot(snapshotInput(run.id, env, id))).rejects.toThrow();
  }
);

postgresBlipTest(
  "createExecutionSnapshot retries a mid-statement connection loss and lands exactly one row",
  { timeout: 60_000 },
  async ({ prisma }) => {
    const client = prisma as PrismaClient;
    const { run, env } = await setupSnapshotIdFixture(client);
    const id = generateInternalId();

    let retries = 0;
    const faulting = withOneShotBlip(prisma, "taskRunExecutionSnapshot", "createMany");
    const store = new PostgresRunStore({
      prisma: faulting as never,
      readOnlyPrisma: faulting as never,
      infraRetry: {
        options: { enabled: true, maxAttempts: 15, backoffMinMs: 10, backoffMaxMs: 60 },
        onRetry: () => retries++,
      },
    });

    // The snapshot statement is killed once; the classifier recognises the connection-loss error, the
    // retry reissues the transaction, and the stable id keeps the reissue idempotent.
    const created = await store.createExecutionSnapshot(snapshotInput(run.id, env, id));
    expect(created.id).toBe(id);
    expect(retries).toBe(1);
    expect(await client.taskRunExecutionSnapshot.count({ where: { id } })).toBe(1);
  }
);

postgresBlipTest(
  "createExecutionSnapshot stays idempotent under a blip when the prior attempt already committed",
  { timeout: 60_000 },
  async ({ prisma }) => {
    const client = prisma as PrismaClient;
    const { run, env } = await setupSnapshotIdFixture(client);
    const id = generateInternalId();

    // The dangerous case: a prior attempt COMMITTED the row and its ack was lost, so the operation is
    // replayed. Write it once (committed), then replay the same transition under a one-shot blip. The
    // conflict-ignoring insert makes the replay a no-op and the primary-key read returns the existing
    // row, never a duplicate.
    const seedStore = new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: prisma as never,
    });
    await seedStore.createExecutionSnapshot(snapshotInput(run.id, env, id));

    let retries = 0;
    const faulting = withOneShotBlip(prisma, "taskRunExecutionSnapshot", "createMany");
    const store = new PostgresRunStore({
      prisma: faulting as never,
      readOnlyPrisma: faulting as never,
      infraRetry: {
        options: { enabled: true, maxAttempts: 15, backoffMinMs: 10, backoffMaxMs: 60 },
        onRetry: () => retries++,
      },
    });

    const created = await store.createExecutionSnapshot(snapshotInput(run.id, env, id));
    expect(created.id).toBe(id);
    expect(retries).toBe(1);
    expect(await client.taskRunExecutionSnapshot.count({ where: { id } })).toBe(1);
  }
);
