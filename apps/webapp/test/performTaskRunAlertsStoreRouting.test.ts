// Real heterogeneous legacy + new Postgres proof for the alert-hydration TaskRun read.
// The DB is never mocked. The REAL RoutingRunStore wraps two real PostgresRunStore instances and
// routes findRun by id residency, mirroring the sibling routing suite. The ProjectAlertChannel
// read must stay control-plane.
//
// The alert env-type read (parentEnvironment?.type ?? type) is resolved via the app
// ControlPlaneResolver over a control-plane client DISTINCT from the run-ops store, proving the
// cross-provider inversion. The prior version co-located env + run and masked it.
import { heteroPostgresTest, postgresTest } from "@internal/testcontainers";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { PerformTaskRunAlertsService } from "~/v3/services/alerts/performTaskRunAlerts.server";

function buildControlPlaneResolver(controlPlane: PrismaClient) {
  return new ControlPlaneResolver({
    controlPlanePrimary: controlPlane,
    controlPlaneReplica: controlPlane,
    cache: new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 }),
    // Split OFF: plain control-plane query every call, byte-identical to the inline join.
    splitEnabled: () => false,
  });
}

vi.setConfig({ testTimeout: 60_000 });

// The alert-hydration TaskRun read runs through the REAL RoutingRunStore over two real
// PostgresRunStore instances (NEW = PG17, LEGACY = PG14). The DB is never mocked. The router
// resolves residency from the id shape — a v1 run-ops id (26 chars, version "1" at index 25) to
// NEW, a 25-char cuid to LEGACY — and never forwards a caller-passed control-plane client into a
// routed read, so each store uses its OWN prisma.

function buildRoutingStore(prisma17: PrismaClient, prisma14: PrismaClient) {
  const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
  const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

async function seedProject(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `test-${suffix}`, slug: `test-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `test-${suffix}`,
      slug: `test-${suffix}`,
      organizationId: organization.id,
      externalRef: `test-${suffix}`,
    },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `test-${suffix}`,
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `test-${suffix}`,
      pkApiKey: `test-${suffix}`,
      shortcode: `test-${suffix}`,
    },
  });
  return { organization, project, runtimeEnvironment };
}

async function seedRun(
  prisma: PrismaClient,
  ids: { id: string; friendlyId: string },
  env: { runtimeEnvironmentId: string; projectId: string; organizationId: string }
) {
  return prisma.taskRun.create({
    data: {
      id: ids.id,
      friendlyId: ids.friendlyId,
      taskIdentifier: "my-task",
      payload: JSON.stringify({ foo: "bar" }),
      payloadType: "application/json",
      traceId: "1234",
      spanId: "1234",
      queue: "test",
      runtimeEnvironmentId: env.runtimeEnvironmentId,
      projectId: env.projectId,
      organizationId: env.organizationId,
      environmentType: "PRODUCTION",
      engine: "V2",
      status: "COMPLETED_SUCCESSFULLY",
    },
  });
}

const TASK_RUN_CROSS_SEAM_FKS = [
  "TaskRun_runtimeEnvironmentId_fkey",
  "TaskRun_projectId_fkey",
  "TaskRun_organizationId_fkey",
] as const;

async function dropTaskRunCrossSeamFks(prisma: PrismaClient) {
  for (const constraint of TASK_RUN_CROSS_SEAM_FKS) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "${constraint}"`
    );
  }
}

