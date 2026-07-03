// Real heterogeneous legacy + new Postgres proof for the alert-hydration TaskRun read.
// The DB is never mocked. A test-only RunStore wraps two real PostgresRunStore
// instances and routes findRun by id residency (ksuid → NEW, cuid → LEGACY),
// mirroring the sibling routing suite. The ProjectAlertChannel read must stay control-plane.
//
// The alert env-type read (parentEnvironment?.type ?? type) is resolved via the app
// ControlPlaneResolver over a control-plane client DISTINCT from the run-ops store, proving the
// cross-provider inversion. The prior version co-located env + run and masked it.
import { heteroPostgresTest, postgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { ReadClient, RunStore } from "@internal/run-store";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import { generateKsuidId } from "@trigger.dev/core/v3/isomorphic";
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

// Test-only routing store: resolve findRun by id length (27 → NEW, else LEGACY),
// dropping any forwarded client so each inner store uses its OWN prisma. NOT a mock —
// real DB I/O against two PostgresRunStore instances.
class RoutingRunStore implements RunStore {
  readonly #newStore: PostgresRunStore;
  readonly #legacyStore: PostgresRunStore;

  constructor(newStore: PostgresRunStore, legacyStore: PostgresRunStore) {
    this.#newStore = newStore;
    this.#legacyStore = legacyStore;
  }

  #resolveById(runId: string): PostgresRunStore {
    return runId.length === 27 ? this.#newStore : this.#legacyStore;
  }

  #idFromWhere(where: Prisma.TaskRunWhereInput): string | undefined {
    const id = (where as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }

  async findRun(
    where: Prisma.TaskRunWhereInput,
    argsOrClient?: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude } | ReadClient,
    _client?: ReadClient
  ): Promise<unknown> {
    const id = this.#idFromWhere(where);
    if (id !== undefined) {
      return (this.#resolveById(id).findRun as any)(where, argsOrClient);
    }
    const fromNew = await (this.#newStore.findRun as any)(where, argsOrClient);
    return fromNew ?? (this.#legacyStore.findRun as any)(where, argsOrClient);
  }

  // The remaining RunStore methods are not exercised here; delegate to NEW to satisfy
  // the interface.
  findRunOrThrow(...a: any[]): any {
    return (this.#newStore.findRunOrThrow as any)(...a);
  }
  findRuns(...a: any[]): any {
    return (this.#newStore.findRuns as any)(...a);
  }
  createRun(p: any, tx?: any): any {
    return this.#resolveById(p.data.id).createRun(p, tx);
  }
  createCancelledRun(p: any, tx?: any): any {
    return this.#resolveById(p.data.id).createCancelledRun(p, tx);
  }
  createFailedRun(p: any, tx?: any): any {
    return this.#resolveById(p.data.id).createFailedRun(p, tx);
  }
  updateMetadata(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).updateMetadata as any)(...[runId, ...a]);
  }
  startAttempt(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).startAttempt as any)(runId, ...a);
  }
  completeAttemptSuccess(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).completeAttemptSuccess as any)(runId, ...a);
  }
  recordRetryOutcome(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).recordRetryOutcome as any)(runId, ...a);
  }
  requeueRun(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).requeueRun as any)(runId, ...a);
  }
  recordBulkActionMembership(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).recordBulkActionMembership as any)(runId, ...a);
  }
  cancelRun(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).cancelRun as any)(runId, ...a);
  }
  failRunPermanently(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).failRunPermanently as any)(runId, ...a);
  }
  expireRun(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).expireRun as any)(runId, ...a);
  }
  expireRunsBatch(runIds: string[], ...a: any[]): any {
    return (this.#resolveById(runIds[0] ?? "").expireRunsBatch as any)(runIds, ...a);
  }
  lockRunToWorker(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).lockRunToWorker as any)(runId, ...a);
  }
  parkPendingVersion(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).parkPendingVersion as any)(runId, ...a);
  }
  promotePendingVersionRuns(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).promotePendingVersionRuns as any)(runId, ...a);
  }
  suspendForCheckpoint(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).suspendForCheckpoint as any)(runId, ...a);
  }
  resumeFromCheckpoint(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).resumeFromCheckpoint as any)(runId, ...a);
  }
  rescheduleRun(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).rescheduleRun as any)(runId, ...a);
  }
  enqueueDelayedRun(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).enqueueDelayedRun as any)(runId, ...a);
  }
  rewriteDebouncedRun(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).rewriteDebouncedRun as any)(runId, ...a);
  }
  clearIdempotencyKey(params: any, tx?: any): any {
    const runId = params?.byId?.runId ?? "";
    return this.#resolveById(runId).clearIdempotencyKey(params, tx);
  }
  pushTags(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).pushTags as any)(runId, ...a);
  }
  pushRealtimeStream(runId: string, ...a: any[]): any {
    return (this.#resolveById(runId).pushRealtimeStream as any)(runId, ...a);
  }
}

function buildRoutingStore(prisma17: PrismaClient, prisma14: PrismaClient) {
  const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
  const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
  return new RoutingRunStore(newStore, legacyStore);
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
      const id = generateKsuidId();
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
      const id = generateKsuidId();
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
