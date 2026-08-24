// Property: the four run-store reads issued by the AI-session + batch DASHBOARD presenters behave
// correctly under replica lag. Each passes the webapp's BRANDED `$replica` (markReadReplicaClient) into
// the run store; a branded replica makes the routing store's `#ownPrimary(store, client)` return
// undefined, so every leg reads the OWNING store's REPLICA (no primary escalation). Under lag each read
// misses a row present on the owning primary. Real split topology via heteroRunOpsPostgresTest; the
// branded arg is `markReadReplicaClient({})`, whose object is never forwarded across DBs — only its
// BRAND is read, exactly as in production.
//
// Reads covered (one case each):
//   1. SessionListPresenter findRuns (id-set fan-out, each leg owning REPLICA). Consumer builds
//      `runById` and emits `currentRunFriendlyId`. A miss drops the row → the link is simply undefined,
//      presenter returns normally. Display-view omission on an env-scoped list that revalidates.
//      Tolerated.
//   2. SessionPresenter findRuns (id-set fan-out, each leg owning REPLICA). Consumer maps each
//      sessionRun to `run: run ? {...} : null`. A miss yields `run: null` for that history row — the
//      detail page still renders. Display GET view, no throw. Tolerated.
//   3. SessionPresenter findRun currentRun fallback (id-classified → owning REPLICA, then fan-out).
//      The `runsById.get(currentRunId) ?? findRun(...)` fallback. A miss yields `currentRun: null` —
//      the detail page renders with no current run highlighted until revalidation. Tolerated.
//   4. BatchPresenter findBatchTaskRunByFriendlyId (env-scoped friendlyId fan-out, each leg owning
//      REPLICA). findBatchTaskRunByFriendlyId defaults to `this.readOnlyPrisma` — the lone batch-family
//      read that defaults to the replica; findBatchTaskRunById and findBatchTaskRunByIdempotencyKey
//      default to `this.prisma` (primary). On a bare null the presenter throws `Error("Batch not found")`
//      → a 400 error page. This case pins the desired property: a LIVE batch's detail resolves under lag
//      via a primary re-read (recovered below on the owning primary).
//
// Method: build the router as the webapp holds it, seed on the owning LEGACY primary, freeze the owning
// LEGACY replica with the shared laggingReplica, invoke each read with the EXACT caller's args + the
// branded replica client, assert the under-lag behavior, then prove the row is recoverable on the owning
// PRIMARY (unbranded writer → #ownPrimary → owning primary) so the null is purely replica lag + replica
// routing, not a missing row or bad query.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import { markReadReplicaClient } from "./readReplicaClient.js";
import type { CreateRunInput } from "./types.js";

// A cuid (25 chars after the id prefix) classifies LEGACY, so create + read both route to the legacy
// (control-plane) store first — the store that owns these session/run/batch rows in production.
const CUID_25 = "c".repeat(25);

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

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "EXECUTING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "EXECUTING",
      description: "Run is executing",
      runStatus: "EXECUTING",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

