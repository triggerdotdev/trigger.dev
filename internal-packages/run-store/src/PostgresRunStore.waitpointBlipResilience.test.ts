// Waitpoint-completion blip resilience: the read path that failed in production
// (prisma.waitpoint.findFirst during a connection blip) must survive a brief
// disconnect when the store is given an infra-retry config, and must still fail
// fast without one.

import { postgresBlipTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";

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
  "findWaitpoint recovers from a connection blip when infra-retry is enabled",
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
  "findWaitpoint without infra-retry surfaces the connection error (baseline)",
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

    await expect(store.findWaitpoint({ where: { id: "wp_blip_base" } })).rejects.toThrow();
  }
);
