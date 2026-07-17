// A STANDALONE waitpoint/token (wait.createToken with no owning run) has an always-cuid id, so
// id-shape routing sends it to LEGACY. In a fully-minted-new deployment (env mints run-ops ids,
// legacy draining) that strands a new run's token on the draining DB and, under a read-only legacy
// connection, fails the write outright. A standalone token must instead read the env mint kind and
// land on the run's DB (NEW) via the `residency` co-location hint. Real two-DB topology; never mocked.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

const CUID_WAITPOINT = "c".repeat(25); // cuid id → classifies LEGACY (the always-wrong key for a new token)

function makeRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
  const legacyStore = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14,
    schemaVariant: "legacy",
  });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

// Seed real org/project/env on #legacy so its FKs are satisfied whichever store the waitpoint lands on
// (the #new dedicated subset is FK-free). Returns the ids the waitpoint rows reference.
async function seedLegacyEnv(prisma: PrismaClient, suffix: string) {
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
      type: "PRODUCTION",
      slug: `prod-${suffix}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
      maximumConcurrencyLimit: 10,
    },
  });
  return { projectId: project.id, environmentId: environment.id };
}

describe("run-ops split — a standalone token pins to NEW via the residency hint (not legacy by id-shape)", () => {
  heteroRunOpsPostgresTest(
    "createWaitpoint with residency NEW lands a cuid token on #new, absent from #legacy",
    async ({ prisma14, prisma17 }: { prisma14: PrismaClient; prisma17: RunOpsPrismaClient }) => {
      const router = makeRouter(prisma14, prisma17);
      const { projectId, environmentId } = await seedLegacyEnv(prisma14, "swr_create");

      await router.createWaitpoint(
        {
          data: {
            id: CUID_WAITPOINT,
            friendlyId: "wp_standalone",
            type: "MANUAL",
            status: "PENDING",
            idempotencyKey: `idem_${CUID_WAITPOINT}`,
            userProvidedIdempotencyKey: false,
            projectId,
            environmentId,
          },
        },
        undefined,
        { residency: "NEW" }
      );

      // GREEN: the residency hint routes the cuid token to #new. RED: id-shape sends it to #legacy.
      expect(await prisma17.waitpoint.count({ where: { id: CUID_WAITPOINT } })).toBe(1);
      expect(await prisma14.waitpoint.count({ where: { id: CUID_WAITPOINT } })).toBe(0);
    }
  );

  heteroRunOpsPostgresTest(
    "upsertWaitpoint with residency NEW lands a cuid token on #new, absent from #legacy",
    async ({ prisma14, prisma17 }: { prisma14: PrismaClient; prisma17: RunOpsPrismaClient }) => {
      const router = makeRouter(prisma14, prisma17);
      const { projectId, environmentId } = await seedLegacyEnv(prisma14, "swr_upsert");

      await router.upsertWaitpoint(
        {
          where: { id: CUID_WAITPOINT },
          create: {
            id: CUID_WAITPOINT,
            friendlyId: "wp_standalone_upsert",
            type: "MANUAL",
            status: "PENDING",
            idempotencyKey: `idem_${CUID_WAITPOINT}`,
            userProvidedIdempotencyKey: false,
            projectId,
            environmentId,
          },
          update: {},
        },
        undefined,
        { residency: "NEW" }
      );

      expect(await prisma17.waitpoint.count({ where: { id: CUID_WAITPOINT } })).toBe(1);
      expect(await prisma14.waitpoint.count({ where: { id: CUID_WAITPOINT } })).toBe(0);
    }
  );

  heteroRunOpsPostgresTest(
    "coLocateWithRunId wins over residency (a co-located waitpoint inherits its run, ignores the flag)",
    async ({ prisma14, prisma17 }: { prisma14: PrismaClient; prisma17: RunOpsPrismaClient }) => {
      const router = makeRouter(prisma14, prisma17);
      const { projectId, environmentId } = await seedLegacyEnv(prisma14, "swr_colocate");
      const legacyRunId = `run_${"c".repeat(25)}`; // cuid run → #legacy

      await router.createWaitpoint(
        {
          data: {
            id: CUID_WAITPOINT,
            friendlyId: "wp_colocated",
            type: "DATETIME",
            status: "PENDING",
            idempotencyKey: `idem_${CUID_WAITPOINT}`,
            userProvidedIdempotencyKey: false,
            projectId,
            environmentId,
          },
        },
        undefined,
        { coLocateWithRunId: legacyRunId, residency: "NEW" }
      );

      // Co-location must win → the waitpoint lands on the run's store (#legacy), NOT the residency hint.
      expect(await prisma14.waitpoint.count({ where: { id: CUID_WAITPOINT } })).toBe(1);
      expect(await prisma17.waitpoint.count({ where: { id: CUID_WAITPOINT } })).toBe(0);
    }
  );
});
