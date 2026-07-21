// Lagging-replica coverage for the REALTIME-SERVICES read views on the run-ops split. Five run lookups
// feed realtime session/feed serialization; none is a read-your-writes mutation gate — each resolves an
// id/friendlyId for DISPLAY and tolerates a stale/missing read by construction. This file freezes the
// OWNING store's replica via laggingReplica, invokes each read EXACTLY as its caller does (same method +
// client arg), and asserts the concrete under-lag value plus a primary re-read that recovers the row (so
// the null/empty is provably lag-induced). No-client and branded-$replica reads both stay on the owning
// replica; a writer/tx read escalates to the primary. Real split topology via heteroRunOpsPostgresTest — NEVER mocked.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import { markReadReplicaClient } from "./readReplicaClient.js";
import type { CreateRunInput } from "./types.js";

// ownerEngine (classifyResidency) routes a run-ops v1 body → NEW, everything else → LEGACY.
// These sites all resolve pre-existing session/feed runs; LEGACY-resident cuid runs exercise the
// owning-store-first → other-store fan-out on the control-plane DB, the common realtime residency.
const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / prisma14, full schema)

async function seedEnvironment(prisma: PrismaClient, slugSuffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${slugSuffix}`, slug: `org-${slugSuffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${slugSuffix}`,
      slug: `project-${slugSuffix}`,
      externalRef: `proj_${slugSuffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slugSuffix}`,
      pkApiKey: `pk_dev_${slugSuffix}`,
      shortcode: `short_${slugSuffix}`,
    },
  });
  return { organization, project, environment };
}

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  taskIdentifier: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: params.taskIdentifier,
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: "trace_1",
      spanId: "span_1",
      runTags: ["alpha", "beta"],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

// Build the router the way the realtime services hold it: a LEGACY store on the control-plane DB
// whose replica LAGS, plus a fresh NEW store. Returns the router + the seeded run + the lagging
// replica probe. All five sites resolve a LEGACY-resident (cuid) run, so the owning store is LEGACY
// and its frozen replica is the one the read hits.
async function setupLaggingLegacy(
  prisma14: PrismaClient,
  prisma17: RunOpsPrismaClient,
  slug: string
) {
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

  const seed = await seedEnvironment(prisma14, slug);
  const runId = `run_${CUID_25}`; // cuid → LEGACY
  const friendlyId = `run_${slug}`;
  await legacyStore.createRun(
    buildCreateRunInput({
      runId,
      friendlyId,
      taskIdentifier: "my-task",
      organizationId: seed.organization.id,
      projectId: seed.project.id,
      runtimeEnvironmentId: seed.environment.id,
    })
  );

  return { router, legacyReplica, seed, runId, friendlyId };
}

// The webapp always passes its $replica handle, which is markReadReplicaClient()'d.
// A branded client tells RoutingRunStore "do not escalate to primary" — so the read stays on the
// owning store's own replica. We pass a branded stand-in exactly as the hydrator/session manager do;
// its identity is irrelevant because the router discards it and reads the owning store's readOnlyPrisma.
const BRANDED_REPLICA = markReadReplicaClient({}) as never;

describe("run-ops split — realtime-services read views vs. a lagging replica", () => {
  // --- hydrateByIds findRuns (runReader) ---------------------------------------------------------
  // The realtime feed hydrates a ClickHouse-resolved id-set for DISPLAY, passing $replica. Under lag
  // the owning replica returns no rows. Tolerated: the id-set is sourced from ClickHouse, which lags
  // the Postgres replica by MORE (an id can't appear in CH before it is on the PG replica), and wake
  // hydrates are additionally held by the envChangeRouter replica-lag gate; a row missed on one
  // hydrate tick reappears on the next. hydrateByIds returns whatever rows exist — a missing row is
  // simply absent from the feed frame, never a wrong value. Store fact under lag: [].
  heteroRunOpsPostgresTest(
    "hydrateByIds findRuns(branded $replica) is empty under owning-replica lag; primary re-read hydrates the row",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, runId, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rr_hydrate"
      );

      // Exactly the hydrateByIds read — where {runtimeEnvironmentId, id:{in}}, select, $replica.
      const staleRows = await router.findRuns(
        {
          where: {
            runtimeEnvironmentId: seed.environment.id,
            id: { in: [runId] },
          },
          select: { id: true, friendlyId: true, status: true },
        },
        BRANDED_REPLICA
      );
      expect(staleRows).toEqual([]);
      expect(legacyReplica.wasHit()).toBe(true);

      // The row IS on the primary — a writer-client read (escalates to owning primary) hydrates it.
      const primaryRows = await router.findRuns(
        {
          where: {
            runtimeEnvironmentId: seed.environment.id,
            id: { in: [runId] },
          },
          select: { id: true, friendlyId: true, status: true },
        },
        prisma14 as never
      );
      expect(primaryRows).toHaveLength(1);
      expect(primaryRows[0]!.friendlyId).toBe(friendlyId);
    }
  );

  // --- #fetch / getRunById findRun (runReader) ---------------------------------------------------
  // Single-run hydrate for the feed, passing $replica. Under lag the owning replica (then the
  // cross-store fan-out on miss) returns null. Tolerated: RunHydror.getRunById caches a null hit for
  // only cacheTtlMs (250ms default) and the feed re-fetches; #fetch returns (run ?? null) — a null is
  // "not yet visible", rendered as an absent frame in a read-only display feed, never a decision.
  // Store fact under lag: null.
  heteroRunOpsPostgresTest(
    "#fetch findRun(branded $replica) is null under owning-replica lag; primary re-read finds the row",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, runId, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rr_fetch"
      );

      // Exactly the #fetch read — where {id, runtimeEnvironmentId}, select, $replica.
      const stale = await router.findRun(
        { id: runId, runtimeEnvironmentId: seed.environment.id },
        { select: { id: true, friendlyId: true, status: true } },
        BRANDED_REPLICA
      );
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      const primary = await router.findRun(
        { id: runId, runtimeEnvironmentId: seed.environment.id },
        { select: { id: true, friendlyId: true, status: true } },
        prisma14 as never
      );
      expect(primary).not.toBeNull();
      expect((primary as { friendlyId: string }).friendlyId).toBe(friendlyId);
    }
  );

  // --- resolveRunFriendlyId findRun (sessionRunManager) ------------------------------------------
  // Resolves a run cuid → friendlyId for `payload.previousRunId`, passing $replica. Under lag the
  // read is null. Tolerated: the caller is `return row?.friendlyId ?? runId` — on a null it falls back
  // to the cuid, and previousRunId is customer-visible bookkeeping only, so a stale-but-non-null value
  // is acceptable degraded behavior. Store fact under lag: null → caller returns the cuid.
  heteroRunOpsPostgresTest(
    "resolveRunFriendlyId findRun(branded $replica) is null under lag; caller falls back to the cuid",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, runId, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "srm_resolve"
      );

      // Exactly the resolveRunFriendlyId read — where {id}, select {friendlyId}, $replica.
      const stale = await router.findRun(
        { id: runId },
        { select: { friendlyId: true } },
        BRANDED_REPLICA
      );
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      // The caller's tolerance, exercised: `row?.friendlyId ?? runId`.
      const resolved = (stale as { friendlyId: string } | null)?.friendlyId ?? runId;
      expect(resolved).toBe(runId); // degraded: the cuid, not the friendlyId

      // Proof the row exists on the primary (writer read would have returned the friendlyId).
      const primary = await router.findRun(
        { id: runId },
        { select: { friendlyId: true } },
        prisma14 as never
      );
      expect((primary as { friendlyId: string }).friendlyId).toBe(friendlyId);
    }
  );

  // --- serializeSessionWithFriendlyRunId findRun (sessions) --------------------------------------
  // Resolves Session.currentRunId (internal cuid) → friendlyId for single-row session responses,
  // NO client → owning replica. Under lag the read is null. Tolerated: serialized on GET/PATCH/close
  // routes over a PRE-EXISTING currentRunId (the PATCH never writes currentRunId — the pointer was
  // written by an earlier append), so this is a read-only display resolve, not a same-request
  // read-your-writes. The caller is `currentRunId: run?.friendlyId ?? null`: null is the SAFE degraded
  // direction, and the tenant-scoped where {projectId, runtimeEnvironmentId} guarantees a stale read
  // never mis-resolves a run in another env. The client re-fetches. Store fact under lag: null.
  heteroRunOpsPostgresTest(
    "serializeSessionWithFriendlyRunId findRun(no client) is null under lag → currentRunId null",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, runId, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "sess_one"
      );

      // Exactly the serializeSessionWithFriendlyRunId read — where {id, projectId, runtimeEnvironmentId}, select, NO client.
      const stale = await router.findRun(
        {
          id: runId,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        },
        { select: { friendlyId: true } }
      );
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      // Caller tolerance, exercised.
      const currentRunId = (stale as { friendlyId: string } | null)?.friendlyId ?? null;
      expect(currentRunId).toBeNull();

      // Proof the row exists on the primary.
      const primary = await router.findRun(
        {
          id: runId,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        },
        { select: { friendlyId: true } },
        prisma14 as never
      );
      expect((primary as { friendlyId: string }).friendlyId).toBe(friendlyId);
    }
  );

  // --- serializeSessionsWithFriendlyRunIds findRuns (sessions) -----------------------------------
  // Batched currentRunId → friendlyId resolve for the session LIST endpoint, NO client → owning
  // replica. Under lag the id-set read returns no rows. Tolerated: same read-only display resolve of
  // pre-existing pointers as the single-session case above, batched. The caller is
  // `friendlyIdByRunId.get(session.currentRunId) ?? null` over a Map built only from rows that came
  // back, so a missing run serializes currentRunId=null — the safe degraded direction. The where is
  // tenant-scoped {projectId, runtimeEnvironmentId}, so a stale id never resolves a run in another env.
  // Store fact under lag: [] → empty map → currentRunId null.
  heteroRunOpsPostgresTest(
    "serializeSessionsWithFriendlyRunIds findRuns(no client) is empty under lag → currentRunId null",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, runId, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "sess_list"
      );

      // Exactly the serializeSessionsWithFriendlyRunIds read — where {id:{in}, projectId, runtimeEnvironmentId}, select, NO client.
      const staleRuns = await router.findRuns({
        where: {
          id: { in: [runId] },
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        },
        select: { id: true, friendlyId: true },
      });
      expect(staleRuns).toEqual([]);
      expect(legacyReplica.wasHit()).toBe(true);

      // Caller tolerance, exercised.
      const friendlyIdByRunId = new Map(
        (staleRuns as Array<{ id: string; friendlyId: string }>).map((r) => [r.id, r.friendlyId])
      );
      const currentRunId = friendlyIdByRunId.get(runId) ?? null;
      expect(currentRunId).toBeNull();

      // Proof the row exists on the primary.
      const primaryRuns = await router.findRuns(
        {
          where: {
            id: { in: [runId] },
            projectId: seed.project.id,
            runtimeEnvironmentId: seed.environment.id,
          },
          select: { id: true, friendlyId: true },
        },
        prisma14 as never
      );
      expect(primaryRuns).toHaveLength(1);
      expect((primaryRuns as Array<{ friendlyId: string }>)[0]!.friendlyId).toBe(friendlyId);
    }
  );
});
