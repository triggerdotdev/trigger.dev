// Replica-lag coverage for the dashboard-agent run->commit resolver read. dashboardAgent
// resolveRunCommit issues a client-less runStore.findRun({friendlyId, runtimeEnvironmentId}, {select:
// {lockedToVersionId}}) — no client, so readYourWrites() is false and the friendlyId-classified read
// routes to the owning store's REPLICA (miss => probe the other store's replica). Under lag a
// freshly-locked run is not yet visible, so findRun returns null and the resolver returns null.
//
// The stale null is tolerated: the sole consumer is a read-only resolver (the external repo-snapshot
// endpoint), where null becomes a 404 "no deployed commit" / branch-head fallback, not a mutation
// findResource guard. And the runId is dashboard-sourced (a ClickHouse view that lags more than the PG
// replica) and only carries a truthy lockedToVersionId after trigger + dequeue + lock (seconds of
// lifecycle), so by the time this read fires the PG replica has caught up — the stale-null window is
// unreachable for a run that would have returned a commit.
//
// dashboardAgent is a webapp module, so this exercises the exact underlying runStore.findRun pattern
// (same method, no-client arg, friendlyId+environment where, same select) with the owning replica
// frozen by the shared laggingReplica primitive. Asserts both the stale-null under lag and that the
// SAME read on the owning primary recovers the row's lockedToVersionId — so the null is purely replica
// lag.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

// A cuid (25 chars after the `run_` prefix) classifies LEGACY, so the friendlyId-keyed read routes
// to the legacy (control-plane) store first — the owning store for this seeded run.
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

async function seedBackgroundWorker(
  prisma: PrismaClient,
  opts: { suffix: string; organizationId: string; projectId: string; runtimeEnvironmentId: string }
) {
  return prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${opts.suffix}`,
      contentHash: `hash_${opts.suffix}`,
      version: "20260717.1",
      metadata: {},
      projectId: opts.projectId,
      runtimeEnvironmentId: opts.runtimeEnvironmentId,
    },
  });
}

function taskRunData(opts: {
  id: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
  lockedToVersionId?: string;
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
    lockedToVersionId: opts.lockedToVersionId ?? null,
  };
}

// Exactly the resolveRunCommit read: findRun keyed on {friendlyId, runtimeEnvironmentId}, selecting
// lockedToVersionId, with NO client argument. Returns the resolver's early-return decision:
// null when the run (or its lockedToVersionId) is not visible, else the version id it would resolve.
async function resolveRunCommitPgRead(
  router: RoutingRunStore,
  where: { friendlyId: string; runtimeEnvironmentId: string }
): Promise<string | null> {
  const run = (await router.findRun(where, { select: { lockedToVersionId: true } })) as {
    lockedToVersionId: string | null;
  } | null;
  if (!run?.lockedToVersionId) return null; // dashboardAgent resolveRunCommit early-return
  return run.lockedToVersionId;
}

describe("dashboardAgent resolveRunCommit — findRun (no client) reads the owning replica", () => {
  heteroRunOpsPostgresTest(
    "resolveRunCommit returns null for a fresh locked run not yet on the lagging replica (tolerated read-only fallback)",
    async ({ prisma14, prisma17 }) => {
      const legacyReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: legacyReplica.client,
        schemaVariant: "legacy",
      });
      const newReplica = laggingReplica(prisma17 as never, [{ model: "taskRun", mode: "missing" }]);
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        // Freeze the OTHER store's replica too, so the #findRunRouted miss-probe cannot mask the
        // owning-replica staleness with a phantom hit. (The row lives only on legacy anyway.)
        readOnlyPrisma: newReplica.client as never,
        schemaVariant: "dedicated",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed = await seedEnvironmentLegacy(prisma14, "dash_lag");
      const worker = await seedBackgroundWorker(prisma14, {
        suffix: "dash_lag",
        organizationId: seed.organization.id,
        projectId: seed.project.id,
        runtimeEnvironmentId: seed.environment.id,
      });
      const runId = `run_${CUID_25}`; // cuid => LEGACY owner
      const friendlyId = `run_${FRIENDLY_25}`; // classifies LEGACY too => routes to owning store first
      // The row EXISTS on the primary and is fully locked to a deployed version — resolveRunCommit
      // would return a commit for it. Only replica lag hides it.
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          lockedToVersionId: worker.id,
        }),
      });

      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };

      // HAZARD proof: the caller's read (no client => replica route) misses the fresh row under lag.
      const underLag = await resolveRunCommitPgRead(router, where);
      expect(underLag).toBeNull();
      // Prove it actually consulted the owning (legacy) replica — i.e. it is replica-routed, and the
      // null is replica lag, not a routing accident.
      expect(legacyReplica.wasHit()).toBe(true);

      // GROUND TRUTH: the SAME logical read against a healthy store (replica caught up) resolves the
      // locked version id — so the null above is PURELY replica lag, and a route-to-primary would
      // recover it. The caller tolerates the transient null (read-only 404 / branch-head fallback), so
      // the property holds without any primary re-read.
      const healthyLegacy = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14, // caught-up replica
        schemaVariant: "legacy",
      });
      const healthyRouter = new RoutingRunStore({ new: newStore, legacy: healthyLegacy });
      const resolved = await resolveRunCommitPgRead(healthyRouter, where);
      expect(resolved).toBe(worker.id);
    }
  );

  heteroRunOpsPostgresTest(
    "resolveRunCommit resolves the locked version id from the replica in steady state",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14, // caught-up replica handle
        schemaVariant: "legacy",
      });
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: prisma17 as never,
        schemaVariant: "dedicated",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed = await seedEnvironmentLegacy(prisma14, "dash_ok");
      const worker = await seedBackgroundWorker(prisma14, {
        suffix: "dash_ok",
        organizationId: seed.organization.id,
        projectId: seed.project.id,
        runtimeEnvironmentId: seed.environment.id,
      });
      const runId = `run_${CUID_25}`;
      const friendlyId = `run_${FRIENDLY_25}`;
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          lockedToVersionId: worker.id,
        }),
      });

      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const resolved = await resolveRunCommitPgRead(router, where);
      expect(resolved).toBe(worker.id);
    }
  );
});