describe("PerformTaskRunAlertsService store routing (hetero)", () => {
  heteroPostgresTest(
    "env type resolves via the control-plane resolver (distinct DB) while the run resolves on the run-ops store",
    async ({ prisma17, prisma14 }) => {
      const id = generateRunOpsId();
      const friendlyId = `run_${id}`;

      // Cloud shape: run-ops = the new DB (cross-seam FKs dropped), control-plane = the legacy DB.
      // The control-plane ProjectAlert -> run-ops TaskRun FK is also dropped on the control-plane DB.
      await dropTaskRunCrossSeamFks(prisma17);
      await prisma14.$executeRawUnsafe(
        `ALTER TABLE "ProjectAlert" DROP CONSTRAINT IF EXISTS "ProjectAlert_taskRunId_fkey"`
      );

      // Org/project/env + a PARENT env + the alert channel are control-plane → the control-plane DB.
      const { project, organization } = await seedProject(prisma14, "cp");
      // A branch env whose parent type drives the channel filter (parentEnvironmentType ?? type).
      const parentEnv = await prisma14.runtimeEnvironment.create({
        data: {
          slug: "cp-parent",
          type: "PRODUCTION",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "cp-parent",
          pkApiKey: "cp-parent",
          shortcode: "cp-parent",
        },
      });
      const childEnv = await prisma14.runtimeEnvironment.create({
        data: {
          slug: "cp-child",
          type: "PREVIEW",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "cp-child",
          pkApiKey: "cp-child",
          shortcode: "cp-child",
          parentEnvironmentId: parentEnv.id,
        },
      });

      // The run-ops scalar row lives on the run-ops DB, referencing the child (preview) env on the control-plane DB.
      await seedRun(
        prisma17,
        { id, friendlyId },
        {
          runtimeEnvironmentId: childEnv.id,
          projectId: project.id,
          organizationId: organization.id,
        }
      );

      // A channel scoped to the PARENT env's type (PRODUCTION). It matches only if the service
      // computes parentEnvironmentType ?? type — i.e. the parent's PRODUCTION, not the run env's
      // PREVIEW. This proves the resolver's parentEnvironmentType is honoured.
      await prisma14.projectAlertChannel.create({
        data: {
          friendlyId: `alert_${id}`,
          name: "test-channel",
          projectId: project.id,
          alertTypes: ["TASK_RUN"],
          environmentTypes: ["PRODUCTION"],
          type: "EMAIL",
          properties: { type: "EMAIL", email: "test@example.com" },
          enabled: true,
        },
      });

      // prisma (control-plane channel read) = the control-plane DB; the run-ops read is routed to
      // the run-ops DB; the env type is resolved via the resolver over the control-plane client.
      const service = new PerformTaskRunAlertsService({
        prisma: prisma14,
        runStore: buildRoutingStore(prisma17, prisma14),
        controlPlaneResolver: buildControlPlaneResolver(prisma14),
      });

      // The downstream DeliverAlertService.enqueue hits redis (absent here); the projectAlert row
      // is created before that, so tolerate the enqueue rejection.
      await service.call(id).catch(() => {});

      // The channel matched on the PARENT env type → a DeliverAlert row was created on the control-plane DB.
      const delivered = await prisma14.projectAlert.findMany({ where: { projectId: project.id } });
      expect(delivered.length).toBe(1);

      // Inversion: the run-ops DB holds NO env rows; a co-located join would resolve null.
      expect(await prisma17.runtimeEnvironment.count()).toBe(0);
      // The run-ops store has the run; the control-plane DB never received it.
      expect(await prisma14.taskRun.findFirst({ where: { id } })).toBeNull();
    }
  );
});

describe("PerformTaskRunAlertsService passthrough (single-DB)", () => {
  postgresTest(
    "with the default store, run read + alert-channel read both resolve on the single DB",
    async ({ prisma }) => {
      const id = generateRunOpsId();
      const friendlyId = `run_${id}`;

      const { project, organization, runtimeEnvironment } = await seedProject(prisma, "pt");
      await seedRun(
        prisma,
        { id, friendlyId },
        {
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
        }
      );
      await prisma.projectAlertChannel.create({
        data: {
          friendlyId: `alert_${id}`,
          name: "test-channel",
          projectId: project.id,
          alertTypes: ["TASK_RUN"],
          environmentTypes: ["PRODUCTION"],
          type: "EMAIL",
          properties: { type: "EMAIL", email: "test@example.com" },
          enabled: true,
        },
      });

      const service = new PerformTaskRunAlertsService({
        prisma,
        // The single-DB default store: a passthrough PostgresRunStore over the one
        // container. Injected explicitly so the read resolves on the container the run
        // was seeded into, not the ambient module singleton.
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        controlPlaneResolver: buildControlPlaneResolver(prisma),
      });
      await service.call(id).catch(() => {});

      const delivered = await prisma.projectAlert.findMany({ where: { projectId: project.id } });
      expect(delivered.length).toBe(1);
    }
  );
});
