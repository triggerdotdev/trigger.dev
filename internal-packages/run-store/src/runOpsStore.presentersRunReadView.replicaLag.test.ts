// Lagging-replica coverage for seven run-detail presenter reads. Every one is a client-less (or
// branded-replica) runStore read, so RoutingRunStore serves it from the OWNING store's REPLICA. This
// proves — with the replica frozen by the shared laggingReplica primitive — what each read returns
// under lag, and names the caller mechanism that makes the stale/absent value tolerable. Builds the
// store as the webapp holds it (RoutingRunStore over a legacy + dedicated PostgresRunStore) and invokes
// each read EXACTLY as the presenter does (same method, where, and client arg — none, or a branded
// $replica).
//
// Routing recap (verified against RoutingRunStore): findRun with NO client OR a BRANDED replica has
// readYourWrites false (a branded replica does not escalate), so it reads the owning store's
// readOnlyPrisma (REPLICA) and probes the other store's replica on a miss. findRuns over a bounded
// id-set reads each store's REPLICA; findRuns over an open predicate ({parentSpanId}) queries BOTH
// stores' replicas. So all seven reads hit a REPLICA.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import { markReadReplicaClient } from "./readReplicaClient.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// A cuid-shaped id/friendlyId (no run-ops v1 marker) classifies LEGACY, so both the create and the
// keyed reads route to the legacy (control-plane / prisma14, full schema) store as the owner.
const CUID_25 = "e".repeat(25);
const FRIENDLY_25 = "f".repeat(25);

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
  status?: string;
  spanId?: string;
  parentSpanId?: string;
}) {
  return {
    id: opts.id,
    engine: "V2" as const,
    status: (opts.status ?? "EXECUTING") as never,
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
    spanId: opts.spanId ?? `span_${opts.id}`,
    ...(opts.parentSpanId !== undefined ? { parentSpanId: opts.parentSpanId } : {}),
    queue: "task/my-task",
    isTest: false,
    taskEventStore: "taskEvent",
    depth: 0,
  };
}

// Build the router exactly as buildRunStore does (RoutingRunStore over legacy + dedicated stores),
// with the LEGACY store's REPLICA swapped for the frozen `legacyReplicaClient`. The NEW store keeps
// the real prisma17 as its replica — the seeded run lives only on legacy, so the routed miss-probe of
// the new store returns null/[] naturally (no phantom hit masking the legacy-replica staleness).
function buildRouter(
  prisma14: PrismaClient,
  prisma17: unknown,
  legacyReplicaClient: AnyClient
): RoutingRunStore {
  const legacyStore = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: legacyReplicaClient,
    schemaVariant: "legacy",
  });
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

