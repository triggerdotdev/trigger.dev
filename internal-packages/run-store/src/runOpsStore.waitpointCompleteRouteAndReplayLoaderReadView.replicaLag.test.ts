// Coverage for two dashboard read call sites:
//
//   complete-waitpoint route (dashboard "Complete waitpoint" action)
//     runStore.findWaitpoint({ select: { projectId, environmentId }, where: { id } })   (no client)
//   replay loader (renders the Replay dialog)
//     runStore.findRun({ friendlyId }, { select: {...} })                               (no client)
//
// Both pass NO client, so per the per-method default they route to the OWNING store's REPLICA (a `{ id }`
// waitpoint lookup even resolves its owning store via a replica probe first — #resolveWaitpointStore(id,
// onPrimary=false) — so a not-yet-replicated row is invisible on BOTH the resolution probe and the read).
// The owning replica is frozen with the shared laggingReplica on the REAL split topology
// (heteroRunOpsPostgresTest — NEVER mocked); each case asserts exactly what the caller sees.
//
// The complete-waitpoint route GATES a mutation in the SAME request:
//     const waitpoint = await runStore.findWaitpoint({ ..., where: { id } });
//     if (waitpoint?.projectId !== project.id) return "No waitpoint found";
//     ... engine.completeWaitpoint({ id })   // the write
// Under lag the replica read is null (the first leg). A bare null makes `undefined !== project.id` true,
// which would return "No waitpoint found" for a waitpoint present on the primary. So on a null read the
// route re-reads the owning primary via runStore.findWaitpointOnPrimary({ where: { id } }) before
// deciding. The test pins both legs: the replica read is null, and the owning-primary re-read resolves
// the same waitpoint.
//
// The replay loader read is a tolerated read-view: it only renders a form; on a miss it falls through to
// the mollifier buffer and finally a 404 the user retries. It drives NO write and no decision on stale
// data — eventual consistency is the intended contract for opening a dialog for an (already-existing,
// historical) run. The consequential write path (the replay ACTION) has its OWN primary re-read, so a
// stale loader render never causes a wrong replay. The test asserts the store-level fact (null under
// lag, replica hit) AND proves the run exists on the primary (so the null is pure lag, not absence).

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

const CUID_25 = "e".repeat(25); // cuid id-shape -> LEGACY (#legacy / prisma14, full schema)

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

// Build a LEGACY-owning router whose legacy replica is frozen (lagging); the NEW store is real
// (non-lagging) so the on-miss fan-out to the other store's replica also legitimately misses.
function buildRouterWithLaggingLegacyReplica(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyReplica = laggingReplica(prisma14, [
    { model: "taskRun", mode: "missing" },
    { model: "waitpoint", mode: "missing" },
  ]);
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
  return { router, legacyStore, legacyReplica };
}

