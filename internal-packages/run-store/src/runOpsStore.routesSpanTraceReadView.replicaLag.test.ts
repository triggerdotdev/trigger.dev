// Lagging-replica coverage for the SPAN-DETAIL / TRACE / TRACE-SYNC route read views on the run-ops
// split. Four run lookups back three GET routes; NONE is a read-your-writes mutation gate — every one
// resolves a run for a DISPLAY/GET response and tolerates a stale/missing read by a named caller
// mechanism. This builds the store as each route holds it (`runStore` via a RoutingRunStore), freezes
// the OWNING store's replica with the shared laggingReplica primitive, invokes each read EXACTLY as
// the caller does (same method + branded-$replica client arg + where/select), and asserts the
// under-lag value AND that the SAME read against a caught-up replica recovers the row — so the
// null/empty is provably lag-induced, not a routing accident or true absence.
//
// Routing recap (against runOpsStore.ts on this branch):
//   findRun/findRuns with NO client          → owning store's REPLICA.
//   findRun/findRuns with a BRANDED $replica → stays on the owning REPLICA (a read-replica brand is
//       not a write signal). The webapp `$replica` handle is markReadReplicaClient()'d, so passing it
//       is routing-equivalent to passing no client.
//   findRun/findRuns with a WRITER/tx        → owning store's PRIMARY (read-your-writes escalation).
// The routing store never forwards the client across DBs; only its brand/presence is read, so the
// branded stand-in below (markReadReplicaClient({})) faithfully reproduces the webapp arg.
//
// Reads covered (all read the owning REPLICA; each case names the exact tolerance mechanism):
//   1. spans.$spanId findRun({friendlyId, runtimeEnvironmentId}) — classifiable → routed lookup
//      (owning replica, miss-probe the other store).
//   2. spans.$spanId findRuns({where:{runtimeEnvironmentId, parentSpanId}, take:50, select}) — open
//      predicate → both stores' replicas, merged.
//   3. trace findRun({friendlyId, runtimeEnvironmentId}) — same shape as read 1.
//   4. sync.traces findRun({traceId}, {select:{runtimeEnvironmentId}}) — unclassifiable where →
//      unrouted lookup (NEW-first then LEGACY, both replicas).
//
// Real split topology via heteroRunOpsPostgresTest — NEVER mocked. The laggingReplica primitive
// freezes findFirst/findMany/findUnique on a chosen Prisma model so a replica-routed read misses the
// just-written row (see the helper below).

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import { markReadReplicaClient } from "./readReplicaClient.js";

// A cuid (25 chars after the `run_` prefix) classifies LEGACY, so id/friendlyId-keyed reads route to
// the legacy (control-plane) store first — the owning store for the runs seeded here. Trace/span
// detail runs are overwhelmingly legacy-resident (draining DB) in the split window.
const CUID_25 = "c".repeat(25);

// The webapp passes its `$replica` handle, markReadReplicaClient()'d. Its object identity is
// irrelevant to routing (the router discards it and reads the owning store's readOnlyPrisma) — only
// the brand matters. This stand-in reproduces the arg exactly.
const BRANDED_REPLICA = markReadReplicaClient({}) as never;

async function seedEnvironment(prisma: PrismaClient, suffix: string) {
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
  traceId: string;
  spanId: string;
  parentSpanId?: string;
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
    traceId: opts.traceId,
    spanId: opts.spanId,
    parentSpanId: opts.parentSpanId ?? null,
    queue: "task/my-task",
    isTest: false,
    taskEventStore: "taskEvent",
    depth: 0,
  };
}

