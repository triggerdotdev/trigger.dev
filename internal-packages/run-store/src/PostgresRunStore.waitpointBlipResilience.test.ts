// Waitpoint-completion blip resilience for each refactored store site. Two distinct properties are
// covered per site: (1) an idle-connection drop is absorbed transparently by the pg adapter pool
// (severIdle), and (2) a connection severed MID-STATEMENT actually exercises the infra-retry — the
// classifier recognises the adapter's connection-loss error and the reissued statement recovers
// (severDuringNextStatement, looped until a blip is genuinely caught so the retry provably fires).

import { postgresBlipTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { setupSnapshotIdFixture } from "./testFixtures/snapshotIdFixture.js";

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
  "findWaitpoint survives an idle blip with infra-retry enabled (adapter absorbs it)",
  { timeout: 60_000 },
  async ({ prisma, blip }) => {
    const client = prisma as PrismaClient;
    const { project, environment } = await seedEnvironment(client, "wpok");
    await createPendingWaitpoint(client, "wp_blip_ok", project.id, environment.id);

    const store = new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: prisma as never,
      infraRetry,
    });

    await store.findWaitpoint({ where: { id: "wp_blip_ok" } }); // warm the pool
    await blip.severIdle();

    const found = await store.findWaitpoint({ where: { id: "wp_blip_ok" } });
    expect(found?.id).toBe("wp_blip_ok");
  }
);

postgresBlipTest(
  "findWaitpoint survives an idle blip even without infra-retry (adapter pool reconnects)",
  { timeout: 60_000 },
  async ({ prisma, blip }) => {
    const client = prisma as PrismaClient;
    const { project, environment } = await seedEnvironment(client, "wpbase");
    await createPendingWaitpoint(client, "wp_blip_base", project.id, environment.id);

    const store = new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: prisma as never,
    });

    await store.findWaitpoint({ where: { id: "wp_blip_base" } }); // warm the pool
    await blip.severIdle();

    // The pg driver adapter's pool discards the dead connection and opens a fresh one for the next
    // statement, so an idle-connection blip is absorbed transparently, with no retry needed.
    const found = await store.findWaitpoint({ where: { id: "wp_blip_base" } });
    expect(found?.id).toBe("wp_blip_base");
  }
);

postgresBlipTest(
  "deleteManyTaskRunWaitpoints survives an idle blip (adapter absorbs it)",
  { timeout: 60_000 },
  async ({ prisma, blip }) => {
    const client = prisma as PrismaClient;
    const { run, env } = await setupSnapshotIdFixture(client);
    const waitpointId = generateInternalId();
    await createPendingWaitpoint(client, waitpointId, env.projectId, env.id);
    const edge = await client.taskRunWaitpoint.create({
      data: { taskRunId: run.id, waitpointId, projectId: env.projectId },
    });

    const store = new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: prisma as never,
      infraRetry,
    });

    await store.findManyTaskRunWaitpoints({ where: { taskRunId: run.id } }); // warm the pool
    await blip.severIdle();

    const deleted = await store.deleteManyTaskRunWaitpoints({
      where: { taskRunId: run.id, id: { in: [edge.id] } },
    });
    expect(deleted.count).toBe(1);
    expect(await client.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(0);
  }
);

postgresBlipTest(
  "findWaitpoint recovers from a mid-statement blip (retry actually fires)",
  { timeout: 120_000 },
  async ({ prisma, blip }) => {
    const client = prisma as PrismaClient;
    const { project, environment } = await seedEnvironment(client, "wpmid");
    await createPendingWaitpoint(client, "wp_mid", project.id, environment.id);

    let retries = 0;
    const store = new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: prisma as never,
      infraRetry: {
        options: infraRetry.options,
        onRetry: () => {
          retries++;
        },
      },
    });
    await store.findWaitpoint({ where: { id: "wp_mid" } }); // warm

    let caught = 0;
    for (let i = 0; i < 40 && caught < 1; i++) {
      const before = retries;
      const p = store.findWaitpoint({ where: { id: "wp_mid" } });
      await blip
        .severDuringNextStatement({ queryContains: "Waitpoint", timeoutMs: 6000, pollMs: 1 })
        .catch(() => {});
      const found = await p;
      expect(found?.id).toBe("wp_mid");
      if (retries > before) caught++;
    }
    expect(caught).toBeGreaterThanOrEqual(1);
  }
);