// Seed a standalone, still-PENDING MANUAL token waitpoint on the WRITER (exactly as minting a resume
// token does). The complete route looks it up by id right after; under replica lag that read misses.
async function seedPendingTokenWaitpoint(
  store: PostgresRunStore,
  params: { id: string; friendlyId: string; projectId: string; environmentId: string }
) {
  await store.upsertWaitpoint({
    where: {
      environmentId_idempotencyKey: {
        environmentId: params.environmentId,
        idempotencyKey: params.id,
      },
    },
    create: {
      id: params.id,
      friendlyId: params.friendlyId,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: params.id,
      userProvidedIdempotencyKey: false,
      projectId: params.projectId,
      environmentId: params.environmentId,
    },
    update: {},
  });
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

// The exact projection the complete route reads to run its project/env auth guard.
const COMPLETE_WAITPOINT_SELECT = { projectId: true, environmentId: true } as const;

// The loader's source-run projection, subset that exists on both variants.
const REPLAY_LOADER_SELECT = {
  payload: true,
  payloadType: true,
  runtimeEnvironmentId: true,
  projectId: true,
  taskIdentifier: true,
} as const;

describe("waitpoint-complete route + replay loader read-view under replica lag", () => {
  // ── complete-waitpoint route ────────────────────────────────────────────────────────────────────
  // findWaitpoint(no client) → owning REPLICA. Under lag it returns null (the first leg); a bare null
  // makes the auth guard `waitpoint?.projectId !== project.id` refuse a real waitpoint with
  // "No waitpoint found". So the route re-reads the owning primary (findWaitpointOnPrimary), which
  // resolves the same waitpoint.
  heteroRunOpsPostgresTest(
    "complete-waitpoint route findWaitpoint is stale-null under replica lag and resolves on the primary re-read",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouterWithLaggingLegacyReplica(
        prisma14,
        prisma17
      );
      const seed = await seedEnvironmentLegacy(prisma14, "wpcomplete_leg");
      const waitpointId = `waitpoint_${CUID_25}`; // cuid → LEGACY
      await seedPendingTokenWaitpoint(legacyStore, {
        id: waitpointId,
        friendlyId: "waitpoint_wpcomplete_leg",
        projectId: seed.project.id,
        environmentId: seed.environment.id,
      });

      // The EXACT complete-route read: select {projectId, environmentId}, where {id}, NO client.
      const fromReplica = await router.findWaitpoint({
        select: COMPLETE_WAITPOINT_SELECT,
        where: { id: waitpointId },
      });

      // Store seam: the owning replica lags → null. This is precisely what drives the route to fail:
      //   (fromReplica?.projectId !== project.id)  ==  (undefined !== <real project id>)  ==  true
      // → "No waitpoint found", and engine.completeWaitpoint is never called. The waitpoint exists.
      expect(fromReplica).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);
      // Reproduce the route's guard evaluation on the stale value: it wrongly fails.
      const guardFailsUnderLag = fromReplica?.projectId !== seed.project.id;
      expect(guardFailsUnderLag).toBe(true);

      // The route re-reads the owning primary on the miss. It finds the waitpoint, its projectId
      // matches, and the guard passes — the completion proceeds.
      const fromPrimary = await router.findWaitpointOnPrimary({
        select: COMPLETE_WAITPOINT_SELECT,
        where: { id: waitpointId },
      });
      expect(fromPrimary).not.toBeNull();
      expect(fromPrimary!.projectId).toBe(seed.project.id);
      expect(fromPrimary!.environmentId).toBe(seed.environment.id);
    }
  );

  // ── replay loader (tolerated read-view) ──────────────────────────────────────────────────────────
  // loader findRun(no client) → owning REPLICA. Under lag it returns null. Unlike the complete-waitpoint
  // route above, this drives NO write and no decision on stale data: on a null the loader tries the
  // mollifier buffer then 404s and the user retries; the consequential replay ACTION re-reads the
  // primary on its own. So a stale loader render is safe. We assert the store-level fact (null + replica
  // hit) AND prove the run truly exists on the primary — the null is pure lag, tolerated by a display
  // render.
  heteroRunOpsPostgresTest(
    "replay loader findRun is null under replica lag while the run exists on the primary",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica } = buildRouterWithLaggingLegacyReplica(prisma14, prisma17);
      const seed = await seedEnvironmentLegacy(prisma14, "replayloader_leg");
      const runId = `run_${CUID_25}`;
      const friendlyId = "run_replayloader_leg";
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });

      // The EXACT loader read: findRun by friendlyId with the display select, NO client → owning replica.
      const fromReplica = await router.findRun({ friendlyId }, { select: REPLAY_LOADER_SELECT });
      expect(fromReplica).toBeNull(); // loader falls to the buffer / 404 (no write is driven)
      expect(legacyReplica.wasHit()).toBe(true);

      // Prove the null is lag, not absence: the run is on the primary. The loader tolerates the stale
      // miss because it only renders a dialog; the replay ACTION guards its write with its own primary
      // re-read, so eventual consistency of this display read is correct-by-design.
      const fromPrimary = await router.findRun(
        { friendlyId },
        { select: REPLAY_LOADER_SELECT },
        prisma14
      );
      expect(fromPrimary).not.toBeNull();
      expect((fromPrimary as { projectId: string }).projectId).toBe(seed.project.id);
      expect((fromPrimary as { taskIdentifier: string }).taskIdentifier).toBe("my-task");
    }
  );
});
