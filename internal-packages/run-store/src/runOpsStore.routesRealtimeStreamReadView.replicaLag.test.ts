// Replica-lag properties for the realtime-stream route read views on the run-ops split. Fourteen
// route handlers resolve a run by friendlyId via runStore.findRun with a branded $replica handle or no
// client — both of which RoutingRunStore routes to the OWNING store's REPLICA, so under lag each can
// miss a freshly-created run and return null. Built as the webapp holds the RoutingRunStore, with the
// owning (legacy) replica FROZEN (taskRun "missing") via the shared `laggingReplica` primitive; each
// read is invoked EXACTLY as its caller does, asserting the under-lag value plus a primary re-read of
// the same row (so the null is provably lag). Thirteen reads tolerate the stale null (the run is
// already established when the route fires); subscribeToRun's findResource is a genuine
// read-your-writes window that re-reads the owning PRIMARY on a null to recover the just-triggered run.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import { markReadReplicaClient } from "./readReplicaClient.js";

// A cuid-shaped id (no run-ops v1 marker) classifies LEGACY, so both the create and the friendlyId-keyed
// reads route to the legacy (control-plane / prisma14, full schema) store first — the common realtime
// residency and the store whose frozen replica the read hits.
const CUID_25 = "c".repeat(25);

// The webapp always passes its `$replica` handle, which is markReadReplicaClient()'d. A branded client
// tells RoutingRunStore "do not escalate to primary" — so the read stays on the owning store's replica.
// We pass a branded stand-in exactly as the routes do; its identity is irrelevant because the router
// discards it and reads the owning store's readOnlyPrisma (the frozen replica in these tests).
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
}) {
  return {
    id: opts.id,
    engine: "V2" as const,
    status: "PENDING" as never,
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
    realtimeStreamsVersion: "v1",
    realtimeStreams: [],
  };
}

// Build the router the realtime routes hold it as: a LEGACY store on the control-plane DB whose replica
// LAGS (taskRun frozen "missing"), plus a fresh NEW store. Seed a LEGACY-resident (cuid) run on the
// legacy PRIMARY. Returns the router + probe + seeded ids. Every test below resolves this run.
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
  await prisma14.taskRun.create({
    data: taskRunData({
      id: runId,
      friendlyId,
      organizationId: seed.organization.id,
      projectId: seed.project.id,
      runtimeEnvironmentId: seed.environment.id,
    }),
  });

  return { router, legacyReplica, seed, runId, friendlyId };
}

