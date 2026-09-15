// RED→GREEN repro for the routed-read CLIENT DROP: RoutingRunStore's runId-routed / fan-out reads
// accept `client?: ReadClient` but dropped it, so the sub-store fell back to its REPLICA. The
// run-engine passes its writer (`tx ?? this.$.prisma`) into these reads for read-your-writes
// consistency (dequeue re-reads the just-written QUEUED snapshot), so the drop surfaces in cloud as
// TASK_DEQUEUED_INVALID_STATE / "No execution snapshot found for TaskRun ...". The fix routes a
// caller-passed client to the OWNING store's OWN primary (never forwarded verbatim — it is bound to
// the control-plane DB); no client keeps the replica default.
//
// Deterministic harness: `heteroPostgresTest` hands two PHYSICALLY separate postgres containers
// over the same full schema. The owning store WRITES to one and its `readOnlyPrisma` points at the
// other, which stays EMPTY (a replica with unbounded lag) — so a replica-routed read MISSES and a
// primary-routed read finds the row, with no replica==primary aliasing to mask the drop.

import { heteroPostgresTest } from "@internal/testcontainers";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import { markReadReplicaClient } from "./readReplicaClient.js";
import type { CreateRunInput } from "./types.js";

// ownerEngine classifies by the version char: a 25-char cuid → LEGACY; a valid run-ops v1 body
// (26 chars: base32hex core + region char + version "1") → NEW.
const CUID_25 = "c".repeat(25);
const RUN_OPS_ID_BODY = generateRunOpsId();

// Router topology where the OWNING store (the one the test's run ids route to) writes to `writer`
// but reads by default from `lagging` — a physically separate, never-written DB. The other store
// lives entirely on the lagging DB so fan-out legs can't accidentally see rows. Both DBs carry the
// full schema (the forwarding under test is residency-agnostic; dedicated-subset parity is covered
// by the sibling suites), so both stores use the "legacy" variant.
function splitTopology(
  residency: "LEGACY" | "NEW",
  writer: PrismaClient,
  lagging: PrismaClient
): { owningStore: PostgresRunStore; router: RoutingRunStore } {
  const owningStore = new PostgresRunStore({
    prisma: writer,
    readOnlyPrisma: lagging,
    schemaVariant: "legacy",
  });
  const otherStore = new PostgresRunStore({
    prisma: lagging,
    readOnlyPrisma: lagging,
    schemaVariant: "legacy",
  });
  const router = new RoutingRunStore(
    residency === "LEGACY"
      ? { new: otherStore, legacy: owningStore }
      : { new: owningStore, legacy: otherStore }
  );
  return { owningStore, router };
}

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
      status: "PENDING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
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