postgresBlipTest(
  "findManyTaskRunWaitpoints recovers from a mid-statement blip (retry actually fires)",
  { timeout: 120_000 },
  async ({ prisma, blip }) => {
    const client = prisma as PrismaClient;
    const { run, env } = await setupSnapshotIdFixture(client);
    const waitpointId = generateInternalId();
    await createPendingWaitpoint(client, waitpointId, env.projectId, env.id);
    await client.taskRunWaitpoint.create({
      data: { taskRunId: run.id, waitpointId, projectId: env.projectId },
    });

    let retries = 0;
    const store = new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: prisma as never,
      infraRetry: {
        options: infraRetry.options,
        onRetry: () => {
          retries++;
        },
      },
    });
    await store.findManyTaskRunWaitpoints({ where: { taskRunId: run.id } }); // warm

    let caught = 0;
    for (let i = 0; i < 40 && caught < 1; i++) {
      const before = retries;
      const p = store.findManyTaskRunWaitpoints({ where: { taskRunId: run.id } });
      await blip
        .severDuringNextStatement({ queryContains: "TaskRunWaitpoint", timeoutMs: 6000, pollMs: 1 })
        .catch(() => {});
      const rows = await p;
      expect(rows).toHaveLength(1);
      if (retries > before) caught++;
    }
    expect(caught).toBeGreaterThanOrEqual(1);
  }
);

postgresBlipTest(
  "updateManyWaitpoints (completion write) recovers from a mid-statement blip (retry actually fires)",
  { timeout: 120_000 },
  async ({ prisma, blip }) => {
    const client = prisma as PrismaClient;
    const { project, environment } = await seedEnvironment(client, "wpupd");
    await createPendingWaitpoint(client, "wp_upd", project.id, environment.id);

    let retries = 0;
    const store = new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: prisma as never,
      infraRetry: {
        options: infraRetry.options,
        onRetry: () => {
          retries++;
        },
      },
    });
    await store.findWaitpoint({ where: { id: "wp_upd" } }); // warm

    // Status-guarded and idempotent: the first update completes it, replays match 0 rows.
    let caught = 0;
    for (let i = 0; i < 40 && caught < 1; i++) {
      const before = retries;
      const p = store.updateManyWaitpoints({
        where: { id: "wp_upd", status: "PENDING" },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      await blip
        .severDuringNextStatement({ queryContains: "Waitpoint", timeoutMs: 6000, pollMs: 1 })
        .catch(() => {});
      await p; // must not throw
      if (retries > before) caught++;
    }
    expect(caught).toBeGreaterThanOrEqual(1);
    const wp = await client.waitpoint.findFirst({ where: { id: "wp_upd" } });
    expect(wp?.status).toBe("COMPLETED");
  }
);

postgresBlipTest(
  "deleteManyTaskRunWaitpoints recovers from a mid-statement blip (retry actually fires)",
  { timeout: 120_000 },
  async ({ prisma, blip }) => {
    const client = prisma as PrismaClient;
    const { run, env } = await setupSnapshotIdFixture(client);
    const waitpointId = generateInternalId();
    await createPendingWaitpoint(client, waitpointId, env.projectId, env.id);
    await client.taskRunWaitpoint.create({
      data: { taskRunId: run.id, waitpointId, projectId: env.projectId },
    });

    let retries = 0;
    const store = new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: prisma as never,
      infraRetry: {
        options: infraRetry.options,
        onRetry: () => {
          retries++;
        },
      },
    });
    await store.findManyTaskRunWaitpoints({ where: { taskRunId: run.id } }); // warm

    // Idempotent: the first delete removes the edge, replays match 0 rows. Each iteration still runs
    // a DELETE statement, so the blip has something to sever.
    let caught = 0;
    for (let i = 0; i < 40 && caught < 1; i++) {
      const before = retries;
      const p = store.deleteManyTaskRunWaitpoints({ where: { taskRunId: run.id } });
      await blip
        .severDuringNextStatement({ queryContains: "TaskRunWaitpoint", timeoutMs: 6000, pollMs: 1 })
        .catch(() => {});
      await p; // must not throw
      if (retries > before) caught++;
    }
    expect(caught).toBeGreaterThanOrEqual(1);
    expect(await client.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(0);
  }
);