describe("run-ops split — realtime-STREAM route read views vs. a lagging replica", () => {
  // runs.$runId findRun — subscribeToRun's findResource.
  // where {friendlyId, runtimeEnvironmentId}, include {batch:{select:{friendlyId}}}, BRANDED $replica.
  // The canonical trigger→subscribe read-your-writes window: the replica miss is the first leg (a bare
  // null would make apiBuilder 404 → terminal, since Electric retries only 429 and RunSubscription
  // closes on FetchError), so findResource re-reads the owning PRIMARY on a null. Proves both legs:
  // (a) the store returns null under lag, and (b) the owning-primary re-read recovers the run.
  heteroRunOpsPostgresTest(
    "runs.$runId findRun(branded $replica) is null under lag; the owning-primary re-read recovers the live run",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rt_run_subscribe"
      );

      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const args = { include: { batch: { select: { friendlyId: true } } } };

      // The stale replica read the auth findResource performs.
      const stale = await router.findRun(where, args, BRANDED_REPLICA);
      expect(stale).toBeNull(); // findResource null → apiBuilder returns 404 (x-should-retry:"false")
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      // The run IS live on the primary — findResource re-reads it there (the owning-primary fallback,
      // like resolveRunForMutation's writer re-probe) and recovers the just-triggered run.
      const recovered = (await router.findRun(where, args, prisma14 as never)) as {
        friendlyId: string;
      } | null;
      expect(recovered).not.toBeNull();
      expect(recovered!.friendlyId).toBe(friendlyId);
    }
  );

  // streams.$streamId ingest findRun — plain action ingest.
  // where {friendlyId} (NO env scope, back-compat), select {id,friendlyId,streamBasinName,
  // runtimeEnvironmentId}, BRANDED $replica. Null → 404. Tolerated: this is the stream write/ingest
  // side, invoked by the producer from INSIDE the executing run — the run was dequeued (primary-gated)
  // long after creation, so it is replicated by the time it writes to its own stream; friendlyId is
  // immutable.
  heteroRunOpsPostgresTest(
    "streams.$streamId ingest findRun(branded $replica) is null under lag; the primary sees the executing run",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, runId, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rt_ingest_plain"
      );
      const where = { friendlyId };
      const args = {
        select: { id: true, friendlyId: true, streamBasinName: true, runtimeEnvironmentId: true },
      };

      const stale = await router.findRun(where, args, BRANDED_REPLICA);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      const primary = (await router.findRun(where, args, prisma14 as never)) as {
        id: string;
      } | null;
      expect(primary).not.toBeNull();
      expect(primary!.id).toBe(runId);
    }
  );

  // streams.$streamId GET-SSE findResource — loader (GET SSE).
  // where {friendlyId, runtimeEnvironmentId}, select {id,friendlyId,taskIdentifier,runTags,
  // realtimeStreamsVersion,streamBasinName,batch:{...}}, BRANDED $replica. Null → 404. Tolerated: the
  // public stream read follows a successful subscribeToRun that already resolved the run (the previous
  // test covers that gate); stream chunks only exist once the run is executing, so the run is
  // replicated by the time a reader arrives.
  heteroRunOpsPostgresTest(
    "streams.$streamId GET-SSE findResource(branded $replica) is null under lag; the primary sees the run",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rt_stream_get"
      );
      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const args = {
        select: {
          id: true,
          friendlyId: true,
          taskIdentifier: true,
          runTags: true,
          realtimeStreamsVersion: true,
          streamBasinName: true,
          batch: { select: { friendlyId: true } },
        },
      };

      const stale = await router.findRun(where, args, BRANDED_REPLICA);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      const primary = (await router.findRun(where, args, prisma14 as never)) as {
        friendlyId: string;
      } | null;
      expect(primary).not.toBeNull();
      expect(primary!.friendlyId).toBe(friendlyId);
    }
  );

  // streams.$target action findRun — action (ingest/PUT).
  // where {friendlyId, runtimeEnvironmentId}, select {id,friendlyId,streamBasinName,parentTaskRun:{...},
  // rootTaskRun:{...}}, BRANDED $replica. Null → 404. Tolerated: write side from inside the executing
  // run; and the PUT completedAt gate re-reads the PRIMARY (`prisma`), so the authoritative decision
  // never depends on this replica read. Immutable ids resolved here.
  heteroRunOpsPostgresTest(
    "streams.$target action findRun(branded $replica) is null under lag; the completedAt gate re-reads the primary",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rt_target_action"
      );
      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const args = {
        select: {
          id: true,
          friendlyId: true,
          streamBasinName: true,
          parentTaskRun: { select: { friendlyId: true, streamBasinName: true } },
          rootTaskRun: { select: { friendlyId: true, streamBasinName: true } },
        },
      };

      const stale = await router.findRun(where, args, BRANDED_REPLICA);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      const primary = (await router.findRun(where, args, prisma14 as never)) as {
        friendlyId: string;
      } | null;
      expect(primary).not.toBeNull();
      expect(primary!.friendlyId).toBe(friendlyId);
    }
  );

  // streams.$target HEAD findRun — loader (HEAD).
  // Same select as the ingest/PUT action above, BRANDED $replica; resolves parent/root friendlyId for a
  // HEAD last-chunk-index probe. Null → 404. Tolerated: read side of an established run's stream
  // (subscribeToRun gated it first); read-only, immutable ids.
  heteroRunOpsPostgresTest(
    "streams.$target HEAD findResource(branded $replica) is null under lag; the primary sees the run",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rt_target_head"
      );
      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const args = {
        select: {
          id: true,
          friendlyId: true,
          streamBasinName: true,
          parentTaskRun: { select: { friendlyId: true, streamBasinName: true } },
          rootTaskRun: { select: { friendlyId: true, streamBasinName: true } },
        },
      };

      const stale = await router.findRun(where, args, BRANDED_REPLICA);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      const primary = (await router.findRun(where, args, prisma14 as never)) as {
        friendlyId: string;
      } | null;
      expect(primary).not.toBeNull();
      expect(primary!.friendlyId).toBe(friendlyId);
    }
  );

  // streams.$target append findRun — action.
  // where {friendlyId, runtimeEnvironmentId}, select {id,friendlyId,parentTaskRun:{select:{friendlyId}},
  // rootTaskRun:{select:{friendlyId}}}, BRANDED $replica. Null → 404. Tolerated: append write from
  // inside the executing run; the authoritative target completedAt gate re-reads the PRIMARY.
  heteroRunOpsPostgresTest(
    "streams.$target append findRun(branded $replica) is null under lag; the completedAt gate re-reads the primary",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rt_target_append"
      );
      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const args = {
        select: {
          id: true,
          friendlyId: true,
          parentTaskRun: { select: { friendlyId: true } },
          rootTaskRun: { select: { friendlyId: true } },
        },
      };

      const stale = await router.findRun(where, args, BRANDED_REPLICA);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      const primary = (await router.findRun(where, args, prisma14 as never)) as {
        friendlyId: string;
      } | null;
      expect(primary).not.toBeNull();
      expect(primary!.friendlyId).toBe(friendlyId);
    }
  );

  // streams.input send findRun — action (send input).
  // where {friendlyId, runtimeEnvironmentId}, select {id,friendlyId,completedAt,realtimeStreamsVersion,
  // streamBasinName}, BRANDED $replica. Null → 404. Tolerated: the `.send()` writer targets an
  // executing run's input stream, so it is replicated. The completedAt read off the replica fails safe:
  // a stale completedAt=null only allows the append to proceed (a harmless write), never wrongly
  // blocks a live run.
  heteroRunOpsPostgresTest(
    "streams.input send findRun(branded $replica) is null under lag; a stale completedAt fails safe by allowing the append",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rt_input_send"
      );
      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const args = {
        select: {
          id: true,
          friendlyId: true,
          completedAt: true,
          realtimeStreamsVersion: true,
          streamBasinName: true,
        },
      };

      const stale = await router.findRun(where, args, BRANDED_REPLICA);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      const primary = (await router.findRun(where, args, prisma14 as never)) as {
        friendlyId: string;
      } | null;
      expect(primary).not.toBeNull();
      expect(primary!.friendlyId).toBe(friendlyId);
    }
  );

  // streams.input GET-SSE findResource — loader (GET SSE tail).
  // where {friendlyId, runtimeEnvironmentId}, include {batch:{select:{friendlyId}}}, BRANDED $replica.
  // Null → 404. Tolerated: read side of an established run's input stream; read-only display tail,
  // immutable ids, follows a resolved run.
  heteroRunOpsPostgresTest(
    "streams.input GET-SSE findResource(branded $replica) is null under lag; the primary sees the run",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rt_input_get"
      );
      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const args = { include: { batch: { select: { friendlyId: true } } } };

      const stale = await router.findRun(where, args, BRANDED_REPLICA);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      const primary = (await router.findRun(where, args, prisma14 as never)) as {
        friendlyId: string;
      } | null;
      expect(primary).not.toBeNull();
      expect(primary!.friendlyId).toBe(friendlyId);
    }
  );

  // input-streams.wait findRun — create waitpoint.
  // where {friendlyId, runtimeEnvironmentId}, select {id,friendlyId,realtimeStreamsVersion,
  // streamBasinName}, BRANDED $replica. run.id then feeds engine.createManualWaitpoint (a mutation).
  // Null → 404 → waitpoint not created. Tolerated: `.wait()` on an input stream is called from inside
  // the executing run, so the run is long-since replicated; the mutation reads its own live run's id.
  heteroRunOpsPostgresTest(
    "input-streams.wait findRun(branded $replica) is null under lag; the primary sees the executing run",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, runId, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rt_input_wait"
      );
      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const args = {
        select: { id: true, friendlyId: true, realtimeStreamsVersion: true, streamBasinName: true },
      };

      const stale = await router.findRun(where, args, BRANDED_REPLICA);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      const primary = (await router.findRun(where, args, prisma14 as never)) as {
        id: string;
      } | null;
      expect(primary).not.toBeNull();
      expect(primary!.id).toBe(runId); // the run.id createManualWaitpoint would co-locate the waitpoint on
    }
  );

  // session-streams.wait findRun — create waitpoint.
  // where {friendlyId, runtimeEnvironmentId}, select {id,friendlyId,realtimeStreamsVersion}, BRANDED
  // $replica. run.id feeds engine.createManualWaitpoint. Null → 404. Tolerated: same reasoning as the
  // input-streams wait above — the agent's `.wait()` on a session stream runs inside the executing run,
  // so the run is replicated.
  heteroRunOpsPostgresTest(
    "session-streams.wait findRun(branded $replica) is null under lag; the primary sees the executing run",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, runId, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rt_session_wait"
      );
      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const args = { select: { id: true, friendlyId: true, realtimeStreamsVersion: true } };

      const stale = await router.findRun(where, args, BRANDED_REPLICA);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      const primary = (await router.findRun(where, args, prisma14 as never)) as {
        id: string;
      } | null;
      expect(primary).not.toBeNull();
      expect(primary!.id).toBe(runId);
    }
  );

  // resources sessions.$io findRun — dashboard SSE.
  // where {friendlyId, runtimeEnvironmentId}, select {id,friendlyId}, BRANDED $replica. Verifies the run
  // lives in this env before subscribing to a session channel. Null → 404. Tolerated: this
  // dashboard-auth route is opened by a human in the span inspector Agent tab, on a run whose detail
  // page already resolved — the navigation latency dwarfs replica lag; read-only display; the error
  // self-heals on reconnect/navigation.
  heteroRunOpsPostgresTest(
    "resources sessions.$io findRun(branded $replica) is null under lag; the primary sees the run",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, runId, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rt_res_session_io"
      );
      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const args = { select: { id: true, friendlyId: true } };

      const stale = await router.findRun(where, args, BRANDED_REPLICA);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      const primary = (await router.findRun(where, args, prisma14 as never)) as {
        id: string;
      } | null;
      expect(primary).not.toBeNull();
      expect(primary!.id).toBe(runId);
    }
  );

  // resources streams.$streamId findRun — dashboard SSE.
  // where {friendlyId, runtimeEnvironmentId}, select {id,friendlyId,realtimeStreamsVersion,
  // streamBasinName}, BRANDED $replica. Null → 404. Tolerated: same dashboard-navigation reasoning as
  // above (Agent tab output-stream viewer); read-only.
  heteroRunOpsPostgresTest(
    "resources streams.$streamId findRun(branded $replica) is null under lag; the primary sees the run",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rt_res_stream"
      );
      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const args = {
        select: {
          id: true,
          friendlyId: true,
          realtimeStreamsVersion: true,
          streamBasinName: true,
        },
      };

      const stale = await router.findRun(where, args, BRANDED_REPLICA);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      const primary = (await router.findRun(where, args, prisma14 as never)) as {
        friendlyId: string;
      } | null;
      expect(primary).not.toBeNull();
      expect(primary!.friendlyId).toBe(friendlyId);
    }
  );

  // resources streams.input findRun — dashboard SSE.
  // where {friendlyId, runtimeEnvironmentId}, select {id,friendlyId,realtimeStreamsVersion,
  // streamBasinName}, BRANDED $replica. Null → 404. Tolerated: same dashboard-navigation reasoning as
  // above (Agent tab input-stream viewer); read-only.
  heteroRunOpsPostgresTest(
    "resources streams.input findRun(branded $replica) is null under lag; the primary sees the run",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rt_res_input"
      );
      const where = { friendlyId, runtimeEnvironmentId: seed.environment.id };
      const args = {
        select: {
          id: true,
          friendlyId: true,
          realtimeStreamsVersion: true,
          streamBasinName: true,
        },
      };

      const stale = await router.findRun(where, args, BRANDED_REPLICA);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      const primary = (await router.findRun(where, args, prisma14 as never)) as {
        friendlyId: string;
      } | null;
      expect(primary).not.toBeNull();
      expect(primary!.friendlyId).toBe(friendlyId);
    }
  );

  // route.tsx findRun — dashboard SSE, no client argument.
  // where {friendlyId, projectId} (note: projectId, not env), select {id,friendlyId,
  // realtimeStreamsVersion,streamBasinName,runtimeEnvironmentId}, NO client → owning REPLICA. Null →
  // throw Response 404. Tolerated: same dashboard-navigation reasoning as above; the run's own detail
  // page resolved it already; read-only stream viewer. This caller passes no client at all (versus
  // the branded $replica in the tests above) but routes to the same owning replica, so the under-lag
  // behavior is identical.
  heteroRunOpsPostgresTest(
    "route.tsx findRun(no client) is null under lag; the primary sees the run",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyReplica, seed, friendlyId } = await setupLaggingLegacy(
        prisma14,
        prisma17,
        "rt_route_tsx"
      );
      const where = { friendlyId, projectId: seed.project.id };
      const args = {
        select: {
          id: true,
          friendlyId: true,
          realtimeStreamsVersion: true,
          streamBasinName: true,
          runtimeEnvironmentId: true,
        },
      };

      // NO client — exactly as the route.tsx caller.
      const stale = await router.findRun(where, args);
      expect(stale).toBeNull();
      expect(legacyReplica.wasHit("taskRun")).toBe(true);

      const primary = (await router.findRun(where, args, prisma14 as never)) as {
        friendlyId: string;
      } | null;
      expect(primary).not.toBeNull();
      expect(primary!.friendlyId).toBe(friendlyId);
    }
  );
});