// Build the router the way the routes hold it: a LEGACY store on the control-plane DB whose replica
// LAGS, plus a NEW store on the (empty) dedicated DB. Also returns a HEALTHY router (identical, but
// the legacy store reads a caught-up replica handle) sharing the SAME seeded rows in prisma14, so a
// ground-truth re-read proves the under-lag null/empty is purely replica lag. The NEW store's replica
// is left un-frozen (the dedicated DB is empty), so the cross-store miss-probe returns null naturally
// and cannot mask the owning-replica staleness with a phantom hit.
function makeRouters(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
  const laggingLegacy = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: legacyReplica.client,
    schemaVariant: "legacy",
  });
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
  const laggingRouter = new RoutingRunStore({ new: newStore, legacy: laggingLegacy });

  const healthyLegacy = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14, // caught-up replica handle
    schemaVariant: "legacy",
  });
  const healthyRouter = new RoutingRunStore({ new: newStore, legacy: healthyLegacy });

  return { laggingRouter, healthyRouter, legacyReplica };
}

describe("run-ops split — span-detail / trace / trace-sync route read views vs. a lagging replica", () => {
  // --- spans.$spanId findPgRun --------------------------------------------------------------------
  // findResource resolves the run for the span-detail GET. Under lag the owning (legacy) replica
  // returns null; the route falls through to the mollifier buffer fallback and, failing that, returns
  // a retryable 404 (x-should-retry: true). The SDK re-requests, and by the retry the PG replica has
  // caught up. No mutation is guarded by this read — a replica-stale null, tolerated by
  // eventual-consistency-by-contract (retryable 404 + mollifier buffer fallback). Store fact under
  // lag: null.
  heteroRunOpsPostgresTest(
    "spans.$spanId findPgRun findRun(branded $replica) is NULL under owning-replica lag; caught-up replica recovers the run (retryable 404 + buffer fallback tolerate the stale null)",
    async ({ prisma14, prisma17 }) => {
      const { laggingRouter, healthyRouter, legacyReplica } = makeRouters(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "spans_find");
      const runId = `run_${CUID_25}`;
      const friendlyId = `run_spansfind0000000000000`;
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          traceId: "trace_spans_find",
          spanId: "span_spans_find",
        }),
      });

      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };

      // Exactly the call site: findRun(where, $replica) — no select, branded replica client.
      const stale = await laggingRouter.findRun(where, BRANDED_REPLICA);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true); // proves the read was owning-replica-routed

      // Ground truth: the SAME read against a caught-up replica resolves the run — so the null above
      // is purely replica lag. This is a read-only span-detail GET (no mutation depends on it), so the
      // tolerated stale null is the intended behaviour.
      const recovered = (await healthyRouter.findRun(where, BRANDED_REPLICA)) as {
        friendlyId: string;
      } | null;
      expect(recovered).not.toBeNull();
      expect(recovered!.friendlyId).toBe(friendlyId);
    }
  );

  // --- spans.$spanId triggeredRuns ----------------------------------------------------------------
  // The span-detail body lists the CHILD runs a span triggered (where {runtimeEnvironmentId,
  // parentSpanId}). Under lag freshly-triggered children are not yet on the owning replica, so the
  // list is empty/short. This is a DISPLAY list in a polled span-detail response — a missing child
  // simply appears on the next poll; nothing decides or mutates on it. Replica-stale empty list,
  // tolerated (display list, re-polled). Store fact under lag: [].
  heteroRunOpsPostgresTest(
    "spans.$spanId triggeredRuns findRuns(branded $replica) is EMPTY under owning-replica lag; caught-up replica lists the child run (display list, re-polled)",
    async ({ prisma14, prisma17 }) => {
      const { laggingRouter, healthyRouter, legacyReplica } = makeRouters(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "spans_children");
      const parentSpanId = "span_parent_children";
      const childId = `run_${CUID_25}`;
      const childFriendlyId = `run_spanschild00000000000`;
      await prisma14.taskRun.create({
        data: taskRunData({
          id: childId,
          friendlyId: childFriendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          traceId: "trace_spans_children",
          spanId: "span_child_children",
          parentSpanId,
        }),
      });

      const args = {
        take: 50,
        select: {
          friendlyId: true,
          taskIdentifier: true,
          status: true,
          createdAt: true,
        },
        where: {
          runtimeEnvironmentId: seed.environment.id,
          parentSpanId,
        },
      };

      // Exactly the call site: findRuns(args, $replica) — open predicate, branded replica.
      const staleRows = await laggingRouter.findRuns(args, BRANDED_REPLICA);
      expect(staleRows).toEqual([]);
      expect(legacyReplica.wasHit()).toBe(true);

      // Ground truth: the same open-predicate read against a caught-up replica lists the child.
      const recoveredRows = (await healthyRouter.findRuns(args, BRANDED_REPLICA)) as Array<{
        friendlyId: string;
      }>;
      expect(recoveredRows).toHaveLength(1);
      expect(recoveredRows[0]!.friendlyId).toBe(childFriendlyId);
    }
  );

  // --- trace findPgRun ----------------------------------------------------------------------------
  // Identical read shape to the spans.$spanId findPgRun read above but for the trace GET. findResource
  // resolves the run; a null falls through to the mollifier buffer fallback then a retryable 404. No
  // mutation is guarded. Replica-stale null, tolerated by eventual-consistency-by-contract (retryable
  // 404 + mollifier buffer fallback). Store fact under lag: null.
  heteroRunOpsPostgresTest(
    "trace route findPgRun findRun(branded $replica) is NULL under owning-replica lag; caught-up replica recovers the run (retryable 404 + buffer fallback tolerate the stale null)",
    async ({ prisma14, prisma17 }) => {
      const { laggingRouter, healthyRouter, legacyReplica } = makeRouters(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "trace_find");
      const runId = `run_${CUID_25}`;
      const friendlyId = `run_tracefind00000000000000`;
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          traceId: "trace_trace_find",
          spanId: "span_trace_find",
        }),
      });

      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };

      const stale = await laggingRouter.findRun(where, BRANDED_REPLICA);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      const recovered = (await healthyRouter.findRun(where, BRANDED_REPLICA)) as {
        friendlyId: string;
      } | null;
      expect(recovered).not.toBeNull();
      expect(recovered!.friendlyId).toBe(friendlyId);
    }
  );

  // --- sync.traces findRun ------------------------------------------------------------------------
  // The dashboard trace-sync loader resolves a run by traceId to authorize the user + resolve the
  // env, then long-polls Electric for the "TaskRun" shape. The where carries ONLY traceId
  // (unclassifiable) → unrouted lookup (NEW-first then LEGACY, both on their replicas). Under lag the
  // owning replica returns null → the loader returns a 404 "No run found". This is a live-sync loader
  // the dashboard re-establishes (long-poll); a run reaching it is user-navigation sourced and has
  // existed for seconds, so the stale-null window is transient and re-polled. Tolerated (display/sync
  // loader, re-polled; no mutation). Store fact under lag: null.
  heteroRunOpsPostgresTest(
    "sync.traces findRun(traceId, select, branded $replica) is NULL under owning-replica lag; caught-up replica recovers the run (re-polled sync loader tolerates the stale 404)",
    async ({ prisma14, prisma17 }) => {
      const { laggingRouter, healthyRouter, legacyReplica } = makeRouters(prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "trace_sync");
      const runId = `run_${CUID_25}`;
      const traceId = "trace_sync_unique";
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId: `run_tracesync00000000000000`,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          traceId,
          spanId: "span_trace_sync",
        }),
      });

      // Exactly the call site: findRun({traceId}, {select:{runtimeEnvironmentId}}, $replica).
      const stale = await laggingRouter.findRun(
        { traceId },
        { select: { runtimeEnvironmentId: true } },
        BRANDED_REPLICA
      );
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      const recovered = (await healthyRouter.findRun(
        { traceId },
        { select: { runtimeEnvironmentId: true } },
        BRANDED_REPLICA
      )) as { runtimeEnvironmentId: string } | null;
      expect(recovered).not.toBeNull();
      expect(recovered!.runtimeEnvironmentId).toBe(seed.environment.id);
    }
  );
});