describe("run-ops split — routed reads honor a caller-passed client via the owning store's PRIMARY", () => {
  // The outage path: dequeue writes the QUEUED snapshot then re-reads it via
  // `getLatestExecutionSnapshot(this.$.prisma, ...)`. The router must not downgrade that read to
  // the replica. Covers the whole snapshot read family on the LEGACY (cuid) routing arm.
  heteroPostgresTest(
    "LEGACY cuid: snapshot reads with a client resolve on the owning primary; without, on the replica",
    async ({ prisma14, prisma17 }) => {
      const { router } = splitTopology("LEGACY", prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "snap_leg");
      const runId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_snap_leg",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // findLatestExecutionSnapshot — client passed → owning primary finds the fresh snapshot.
      const latest = await router.findLatestExecutionSnapshot(runId, prisma14);
      expect(latest).not.toBeNull();
      expect(latest?.executionStatus).toBe("RUN_CREATED");
      // No client → the (empty) replica, unchanged behavior.
      expect(await router.findLatestExecutionSnapshot(runId)).toBeNull();

      const snapshotId = latest!.id;

      // findExecutionSnapshot (runId-routed, the warm-restart shape).
      const one = await router.findExecutionSnapshot(
        { where: { runId, isValid: true }, select: { id: true } },
        prisma14
      );
      expect(one?.id).toBe(snapshotId);
      expect(await router.findExecutionSnapshot({ where: { runId, isValid: true } })).toBeNull();

      // findManyExecutionSnapshots (runId-routed).
      const many = await router.findManyExecutionSnapshots(
        { where: { runId }, select: { id: true } },
        prisma14
      );
      expect(many.map((s) => s.id)).toEqual([snapshotId]);
      expect(await router.findManyExecutionSnapshots({ where: { runId } })).toEqual([]);

      // findSnapshotCompletedWaitpointIds (the resume-payload join read). Seed a completed
      // waitpoint + its `_completedWaitpoints` join on the writer only.
      const waitpoint = await prisma14.waitpoint.create({
        data: {
          friendlyId: "waitpoint_snap_leg",
          type: "MANUAL",
          status: "COMPLETED",
          idempotencyKey: "idem_snap_leg",
          userProvidedIdempotencyKey: false,
          projectId: seed.project.id,
          environmentId: seed.environment.id,
        },
      });
      // Link via the Prisma relation API (not a raw insert into the implicit join table) so a
      // relation rename fails at compile time rather than silently seeding nothing.
      await prisma14.taskRunExecutionSnapshot.update({
        where: { id: snapshotId },
        data: { completedWaitpoints: { connect: { id: waitpoint.id } } },
      });
      expect(await router.findSnapshotCompletedWaitpointIds(snapshotId, prisma14)).toEqual([
        waitpoint.id,
      ]);
      expect(await router.findSnapshotCompletedWaitpointIds(snapshotId)).toEqual([]);
    }
  );

  // NEW (run-ops id) routing arm. The caller's client here is the CONTROL-PLANE writer — the wrong
  // physical DB for a NEW-resident run — so this also pins that the client is never forwarded
  // verbatim: the read must resolve on the owning NEW store's OWN primary.
  heteroPostgresTest(
    "NEW run-ops id: a control-plane client routes the snapshot read to the NEW store's OWN primary",
    async ({ prisma14, prisma17 }) => {
      // Owning (NEW) store writes to prisma14; the control-plane/other store is prisma17.
      const { router } = splitTopology("NEW", prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "snap_new");
      const runId = `run_${RUN_OPS_ID_BODY}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_snap_new",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // Control-plane writer (prisma17 side of this topology) passed as the client: the row can
      // only be found on the NEW store's own primary (prisma14) — verbatim forwarding would miss.
      const latest = await router.findLatestExecutionSnapshot(runId, prisma17);
      expect(latest).not.toBeNull();
      expect(latest?.executionStatus).toBe("RUN_CREATED");
      // No client → the NEW store's (empty) replica.
      expect(await router.findLatestExecutionSnapshot(runId)).toBeNull();
    }
  );

  heteroPostgresTest(
    "LEGACY cuid: findRuns fan-out and batch friendlyId probe honor a caller client",
    async ({ prisma14, prisma17 }) => {
      const { router } = splitTopology("LEGACY", prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "runs_leg");
      const runId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_runs_leg",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // findRuns (bounded id-set fan-out).
      const rows = await router.findRuns(
        { where: { id: { in: [runId] } }, select: { id: true } },
        prisma14
      );
      expect(rows.map((r) => r.id)).toEqual([runId]);
      expect(
        await router.findRuns({ where: { id: { in: [runId] } }, select: { id: true } })
      ).toEqual([]);

      // findBatchTaskRunByFriendlyId (env-scoped fan-out probe; the one batch read that defaults
      // to the replica).
      const batch = await prisma14.batchTaskRun.create({
        data: {
          id: `batch_${CUID_25}`,
          friendlyId: "batch_runs_leg",
          runtimeEnvironmentId: seed.environment.id,
        },
      });
      const viaPrimary = await router.findBatchTaskRunByFriendlyId(
        batch.friendlyId,
        seed.environment.id,
        undefined,
        prisma14
      );
      expect(viaPrimary?.id).toBe(batch.id);
      expect(
        await router.findBatchTaskRunByFriendlyId(batch.friendlyId, seed.environment.id)
      ).toBeNull();
    }
  );

  // Read scaling: a caller that passes an explicit READ REPLICA (e.g. `$replica`) must NOT be
  // escalated to the primary — only true read-your-writes (a writer/tx) should. A replica is a
  // full PrismaClient at runtime (it has `$transaction` too), so shape can't distinguish it; the
  // client builder brands it and the router honors the brand. Proven here by branding a client and
  // showing the read stays on the owning store's (empty) replica — same as passing no client —
  // while an unbranded writer escalates and finds the fresh row.
  heteroPostgresTest(
    "a branded read-replica client stays on the replica; a writer escalates to the primary",
    async ({ prisma14, prisma17 }) => {
      const { router } = splitTopology("LEGACY", prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "replica_leg");
      const runId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_replica_leg",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // The router discards the caller's client object (it can't cross DBs) and reads the brand
      // only, so a branded marker faithfully stands in for a passed `$replica`.
      const replicaClient = markReadReplicaClient({} as unknown as PrismaClient);

      // findRun (readYourWrites path): branded replica → owning replica (empty) → miss.
      expect(
        await router.findRun({ id: runId }, { select: { id: true } }, replicaClient)
      ).toBeNull();
      // Control: an unbranded writer escalates to the owning primary → finds the fresh row.
      expect((await router.findRun({ id: runId }, { select: { id: true } }, prisma14))?.id).toBe(
        runId
      );

      // findLatestExecutionSnapshot (#ownPrimary path): same replica-stays-on-replica invariant.
      expect(await router.findLatestExecutionSnapshot(runId, replicaClient)).toBeNull();
      expect((await router.findLatestExecutionSnapshot(runId, prisma14))?.executionStatus).toBe(
        "RUN_CREATED"
      );
      // No client behaves identically to the branded replica.
      expect(await router.findLatestExecutionSnapshot(runId)).toBeNull();
    }
  );

  heteroPostgresTest(
    "LEGACY cuid: waitpoint reads honor a caller client",
    async ({ prisma14, prisma17 }) => {
      const { router } = splitTopology("LEGACY", prisma14, prisma17);
      const seed = await seedEnvironment(prisma14, "wp_leg");
      const runId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_wp_leg",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );
      const waitpoint = await prisma14.waitpoint.create({
        data: {
          id: `waitpoint_${CUID_25}`,
          friendlyId: "waitpoint_wp_leg",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: "idem_wp_leg",
          userProvidedIdempotencyKey: false,
          projectId: seed.project.id,
          environmentId: seed.environment.id,
        },
      });
      await prisma14.taskRunWaitpoint.create({
        data: { taskRunId: runId, waitpointId: waitpoint.id, projectId: seed.project.id },
      });

      // findWaitpoint (by id, resolve + scalar read).
      const found = await router.findWaitpoint({ where: { id: waitpoint.id } }, prisma14);
      expect(found?.id).toBe(waitpoint.id);
      expect(await router.findWaitpoint({ where: { id: waitpoint.id } })).toBeNull();

      // findManyWaitpoints (both-store fan-out).
      const manyOnPrimary = await router.findManyWaitpoints(
        { where: { id: { in: [waitpoint.id] } } },
        prisma14
      );
      expect(manyOnPrimary.map((w) => w.id)).toEqual([waitpoint.id]);
      expect(await router.findManyWaitpoints({ where: { id: { in: [waitpoint.id] } } })).toEqual(
        []
      );

      // countPendingWaitpoints (both-store fan-out sum).
      expect(await router.countPendingWaitpoints([waitpoint.id], prisma14)).toBe(1);
      expect(await router.countPendingWaitpoints([waitpoint.id])).toBe(0);

      // findManyTaskRunWaitpoints (the blocked-run edge fan-out).
      const edges = await router.findManyTaskRunWaitpoints(
        { where: { taskRunId: runId } },
        prisma14
      );
      expect(edges).toHaveLength(1);
      expect(edges[0]?.waitpointId).toBe(waitpoint.id);
      expect(await router.findManyTaskRunWaitpoints({ where: { taskRunId: runId } })).toEqual([]);
    }
  );
});