describe("run-detail presenter read views route to the owning replica under lag", () => {
  // ApiRetrieveRunPresenter findRun (+$replica) — public GET /runs/:runId retrieve. Passes the BRANDED
  // $replica, which stays on a replica (no escalation), so the read is served by the owning REPLICA.
  // Under lag a freshly triggered run's row is not yet on the replica, so findRun returns null and the
  // presenter's `if (pgRow)` guard falls through → not-found for this poll. Tolerated: the SDK's
  // runs.retrieve/poll loop re-fetches on the next poll once the replica catches up. Read-only.
  heteroRunOpsPostgresTest(
    "ApiRetrieveRunPresenter findRun (+$replica) returns null for a fresh run missed on the frozen replica (SDK retrieve/poll re-fetches)",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedEnvironment(prisma14, "retrieve_leg");
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
      const select = { select: { id: true, friendlyId: true, status: true } };

      // PRIMARY contrast: an unbranded writer client → readYourWrites true → findRunOnPrimary → the
      // run IS seen. Proves the run genuinely exists and any miss below is purely replica lag.
      const okReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const primaryRouter = buildRouter(prisma14, prisma17, okReplica.client);
      const viaPrimary = (await primaryRouter.findRun(where, select, prisma14 as never)) as {
        id: string;
      } | null;
      expect(viaPrimary?.id).toBe(runId);

      // ACTUAL caller behavior: pass the BRANDED $replica handle → owning REPLICA (frozen).
      const lagReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const $replica = markReadReplicaClient(lagReplica.client);
      const router = buildRouter(prisma14, prisma17, lagReplica.client);
      const pgRow = (await router.findRun(where, select, $replica as never)) as {
        id: string;
      } | null;

      expect(lagReplica.wasHit("taskRun")).toBe(true);
      expect(pgRow).toBeNull();
    }
  );

  // ApiRunResultPresenter findRun (no client) — GET /runs/:runId/result poll (SDK waitForRun result).
  // No client → owning REPLICA. Under lag the run is invisible → findRun null → the presenter returns
  // undefined, which the SDK treats as "not finished yet, keep polling". A run that has produced a
  // result committed that write well before the poll, so the transient undefined only lengthens the
  // poll by one tick. Read-only.
  heteroRunOpsPostgresTest(
    "ApiRunResultPresenter findRun (no client) returns null for a run missed on the frozen replica (result poll retries)",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedEnvironment(prisma14, "result_leg");
      const runId = `run_${CUID_25}`;
      const friendlyId = `run_${FRIENDLY_25}`;
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "COMPLETED_SUCCESSFULLY",
        }),
      });

      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      // Exact caller shape: an `include` of attempts. Under "missing" mode the replica returns null
      // regardless of the projection; routing depends only on where + (absent) client.
      const args = { include: { attempts: { orderBy: { createdAt: "desc" as const } } } };

      const okReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const primaryRouter = buildRouter(prisma14, prisma17, okReplica.client);
      const viaPrimary = (await primaryRouter.findRun(where, args, prisma14 as never)) as {
        id: string;
      } | null;
      expect(viaPrimary?.id).toBe(runId);

      const lagReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const router = buildRouter(prisma14, prisma17, lagReplica.client);
      // Invoke EXACTLY as the caller does: findRun(where, { include }) — NO client argument.
      const taskRun = (await router.findRun(where, args)) as { id: string } | null;

      expect(lagReplica.wasHit("taskRun")).toBe(true);
      expect(taskRun).toBeNull();
      // Presenter maps null → undefined: "not finished yet, keep polling".
      expect(taskRun ?? undefined).toBeUndefined();
    }
  );

  // RunPresenter findRun (no client) — dashboard run-detail page loader. No client → owning REPLICA.
  // Under lag the fresh run is invisible → findRun null → the presenter throws RunNotInPgError, which
  // the route CATCHES to fall back to the synthesised mollifier-buffer view. That buffer holds exactly
  // the just-triggered runs whose rows have not yet drained/replicated — the read-your-writes safety net
  // for this window; the page self-heals on the next poll once the replica catches up.
  heteroRunOpsPostgresTest(
    "RunPresenter findRun (no client) returns null for a run missed on the frozen replica (mollifier-buffer fallback)",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedEnvironment(prisma14, "detail_leg");
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

      const where = { friendlyId };
      const select = {
        select: {
          id: true,
          projectId: true,
          friendlyId: true,
          status: true,
          runtimeEnvironmentId: true,
        },
      };

      const okReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const primaryRouter = buildRouter(prisma14, prisma17, okReplica.client);
      const viaPrimary = (await primaryRouter.findRun(where, select, prisma14 as never)) as {
        id: string;
      } | null;
      expect(viaPrimary?.id).toBe(runId);

      const lagReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const router = buildRouter(prisma14, prisma17, lagReplica.client);
      const run = (await router.findRun(where, select)) as { id: string } | null;

      expect(lagReplica.wasHit("taskRun")).toBe(true);
      expect(run).toBeNull(); // → presenter throws RunNotInPgError → route's mollifier-buffer fallback
    }
  );

  // RunStreamPresenter findRun (no client) — run-detail SSE trace stream loader. No client → owning
  // REPLICA. Under lag the fresh run is invisible → findRun null → traceId stays null and the presenter
  // falls back to the mollifier buffer for a traceId; if still unresolved it 404s, but the SSE loader
  // RECONNECTS (closing with 404 forces the dashboard to keep retrying). Worst case is a reconnect one
  // tick later — the stream attaches as soon as the replica (or buffer) yields the traceId. Read-only.
  heteroRunOpsPostgresTest(
    "RunStreamPresenter findRun (no client) returns null for a run missed on the frozen replica (buffer/404-then-reconnect)",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedEnvironment(prisma14, "stream_leg");
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

      const where = { friendlyId };
      const select = { select: { traceId: true, projectId: true } };

      const okReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const primaryRouter = buildRouter(prisma14, prisma17, okReplica.client);
      const viaPrimary = (await primaryRouter.findRun(where, select, prisma14 as never)) as {
        traceId: string;
      } | null;
      expect(viaPrimary?.traceId).toBe(`trace_${runId}`);

      const lagReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const router = buildRouter(prisma14, prisma17, lagReplica.client);
      const run = (await router.findRun(where, select)) as { traceId: string } | null;

      expect(lagReplica.wasHit("taskRun")).toBe(true);
      expect(run).toBeNull(); // traceId stays null → buffer fallback → 404-then-SSE-reconnect
    }
  );

  // PlaygroundPresenter findRuns (no client) — agent-playground conversation list. Reads conversations
  // off $replica, then resolves each conversation's backing run scalars via a client-less findRuns over
  // the id set → owning REPLICA (bounded id-set path). Under lag a run missing on the replica is absent
  // from runsById, so that conversation renders runFriendlyId=null / runStatus=null / isActive=false —
  // a cosmetic "status unknown" on one list row that self-heals on the next list load; the row itself
  // still renders.
  heteroRunOpsPostgresTest(
    "PlaygroundPresenter findRuns (no client) omits a run missed on the frozen replica (null status on that row)",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedEnvironment(prisma14, "playground_leg");
      const runId = `run_${CUID_25}`;
      const friendlyId = `run_${FRIENDLY_25}`;
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "EXECUTING",
        }),
      });

      const findRunsArgs = {
        where: { id: { in: [runId] } },
        select: { id: true, friendlyId: true, status: true },
      };

      const okReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const primaryRouter = buildRouter(prisma14, prisma17, okReplica.client);
      const viaPrimary = (await primaryRouter.findRuns(findRunsArgs, prisma14 as never)) as Array<{
        id: string;
      }>;
      expect(viaPrimary.map((r) => r.id)).toEqual([runId]);

      const lagReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const router = buildRouter(prisma14, prisma17, lagReplica.client);
      // Invoke EXACTLY as the caller does: findRuns({ where:{id:{in}}, select }) — NO client argument.
      const runs = (await router.findRuns(findRunsArgs)) as Array<{ id: string }>;

      expect(lagReplica.wasHit("taskRun")).toBe(true);
      expect(runs).toEqual([]); // run absent → conversation row shows null friendlyId/status
    }
  );

  // SpanPresenter findRun (+this._replica) — span-detail (run inspector) panel. Passes the BRANDED
  // this._replica → owning REPLICA (no escalation). Under lag the fresh run is invisible → findRun null
  // → the panel renders its not-found/loading state for this poll and self-heals on the next tick.
  // Read-only. (The alternate `{spanId, runtimeEnvironmentId}` branch is unclassifiable → fans
  // NEW→LEGACY, still each store's REPLICA — same replica-served conclusion.)
  heteroRunOpsPostgresTest(
    "SpanPresenter findRun (+this._replica) returns null for a run missed on the frozen replica (span-detail not-found this poll)",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedEnvironment(prisma14, "span_leg");
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

      // originalRunId branch: where = {friendlyId, runtimeEnvironmentId}. Representative select subset
      // (the full caller select is ~60 scalar/relation fields; routing depends only on where + client,
      // and "missing" mode ignores the projection).
      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const select = { select: { id: true, friendlyId: true, status: true, spanId: true } };

      const okReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const primaryRouter = buildRouter(prisma14, prisma17, okReplica.client);
      const viaPrimary = (await primaryRouter.findRun(where, select, prisma14 as never)) as {
        id: string;
      } | null;
      expect(viaPrimary?.id).toBe(runId);

      const lagReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const _replica = markReadReplicaClient(lagReplica.client);
      const router = buildRouter(prisma14, prisma17, lagReplica.client);
      const run = (await router.findRun(where, select, _replica as never)) as { id: string } | null;

      expect(lagReplica.wasHit("taskRun")).toBe(true);
      expect(run).toBeNull();
    }
  );

  // SpanPresenter findRuns {parentSpanId} (+this._replica) — the "triggered runs" list on a span-detail
  // panel. Passes the BRANDED this._replica; the where is an OPEN predicate ({parentSpanId}) with no id
  // set, so it queries BOTH stores' REPLICAS and dedupes. Under lag a just-triggered child run is not
  // yet on the replica, so it is absent from the triggered-runs list for this render — a cosmetic "one
  // fewer child shown" that self-heals on the next poll; the child still exists and executes.
  heteroRunOpsPostgresTest(
    "SpanPresenter findRuns {parentSpanId} (+this._replica) omits a child run missed on the frozen replica (triggered-runs list)",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedEnvironment(prisma14, "triggered_leg");
      const parentSpanId = "span_parent_fixed";
      const childRunId = `run_${CUID_25}`;
      const childFriendlyId = `run_${FRIENDLY_25}`;
      await prisma14.taskRun.create({
        data: taskRunData({
          id: childRunId,
          friendlyId: childFriendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          spanId: "span_child_fixed",
          parentSpanId,
        }),
      });

      const findRunsArgs = {
        where: { parentSpanId },
        select: {
          friendlyId: true,
          taskIdentifier: true,
          spanId: true,
          createdAt: true,
          status: true,
        },
      };

      // PRIMARY contrast: unbranded writer → each leg reads its primary → child run IS listed.
      const okReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const primaryRouter = buildRouter(prisma14, prisma17, okReplica.client);
      const viaPrimary = (await primaryRouter.findRuns(findRunsArgs, prisma14 as never)) as Array<{
        friendlyId: string;
      }>;
      expect(viaPrimary.map((r) => r.friendlyId)).toEqual([childFriendlyId]);

      const lagReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const _replica = markReadReplicaClient(lagReplica.client);
      const router = buildRouter(prisma14, prisma17, lagReplica.client);
      const triggeredRuns = (await router.findRuns(findRunsArgs, _replica as never)) as Array<{
        friendlyId: string;
      }>;

      expect(lagReplica.wasHit("taskRun")).toBe(true);
      expect(triggeredRuns).toEqual([]); // child omitted from the triggered-runs list this render
    }
  );
});
