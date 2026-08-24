// Replica-lag coverage for the REPLAY route's source-run reads. The loader, resolveRunOrganizationId,
// and the action all call runStore.findRun({ friendlyId }) with NO client, so the read routes to the
// owning store's REPLICA (fan-out to the other store's replica on a miss). Passing the control-plane
// WRITER instead escalates to findRunOnPrimary (read-your-writes).
//
// The route is a Remix loader/action not unit-testable with an injected store here, so we exercise the
// exact findRun pattern each caller uses against a real split topology with the owning replica frozen.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / prisma14, full schema)

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
    status: "COMPLETED_SUCCESSFULLY" as const,
    friendlyId: opts.friendlyId,
    runtimeEnvironmentId: opts.runtimeEnvironmentId,
    environmentType: "DEVELOPMENT" as const,
    organizationId: opts.organizationId,
    projectId: opts.projectId,
    taskIdentifier: "my-task",
    payload: JSON.stringify({ hello: "world" }),
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

// Build a LEGACY-owning router whose legacy replica is frozen (lagging), and a real (non-lagging) NEW
// store so the on-miss fan-out to the other store's replica also misses. Returns the router + a probe.
function buildRouterWithLaggingLegacyReplica(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
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
  return { router, legacyReplica };
}

// The replay route reads the source run keyed by friendlyId (runParam) — mirror that exactly.
const REPLAY_SELECT = {
  payload: true,
  payloadType: true,
  runtimeEnvironmentId: true,
  projectId: true,
  taskIdentifier: true,
} as const;

describe("replay route source-run reads under replica lag (findRun by friendlyId)", () => {
  // The action does `runStore.findRun({ friendlyId })` with NO client, so the read routes to the
  // lagging replica and MISSES; its only miss-handler is the mollifier buffer, so once the buffered
  // run has drained to the primary but not the replica the action would fall through to "Run not
  // found" for a run that exists on the primary. Passing the control-plane WRITER (like
  // resolveRunOrganizationId's primary fallback) makes the read resolve the fresh run.
  heteroRunOpsPostgresTest(
    "action read (no client) hits the lagging replica and MISSES a run that exists on the primary",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedEnvironmentLegacy(prisma14, "replay_action");
      const runId = `run_${CUID_25}`;
      const friendlyId = "run_replay_action";
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });

      // Exactly the action's call: findRun({ friendlyId }) with NO client → owning store's replica,
      // then fan-out to the other store's replica. Both miss under lag → null → "Run not found".
      const { router, legacyReplica } = buildRouterWithLaggingLegacyReplica(prisma14, prisma17);
      const viaReplica = await router.findRun({ friendlyId });
      expect(viaReplica).toBeNull(); // replica misses; the action re-reads the primary
      expect(legacyReplica.wasHit()).toBe(true);

      // The action passes the control-plane WRITER (like resolveRunOrganizationId's primary fallback)
      // → resolves the fresh run on the owning primary, never the replica.
      const { router: routerPrimary, legacyReplica: legacyReplicaPrimary } =
        buildRouterWithLaggingLegacyReplica(prisma14, prisma17);
      const viaPrimary = await routerPrimary.findRun({ friendlyId }, prisma14);
      expect(viaPrimary).not.toBeNull();
      expect((viaPrimary as { friendlyId: string }).friendlyId).toBe(friendlyId);
      expect(legacyReplicaPrimary.wasHit()).toBe(false);
    }
  );

  // resolveRunOrganizationId reads the replica first (misses under lag), checks the buffer, then FALLS
  // BACK to the primary via `runStore.findRun(..., prisma)`. This documents that the primary-fallback
  // leg resolves the run (and thus runtimeEnvironmentId → organizationId for the RBAC scope) even when
  // the replica is frozen and the buffer is drained.
  heteroRunOpsPostgresTest(
    "resolveRunOrganizationId: replica leg misses under lag, primary-fallback leg resolves the run",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedEnvironmentLegacy(prisma14, "replay_org");
      const runId = `run_${CUID_25}`;
      const friendlyId = "run_replay_org";
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });

      const { router, legacyReplica } = buildRouterWithLaggingLegacyReplica(prisma14, prisma17);

      // Leg 1 (the route's first read): replica, no client → miss under lag.
      const replicaLeg = await router.findRun(
        { friendlyId },
        { select: { runtimeEnvironmentId: true } }
      );
      expect(replicaLeg).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      // Leg 2 (the route's primary fallback): findRun(..., prisma) → findRunOnPrimary resolves the
      // run so the org scope is never left unresolved under replica lag.
      const primaryLeg = await router.findRun(
        { friendlyId },
        { select: { runtimeEnvironmentId: true } },
        prisma14
      );
      expect(primaryLeg).not.toBeNull();
      expect((primaryLeg as { runtimeEnvironmentId: string }).runtimeEnvironmentId).toBe(
        seed.environment.id
      );
    }
  );

  // The loader read is a read-view, included only to document the routing (no staleness assertion).
  // The loader renders the replay DIALOG from the source run; on a replica miss it uses the mollifier
  // buffer, else the user retries. Eventual consistency is the intended contract for rendering a form
  // for an (already-existing, historical) run — it drives no write. Kept here so the full group of
  // replay reads is represented; the primary-logic coverage is the two cases above.
  heteroRunOpsPostgresTest(
    "loader read (no client) routes to the replica (read-view — documents routing only)",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedEnvironmentLegacy(prisma14, "replay_loader");
      const runId = `run_${CUID_25}`;
      const friendlyId = "run_replay_loader";
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });

      const { router, legacyReplica } = buildRouterWithLaggingLegacyReplica(prisma14, prisma17);
      await router.findRun({ friendlyId }, { select: REPLAY_SELECT });
      // No client → the loader's read went to the replica, as designed for a display read.
      expect(legacyReplica.wasHit()).toBe(true);
    }
  );
});
