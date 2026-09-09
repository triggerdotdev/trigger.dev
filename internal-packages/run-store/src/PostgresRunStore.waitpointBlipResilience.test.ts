// Blip-resilience for each refactored store site: a connection lost during a statement is caught by
// the infra-retry classifier and the reissued statement recovers, while without retry it propagates.
// These used to race a live socket sever (severDuringNextStatement / severIdle), which flaked on CI
// (the query usually finished before the sever could land, so the retry never fired, or the pool
// reconnect was not deterministic). Instead we inject the pg driver's real connection-loss error ONCE
// at the query seam (withOneShotBlip) and let the store's real withInfraRetry + classifier recover on
// a real testcontainer DB. The retry LOGIC and the classifier are unit-tested in the database package;
// idempotency under replay in PostgresRunStore.snapshotIdempotency.test.ts. Here we prove the store
// WIRES them together.

import { postgresBlipTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { setupSnapshotIdFixture } from "./testFixtures/snapshotIdFixture.js";
import { withOneShotBlip } from "./testFixtures/oneShotBlip.js";

const infraRetry = {
  options: { enabled: true, maxAttempts: 12, backoffMinMs: 20, backoffMaxMs: 120 },
};

async function seedEnvironment(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { project, environment };
}

async function createPendingWaitpoint(
  prisma: PrismaClient,
  id: string,
  projectId: string,
  environmentId: string
) {
  return prisma.waitpoint.create({
    data: {
      id,
      friendlyId: `wp_${id}`,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: `idem_${id}`,
      userProvidedIdempotencyKey: false,
      projectId,
      environmentId,
    },
  });
}

postgresBlipTest(
  "findWaitpoint without infra-retry propagates a connection blip (retry is required to recover)",
  { timeout: 60_000 },
  async ({ prisma }) => {
    const client = prisma as PrismaClient;
    const { project, environment } = await seedEnvironment(client, "wpbase");
    await createPendingWaitpoint(client, "wp_blip_base", project.id, environment.id);

    // No infraRetry: the store runs the statement once, so an injected connection loss is not absorbed
    // and surfaces to the caller. This is the boundary the retry-enabled paths recover from; recovery
    // itself is proven deterministically by the mid-statement injection tests below.
    const faulting = withOneShotBlip(prisma, "waitpoint", "findFirst");
    const store = new PostgresRunStore({
      prisma: faulting as never,
      readOnlyPrisma: faulting as never,
    });

    await expect(store.findWaitpoint({ where: { id: "wp_blip_base" } })).rejects.toThrow();
  }
);

postgresBlipTest(
  "findWaitpoint retries a mid-statement connection loss and recovers (retry fires once)",
  { timeout: 60_000 },
  async ({ prisma }) => {
    const client = prisma as PrismaClient;
    const { project, environment } = await seedEnvironment(client, "wpmid");
    await createPendingWaitpoint(client, "wp_mid", project.id, environment.id);

    let retries = 0;
    const faulting = withOneShotBlip(prisma, "waitpoint", "findFirst");
    const store = new PostgresRunStore({
      prisma: faulting as never,
      readOnlyPrisma: faulting as never,
      infraRetry: { options: infraRetry.options, onRetry: () => retries++ },
    });

    const found = await store.findWaitpoint({ where: { id: "wp_mid" } });
    expect(found?.id).toBe("wp_mid");
    expect(retries).toBe(1);
  }
);

postgresBlipTest(
  "findManyTaskRunWaitpoints retries a mid-statement connection loss and recovers (retry fires once)",
  { timeout: 60_000 },
  async ({ prisma }) => {
    const client = prisma as PrismaClient;
    const { run, env } = await setupSnapshotIdFixture(client);
    const waitpointId = generateInternalId();
    await createPendingWaitpoint(client, waitpointId, env.projectId, env.id);
    await client.taskRunWaitpoint.create({
      data: { taskRunId: run.id, waitpointId, projectId: env.projectId },
    });

    let retries = 0;
    const faulting = withOneShotBlip(prisma, "taskRunWaitpoint", "findMany");
    const store = new PostgresRunStore({
      prisma: faulting as never,
      readOnlyPrisma: faulting as never,
      infraRetry: { options: infraRetry.options, onRetry: () => retries++ },
    });

    const rows = await store.findManyTaskRunWaitpoints({ where: { taskRunId: run.id } });
    expect(rows).toHaveLength(1);
    expect(retries).toBe(1);
  }
);

postgresBlipTest(
  "markWaitpointCompleted retries a mid-statement connection loss (retry fires once)",
  { timeout: 60_000 },
  async ({ prisma }) => {
    const client = prisma as PrismaClient;
    const { project, environment } = await seedEnvironment(client, "wpupd");
    await createPendingWaitpoint(client, "wp_upd", project.id, environment.id);

    let retries = 0;
    const faulting = withOneShotBlip(prisma, "waitpoint", "updateMany");
    const store = new PostgresRunStore({
      prisma: faulting as never,
      readOnlyPrisma: faulting as never,
      infraRetry: { options: infraRetry.options, onRetry: () => retries++ },
    });

    // The store builds the PENDING guard internally, so the replayed statement matches the same row
    // and lands COMPLETED exactly once.
    await store.markWaitpointCompleted("wp_upd", { output: { value: "done", isError: false } });
    expect(retries).toBe(1);
    const wp = await client.waitpoint.findFirst({ where: { id: "wp_upd" } });
    expect(wp?.status).toBe("COMPLETED");
  }
);

postgresBlipTest(
  "generic updateManyWaitpoints is NOT retried on a blip (propagates)",
  { timeout: 60_000 },
  async ({ prisma }) => {
    const client = prisma as PrismaClient;
    const { project, environment } = await seedEnvironment(client, "wpgen");
    await createPendingWaitpoint(client, "wp_gen", project.id, environment.id);

    let retries = 0;
    const faulting = withOneShotBlip(prisma, "waitpoint", "updateMany");
    const store = new PostgresRunStore({
      prisma: faulting as never,
      readOnlyPrisma: faulting as never,
      infraRetry: { options: infraRetry.options, onRetry: () => retries++ },
    });

    // The generic update accepts arbitrary (possibly non-idempotent) args, so it is never retried: the
    // injected blip surfaces to the caller and onRetry never fires.
    await expect(
      store.updateManyWaitpoints({
        where: { id: "wp_gen", status: "PENDING" },
        data: { status: "COMPLETED", completedAt: new Date() },
      })
    ).rejects.toThrow();
    expect(retries).toBe(0);
  }
);

postgresBlipTest(
  "deleteManyTaskRunWaitpoints retries a mid-statement connection loss and recovers (retry fires once)",
  { timeout: 60_000 },
  async ({ prisma }) => {
    const client = prisma as PrismaClient;
    const { run, env } = await setupSnapshotIdFixture(client);
    const waitpointId = generateInternalId();
    await createPendingWaitpoint(client, waitpointId, env.projectId, env.id);
    await client.taskRunWaitpoint.create({
      data: { taskRunId: run.id, waitpointId, projectId: env.projectId },
    });

    let retries = 0;
    const faulting = withOneShotBlip(prisma, "taskRunWaitpoint", "deleteMany");
    const store = new PostgresRunStore({
      prisma: faulting as never,
      readOnlyPrisma: faulting as never,
      infraRetry: { options: infraRetry.options, onRetry: () => retries++ },
    });

    // Idempotent: the delete removes the edge; a replay on the retry matches 0 rows. Either way the
    // edge is gone and the statement never throws out.
    await store.deleteManyTaskRunWaitpoints({ where: { taskRunId: run.id } });
    expect(retries).toBe(1);
    expect(await client.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(0);
  }
);

postgresBlipTest(
  "markWaitpointCompleted stays idempotent when a committed completion loses its acknowledgement",
  { timeout: 60_000 },
  async ({ prisma }) => {
    const client = prisma as PrismaClient;
    const { project, environment } = await seedEnvironment(client, "wpupdack");
    await createPendingWaitpoint(client, "wp_upd_ack", project.id, environment.id);

    let retries = 0;
    const faulting = withOneShotBlip(prisma, "waitpoint", "updateMany", "after");
    const store = new PostgresRunStore({
      prisma: faulting as never,
      readOnlyPrisma: faulting as never,
      infraRetry: { options: infraRetry.options, onRetry: () => retries++ },
    });

    // The first update commits PENDING -> COMPLETED, then its ack is lost. The status-guarded replay on
    // the retry matches 0 rows, so the completion lands exactly once and never double-applies.
    await store.markWaitpointCompleted("wp_upd_ack", { output: { value: "done", isError: false } });
    expect(retries).toBe(1);
    const wp = await client.waitpoint.findFirst({ where: { id: "wp_upd_ack" } });
    expect(wp?.status).toBe("COMPLETED");
  }
);

postgresBlipTest(
  "deleteManyTaskRunWaitpoints stays idempotent when a committed delete loses its acknowledgement",
  { timeout: 60_000 },
  async ({ prisma }) => {
    const client = prisma as PrismaClient;
    const { run, env } = await setupSnapshotIdFixture(client);
    const waitpointId = generateInternalId();
    await createPendingWaitpoint(client, waitpointId, env.projectId, env.id);
    await client.taskRunWaitpoint.create({
      data: { taskRunId: run.id, waitpointId, projectId: env.projectId },
    });

    let retries = 0;
    const faulting = withOneShotBlip(prisma, "taskRunWaitpoint", "deleteMany", "after");
    const store = new PostgresRunStore({
      prisma: faulting as never,
      readOnlyPrisma: faulting as never,
      infraRetry: { options: infraRetry.options, onRetry: () => retries++ },
    });

    // The first delete commits, then its ack is lost. The replay on the retry matches 0 rows; either
    // way the edge is gone, so the delete is idempotent under a lost-ack replay.
    await store.deleteManyTaskRunWaitpoints({ where: { taskRunId: run.id } });
    expect(retries).toBe(1);
    expect(await client.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(0);
  }
);

postgresBlipTest(
  "a caller transaction is never retried on a blip (safety boundary)",
  { timeout: 60_000 },
  async ({ prisma }) => {
    const client = prisma as PrismaClient;
    const { run, env } = await setupSnapshotIdFixture(client);
    const waitpointId = generateInternalId();
    await createPendingWaitpoint(client, waitpointId, env.projectId, env.id);
    await client.taskRunWaitpoint.create({
      data: { taskRunId: run.id, waitpointId, projectId: env.projectId },
    });

    let retries = 0;
    const faulting = withOneShotBlip(prisma, "taskRunWaitpoint", "findMany");
    const store = new PostgresRunStore({
      prisma: faulting as never,
      readOnlyPrisma: faulting as never,
      infraRetry: { options: infraRetry.options, onRetry: () => retries++ },
    });

    // Inside a caller-supplied transaction the store must run the statement exactly once: retrying a
    // statement in an already-aborted tx is unsafe. The connection loss aborts the tx and surfaces the
    // error, and onRetry never fires.
    await expect(
      (faulting as any).$transaction((tx: any) =>
        store.findManyTaskRunWaitpoints({ where: { taskRunId: run.id } }, tx)
      )
    ).rejects.toThrow();
    expect(retries).toBe(0);
  }
);
