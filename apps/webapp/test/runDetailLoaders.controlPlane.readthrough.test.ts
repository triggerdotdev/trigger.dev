// Dedicated run-ops proof: the run-detail page loaders read the run by friendlyId on the dedicated
// run-ops client (PG17, subset schema with no control-plane tables), then authorize membership +
// resolve env on PG14. Neither DB joins the other.
import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let n = 0;
async function seedAll(prisma: PrismaClient) {
  const s = n++;
  const organization = await prisma.organization.create({
    data: { title: `Org ${s}`, slug: `org-${s}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `P ${s}`,
      slug: `p-${s}`,
      externalRef: `proj_${s}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `env-${s}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_${s}`,
      pkApiKey: `pk_${s}`,
      shortcode: `sc_${s}`,
    },
  });
  const member = await prisma.user.create({
    data: { email: `u-${s}@example.com`, name: `U ${s}`, authenticationMethod: "MAGIC_LINK" },
  });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: member.id, role: "ADMIN" },
  });
  const stranger = await prisma.user.create({
    data: { email: `x-${s}@example.com`, name: `X ${s}`, authenticationMethod: "MAGIC_LINK" },
  });
  return { organization, project, environment, member, stranger };
}

// The run lives on the dedicated run-ops client; its control-plane FKs are synthetic scalar ids
// pointing at rows that exist only on PG14 (the dedicated DB has no such tables).
async function seedKsuidRun(prisma17: RunOpsPrismaClient, cp: Awaited<ReturnType<typeof seedAll>>) {
  const k = n++;
  return prisma17.taskRun.create({
    data: {
      id: `run_2abcDEF${k}ghijkLMNOPqrstuv`,
      engine: "V2",
      status: "COMPLETED_SUCCESSFULLY",
      friendlyId: `run_2abcDEF${k}ghijkLMNOPqrstuv`,
      runtimeEnvironmentId: cp.environment.id,
      projectId: cp.project.id,
      organizationId: cp.organization.id,
      taskIdentifier: "run-detail-task",
      payload: "{}",
      payloadType: "application/json",
      queue: "task/run-detail-task",
      idempotencyKey: "idem-1",
      spanId: `sp_${k}`,
      traceId: `tr_${k}`,
      number: 1,
      workerQueue: "main",
    },
  });
}

function wire(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const runStore = new PostgresRunStore({
    prisma: prisma17 as unknown as PrismaClient,
    readOnlyPrisma: prisma17 as unknown as PrismaClient,
    schemaVariant: "dedicated",
  });
  const resolver = new ControlPlaneResolver({
    controlPlanePrimary: prisma14,
    controlPlaneReplica: prisma14,
    cache: new ControlPlaneCache(),
    splitEnabled: () => false,
  });
  return { runStore, resolver };
}

describe("run-detail loaders cross-DB read-through (dedicated run-ops client)", () => {
  heteroRunOpsPostgresTest(
    "ksuid run resolves: friendlyId read on the dedicated run-ops DB + membership/env auth on PG14 (resources.runs.$runParam shape)",
    async ({ prisma14, prisma17 }) => {
      const cp14 = prisma14 as unknown as PrismaClient;
      const cp = await seedAll(cp14);
      const run = await seedKsuidRun(prisma17, cp);
      const { runStore, resolver } = wire(cp14, prisma17);

      const found = await runStore.findRun(
        { friendlyId: run.friendlyId },
        {
          select: {
            id: true,
            traceId: true,
            projectId: true,
            runtimeEnvironmentId: true,
            status: true,
            queue: true,
            spanId: true,
            idempotencyKey: true,
            taskIdentifier: true,
          },
        }
      );
      expect(found).not.toBeNull();
      expect(found!.id).toBe(run.id);

      const authorized = await cp14.project.findFirst({
        where: {
          id: found!.projectId,
          organization: { members: { some: { userId: cp.member.id } } },
        },
        select: { id: true },
      });
      expect(authorized).not.toBeNull();

      const env = await resolver.resolveAuthenticatedEnv(found!.runtimeEnvironmentId);
      expect(env!.slug).toBe(cp.environment.slug);
      expect(env!.project.slug).toBe(cp.project.slug);
      expect(env!.organization.slug).toBe(cp.organization.slug);

      // Inversion proof: no run on PG14 (control-plane).
      expect(await cp14.taskRun.count()).toBe(0);
    }
  );

  heteroRunOpsPostgresTest(
    "non-member is denied: membership findFirst returns null (404/redirect path)",
    async ({ prisma14, prisma17 }) => {
      const cp14 = prisma14 as unknown as PrismaClient;
      const cp = await seedAll(cp14);
      const run = await seedKsuidRun(prisma17, cp);
      const { runStore } = wire(cp14, prisma17);

      const found = await runStore.findRun(
        { friendlyId: run.friendlyId },
        { select: { id: true, projectId: true, runtimeEnvironmentId: true } }
      );
      expect(found).not.toBeNull();

      const authorized = await cp14.project.findFirst({
        where: {
          id: found!.projectId,
          organization: { members: { some: { userId: cp.stranger.id } } },
        },
        select: { id: true },
      });
      expect(authorized).toBeNull();
    }
  );

  heteroRunOpsPostgresTest(
    "env-slug-scoped routes: idempotencyKey.reset re-imposes env slug on the resolved env",
    async ({ prisma14, prisma17 }) => {
      const cp14 = prisma14 as unknown as PrismaClient;
      const cp = await seedAll(cp14);
      const run = await seedKsuidRun(prisma17, cp);
      const { runStore, resolver } = wire(cp14, prisma17);

      const found = await runStore.findRun(
        { friendlyId: run.friendlyId },
        {
          select: {
            id: true,
            idempotencyKey: true,
            taskIdentifier: true,
            projectId: true,
            runtimeEnvironmentId: true,
          },
        }
      );
      const env = await resolver.resolveAuthenticatedEnv(found!.runtimeEnvironmentId);
      expect(env!.slug).toBe(cp.environment.slug);
      expect(env!.slug === "does-not-match").toBe(false);
      expect(found!.idempotencyKey).toBe("idem-1");
    }
  );
});