// Build the router the way the webapp holds it, with the LEGACY (control-plane) replica FROZEN for the
// given models (mode "missing" — the just-written row has not replicated). NEW is non-lagging + empty.
function buildRouter(
  prisma14: PrismaClient,
  prisma17: RunOpsPrismaClient,
  frozenModels: readonly ("taskRun" | "batchTaskRun")[]
) {
  const legacyReplica = laggingReplica(
    prisma14,
    frozenModels.map((model) => ({ model, mode: "missing" as const }))
  );
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

describe("session and batch presenter read-views under replica lag", () => {
  // SessionListPresenter findRuns (branded $replica) — tolerated.
  heteroRunOpsPostgresTest(
    "SessionListPresenter findRuns returns empty under replica lag, dropping the currentRunFriendlyId link",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouter(prisma14, prisma17, ["taskRun"]);
      const seed = await seedEnvironmentLegacy(prisma14, "sesslist");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      const friendlyId = "run_sesslist_current";
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      const brandedReplica = markReadReplicaClient({} as object);
      const args = {
        where: {
          id: { in: [runId] },
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        },
        select: { id: true, friendlyId: true },
      } as const;

      // Under lag the owning-replica id-set fan-out misses → empty list.
      const underLag = (await router.findRuns(args, brandedReplica)) as Array<{
        id: string;
        friendlyId: string;
      }>;
      expect(underLag).toEqual([]);
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      // TOLERANCE: the consumer's map lookup — a missing row just yields an undefined link, no throw.
      const runById = new Map(underLag.map((r) => [r.id, r] as const));
      const currentRunFriendlyId = runById.get(runId)?.friendlyId;
      expect(currentRunFriendlyId).toBeUndefined();

      // ROUTING proof (replica, not primary): the unbranded WRITER forces the owning primary and finds it.
      const onPrimary = (await router.findRuns(args, prisma14 as never)) as Array<{
        id: string;
        friendlyId: string;
      }>;
      expect(onPrimary.map((r) => r.id)).toEqual([runId]);
      expect(onPrimary[0]?.friendlyId).toBe(friendlyId);
    }
  );

  // SessionPresenter findRuns (branded $replica) — tolerated.
  heteroRunOpsPostgresTest(
    "SessionPresenter findRuns returns empty under replica lag, rendering run:null for the history row",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouter(prisma14, prisma17, ["taskRun"]);
      const seed = await seedEnvironmentLegacy(prisma14, "sesshist");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      const friendlyId = "run_sesshist_row";
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      const brandedReplica = markReadReplicaClient({} as object);
      const args = {
        where: { id: { in: [runId] } },
        select: { id: true, friendlyId: true, status: true },
      } as const;

      const underLag = (await router.findRuns(args, brandedReplica)) as Array<{
        id: string;
        friendlyId: string;
        status: string;
      }>;
      expect(underLag).toEqual([]);
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      // TOLERANCE: the consumer's mapping — the history row's `run` is null, page still renders.
      const runsById = new Map(underLag.map((r) => [r.id, r] as const));
      const hydratedRow = runsById.get(runId);
      const rowRun = hydratedRow
        ? { friendlyId: hydratedRow.friendlyId, status: hydratedRow.status }
        : null;
      expect(rowRun).toBeNull();

      // ROUTING proof: WRITER → owning primary → hydrated.
      const onPrimary = (await router.findRuns(args, prisma14 as never)) as Array<{
        id: string;
        friendlyId: string;
        status: string;
      }>;
      expect(onPrimary.map((r) => r.id)).toEqual([runId]);
      expect(onPrimary[0]?.status).toBe("EXECUTING");
    }
  );

  // SessionPresenter findRun currentRun fallback (branded $replica) — tolerated.
  heteroRunOpsPostgresTest(
    "SessionPresenter findRun currentRun fallback returns null under replica lag, emitting currentRun:null",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouter(prisma14, prisma17, ["taskRun"]);
      const seed = await seedEnvironmentLegacy(prisma14, "currun");
      const currentRunId = `run_${CUID_25}`; // cuid → LEGACY
      const friendlyId = "run_currun";
      await legacyStore.createRun(
        buildCreateRunInput({
          runId: currentRunId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      const brandedReplica = markReadReplicaClient({} as object);

      // The EXACT fallback read: { id }, select {id,friendlyId,status}, branded $replica.
      const underLag = (await router.findRun(
        { id: currentRunId },
        { select: { id: true, friendlyId: true, status: true } },
        brandedReplica
      )) as { id: string; friendlyId: string; status: string } | null;

      // Replica-routed (id-classified → owning legacy replica, then other-store probe) → null under lag.
      expect(underLag).toBeNull();
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      // TOLERANCE: the consumer's emit — currentRun is null, detail page still renders.
      const currentRun = underLag
        ? { friendlyId: underLag.friendlyId, status: underLag.status }
        : null;
      expect(currentRun).toBeNull();

      // ROUTING proof: WRITER → readYourWrites → owning primary (findRunOnPrimary) → found.
      const onPrimary = (await router.findRun(
        { id: currentRunId },
        { select: { id: true, friendlyId: true, status: true } },
        prisma14 as never
      )) as { id: string; friendlyId: string; status: string } | null;
      expect(onPrimary).not.toBeNull();
      expect(onPrimary!.id).toBe(currentRunId);
      expect(onPrimary!.friendlyId).toBe(friendlyId);
    }
  );

  // BatchPresenter findBatchTaskRunByFriendlyId (branded $replica) — recovers via primary re-read.
  heteroRunOpsPostgresTest(
    "BatchPresenter findBatchTaskRunByFriendlyId resolves a live batch under replica lag",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouter(prisma14, prisma17, [
        "batchTaskRun",
      ]);
      const seed = await seedEnvironmentLegacy(prisma14, "batchview");
      const batchId = `batch_${CUID_25}`; // cuid → LEGACY
      const batchFriendlyId = "batch_batchview";
      await legacyStore.createBatchTaskRun({
        id: batchId,
        friendlyId: batchFriendlyId,
        runtimeEnvironmentId: seed.environment.id,
      });

      const brandedReplica = markReadReplicaClient({} as object);

      // The EXACT read: friendlyId + environmentId + include, branded $replica.
      const underLag = await router.findBatchTaskRunByFriendlyId(
        batchFriendlyId,
        seed.environment.id,
        { include: { errors: true } },
        brandedReplica as never
      );

      // Store fact: findBatchTaskRunByFriendlyId defaults to `this.readOnlyPrisma`, so through the
      // router (branded → #ownPrimary undefined) BOTH legs read their replica. Under lag → null.
      expect(underLag).toBeNull();
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(true);

      // On a bare null the presenter's guard throws "Batch not found" (→ a 400 error page from the route
      // loader) for a batch ALIVE on the owning primary — reproduced here on the stale null.
      expect(() => {
        if (!underLag) {
          throw new Error("Batch not found");
        }
      }).toThrowError("Batch not found");

      // The property: the row EXISTS on the owning primary — reading it there (unbranded WRITER →
      // #ownPrimary → owning primary) returns the live batch, so the primary re-read resolves the detail.
      const onPrimary = await router.findBatchTaskRunByFriendlyId(
        batchFriendlyId,
        seed.environment.id,
        { include: { errors: true } },
        prisma14 as never
      );
      expect(onPrimary).not.toBeNull();
      expect(onPrimary!.id).toBe(batchId);
      expect(onPrimary!.friendlyId).toBe(batchFriendlyId);
    }
  );
});
