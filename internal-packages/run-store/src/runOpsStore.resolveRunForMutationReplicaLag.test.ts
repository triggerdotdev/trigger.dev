// Store-seam characterization of the read primitive behind mollifier resolveRunForMutation — NOT a
// caller guard. The resolver reads findRun on the branded $replica, then re-probes the writer on a
// miss; here we reproduce just that two-step read against real Postgres with the owning replica frozen,
// to show the branded-replica read genuinely misses a fresh row (readYourWrites=false) while the writer
// re-probe recovers it. The caller contract (resolveRunForMutation returns source:"pg" instead of a
// spurious 404 under lag) is locked separately by the real caller-driven guards that drive the exported
// resolver end-to-end.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import { markReadReplicaClient } from "./readReplicaClient.js";

// A cuid (25 chars after the `run_` prefix) classifies LEGACY, so both the create and the
// friendlyId-keyed read route to the legacy (control-plane) store first.
const CUID_25 = "c".repeat(25);
const FRIENDLY_25 = "d".repeat(25);

async function seedEnvironmentLegacy(prisma: PrismaClient, suffix: string) {
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
  return { organization, project, environment };
}

function taskRunData(opts: {
  id: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}) {
  return {
    id: opts.id,
    engine: "V2" as const,
    status: "PENDING" as const,
    friendlyId: opts.friendlyId,
    runtimeEnvironmentId: opts.runtimeEnvironmentId,
    environmentType: "DEVELOPMENT" as const,
    organizationId: opts.organizationId,
    projectId: opts.projectId,
    taskIdentifier: "my-task",
    payload: "{}",
    payloadType: "application/json",
    traceContext: {},
    traceId: `trace_${opts.id}`,
    spanId: `span_${opts.id}`,
    queue: "task/my-task",
    isTest: false,
    taskEventStore: "taskEvent",
    depth: 0,
  };
}

// Mimic the mollifier resolver's PG portion exactly: read the BRANDED replica first, then re-probe the
// WRITER on a miss. (The buffer probe between the two is orthogonal to the replica-lag question.)
async function resolveViaRunStorePgReads(
  router: RoutingRunStore,
  where: { friendlyId: string; runtimeEnvironmentId: string },
  brandedReplica: unknown,
  writer: PrismaClient
): Promise<{ friendlyId: string } | null> {
  const pgRun = (await router.findRun(where, { select: { friendlyId: true } }, brandedReplica)) as {
    friendlyId: string;
  } | null;
  if (pgRun) return { friendlyId: pgRun.friendlyId };

  const writerRun = (await router.findRun(where, { select: { friendlyId: true } }, writer)) as {
    friendlyId: string;
  } | null;
  if (writerRun) return { friendlyId: writerRun.friendlyId };

  return null;
}

describe("store reads behind mollifier resolveRunForMutation — replica-first, writer-probe recovers", () => {
  heteroRunOpsPostgresTest(
    "fresh run invisible on the lagging replica is still resolved via the writer probe",
    async ({ prisma14, prisma17 }) => {
      const legacyReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: legacyReplica.client,
        schemaVariant: "legacy",
      });
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: prisma17 as never,
        schemaVariant: "dedicated",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed = await seedEnvironmentLegacy(prisma14, "mollifier_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      const friendlyId = `run_${FRIENDLY_25}`; // classifies LEGACY too → routes to owning store first
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });

      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };

      // The resolver's phase-1 client: the BRANDED $replica (readYourWrites=false → replica routing).
      const brandedReplica = markReadReplicaClient({} as object);

      // HAZARD proof: the phase-1 replica read alone misses the fresh row under lag.
      const phase1Only = (await router.findRun(
        where,
        { select: { friendlyId: true } },
        brandedReplica
      )) as { friendlyId: string } | null;
      expect(phase1Only).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      // TOLERANCE proof: the full resolver pattern (replica-first, then writer-probe) resolves the run
      // despite the lagging replica, so the mutation route does NOT wrongly 404.
      const legacyReplica2 = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const legacyStore2 = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: legacyReplica2.client,
        schemaVariant: "legacy",
      });
      const router2 = new RoutingRunStore({ new: newStore, legacy: legacyStore2 });

      const resolved = await resolveViaRunStorePgReads(router2, where, brandedReplica, prisma14);
      expect(resolved).not.toBeNull();
      expect(resolved?.friendlyId).toBe(friendlyId);
      // The replica was consulted (phase 1) but the writer probe (phase 2) is what recovered the row.
      expect(legacyReplica2.wasHit()).toBe(true);
    }
  );

  heteroRunOpsPostgresTest(
    "phase-1 replica read alone resolves the run in steady state (writer probe not needed)",
    async ({ prisma14, prisma17 }) => {
      // Non-lagging: legacy store reads its real replica (prisma14 itself here as the replica handle).
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: prisma17 as never,
        schemaVariant: "dedicated",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed = await seedEnvironmentLegacy(prisma14, "mollifier_ok");
      const runId = `run_${CUID_25}`;
      const friendlyId = `run_${FRIENDLY_25}`;
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });

      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const brandedReplica = markReadReplicaClient({} as object);

      const phase1 = (await router.findRun(
        where,
        { select: { friendlyId: true } },
        brandedReplica
      )) as { friendlyId: string } | null;
      expect(phase1).not.toBeNull();
      expect(phase1?.friendlyId).toBe(friendlyId);
    }
  );
});
