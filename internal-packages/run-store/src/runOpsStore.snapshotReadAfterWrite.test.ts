// RED→GREEN repro for the run-ops split READ-AFTER-WRITE hole:
// RoutingRunStore.findLatestExecutionSnapshot dropped the caller's client and always routed the
// read to the owning store's REPLICA (readOnlyPrisma). Read-after-write callers that just wrote a
// snapshot in this request and pass the WRITER to read it back (to beat replica lag) got a stale
// miss → the engine throws or un-blocks the run → time-based waitpoints (delay/wait.until/
// reschedule/retry-backoff) are never armed or get destroyed.
//
// The fix keys on the passed client's IDENTITY: a WRITER (has `$transaction`) means read-your-writes
// → route to the OWNING store's own writer (findLatestExecutionSnapshotOnPrimary), for BOTH
// residencies, WITHOUT leaking a control-plane client into a NEW-DB query (each store reads its OWN
// writer). A replica / nothing keeps the default (owning store's replica).
//
// `heteroRunOpsPostgresTest` gives a REAL split topology: prisma17 = RunOpsPrismaClient over the
// dedicated subset schema (#new / 5434), prisma14 = full legacy schema on a SEPARATE physical PG
// container (#legacy / control-plane). NEVER mocked. Replica lag is simulated by backing each
// store's `readOnlyPrisma` with a recording proxy whose taskRunExecutionSnapshot reads return EMPTY
// (a lagging replica has not yet seen the fresh row) while recording that it was hit — so a
// replica-routed read MISSES and a writer-routed read FINDS. Seeds/writes always go through the
// real writer (store.createRun).

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput, RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine classifies by internal-id LENGTH: 25 chars → cuid → LEGACY, 27 → ksuid → NEW.
const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / prisma14, full schema)
const KSUID_27 = "k".repeat(27); // → NEW (#new / prisma17, dedicated subset schema)

// A recording "replica" that has NOT yet caught up: its taskRunExecutionSnapshot (and, for the
// second guard case, taskRunWaitpoint) reads always come back empty and record that they ran, so a
// replica-routed read misses the just-written row. Everything else forwards to the real client.
// `hit` flips true iff an intercepted read was routed here.
function laggingReplica<C extends AnyClient>(real: C): { client: C; wasHit: () => boolean } {
  let hit = false;
  function wrapModel(target: any) {
    return new Proxy(target, {
      get(innerTarget, prop) {
        if (prop === "findFirst" || prop === "findMany") {
          return async () => {
            hit = true;
            return prop === "findMany" ? [] : null;
          };
        }
        if (prop === "findFirstOrThrow") {
          return async () => {
            hit = true;
            throw new Error("lagging replica: row not visible");
          };
        }
        return (innerTarget as any)[prop];
      },
    });
  }
  const laggingSnapshot = wrapModel((real as any).taskRunExecutionSnapshot);
  const laggingTaskRunWaitpoint = wrapModel((real as any).taskRunWaitpoint);
  const client = new Proxy(real, {
    get(target, prop) {
      if (prop === "taskRunExecutionSnapshot") {
        return laggingSnapshot;
      }
      if (prop === "taskRunWaitpoint") {
        return laggingTaskRunWaitpoint;
      }
      return (target as any)[prop];
    },
  }) as C;
  return { client, wasHit: () => hit };
}

// On the dedicated subset there are no Organization/Project/RuntimeEnvironment models (the run-ops
// rows carry FK-free scalar ids), so we mint synthetic owning ids. On legacy we seed the real rows
// the kept FKs require.
async function seedEnvironment(
  prisma: AnyClient,
  schemaVariant: RunStoreSchemaVariant,
  slugSuffix: string
) {
  if (schemaVariant === "dedicated") {
    return {
      organization: { id: `org_${slugSuffix}` },
      project: { id: `proj_${slugSuffix}` },
      environment: { id: `env_${slugSuffix}` },
    };
  }
  const organization = await (prisma as PrismaClient).organization.create({
    data: { title: `Org ${slugSuffix}`, slug: `org-${slugSuffix}` },
  });
  const project = await (prisma as PrismaClient).project.create({
    data: {
      name: `Project ${slugSuffix}`,
      slug: `project-${slugSuffix}`,
      externalRef: `proj_${slugSuffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await (prisma as PrismaClient).runtimeEnvironment.create({
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

describe("run-ops split — snapshot read-after-write reads the OWNING store's WRITER, not its lagging replica", () => {
  // (a) LEGACY-resident (cuid) run: the initial snapshot was just committed to the control-plane
  // writer via store.createRun; the control-plane replica lags. Passing the control-plane WRITER as
  // the read-your-writes client must resolve the snapshot via the owning (legacy) writer, NOT the
  // replica.
  heteroRunOpsPostgresTest(
    "LEGACY cuid: read-after-write via the control-plane WRITER finds the fresh snapshot despite replica lag",
    async ({ prisma14, prisma17 }) => {
      const legacyReplica = laggingReplica(prisma14);
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

      const seed = await seedEnvironment(prisma14, "legacy", "snap_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_snap_leg",
          taskIdentifier: "my-task",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // FAIL-BEFORE proof: a plain replica read (no client) hits the lagging replica → miss.
      const viaReplica = await router.findLatestExecutionSnapshot(runId);
      expect(viaReplica).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      // PASS-AFTER: read-your-writes with the control-plane WRITER resolves the fresh snapshot.
      const legacyReplica2 = laggingReplica(prisma14);
      const legacyStore2 = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: legacyReplica2.client,
        schemaVariant: "legacy",
      });
      const router2 = new RoutingRunStore({ new: newStore, legacy: legacyStore2 });
      const viaWriter = await router2.findLatestExecutionSnapshot(
        runId,
        prisma14 // control-plane WRITER → read-your-writes
      );
      expect(viaWriter).not.toBeNull();
      expect(viaWriter!.runId).toBe(runId);
      // The read hit the WRITER, never the replica.
      expect(legacyReplica2.wasHit()).toBe(false);
    }
  );

  // (b) NEW-resident (ksuid) run: born on the NEW DB (5434). The NEW replica lags. Passing the NEW
  // WRITER as the read-your-writes client must resolve the snapshot via the NEW writer, NOT its
  // replica — and (proving the constraint that motivated the original client-drop) the control-plane
  // writer is never leaked into the NEW query: each store reads its OWN writer.
  heteroRunOpsPostgresTest(
    "NEW ksuid: read-after-write via the NEW WRITER finds the fresh snapshot despite NEW replica lag",
    async ({ prisma14, prisma17 }) => {
      const newReplica = laggingReplica(prisma17);
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: newReplica.client as never,
        schemaVariant: "dedicated",
      });
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed = await seedEnvironment(prisma17, "dedicated", "snap_new");
      const runId = `run_${KSUID_27}`; // ksuid → NEW
      await newStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_snap_new",
          taskIdentifier: "my-task",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // FAIL-BEFORE proof: a plain replica read hits the lagging NEW replica → miss.
      const viaReplica = await router.findLatestExecutionSnapshot(runId);
      expect(viaReplica).toBeNull();
      expect(newReplica.wasHit()).toBe(true);

      // PASS-AFTER: read-your-writes with the NEW WRITER resolves the fresh snapshot on the NEW DB.
      const newReplica2 = laggingReplica(prisma17);
      const newStore2 = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: newReplica2.client as never,
        schemaVariant: "dedicated",
      });
      const router2 = new RoutingRunStore({ new: newStore2, legacy: legacyStore });
      const viaWriter = await router2.findLatestExecutionSnapshot(
        runId,
        prisma17 as never // NEW WRITER → read-your-writes
      );
      expect(viaWriter).not.toBeNull();
      expect(viaWriter!.runId).toBe(runId);
      // The read hit the NEW WRITER, never the NEW replica.
      expect(newReplica2.wasHit()).toBe(false);

      // Even passing the LEGACY (control-plane) WRITER as the read-your-writes signal resolves the
      // ksuid run's snapshot: the router routes by residency to the NEW store's OWN writer, never
      // forwarding the control-plane client into the NEW DB. (This is the exact live shape —
      // sessions/trigger pass the control-plane `prisma`, and the run may be NEW-resident under
      // split-ON.)
      const newReplica3 = laggingReplica(prisma17);
      const newStore3 = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: newReplica3.client as never,
        schemaVariant: "dedicated",
      });
      const router3 = new RoutingRunStore({ new: newStore3, legacy: legacyStore });
      const viaControlPlaneWriter = await router3.findLatestExecutionSnapshot(
        runId,
        prisma14 // control-plane WRITER (writer identity) — router routes to NEW's own writer
      );
      expect(viaControlPlaneWriter).not.toBeNull();
      expect(viaControlPlaneWriter!.runId).toBe(runId);
      expect(newReplica3.wasHit()).toBe(false);
    }
  );

  // Guard: a plain replica read (no client, or a replica client) still routes to the replica — the
  // fix must not turn every read into a primary read (which would defeat replica offload).
  heteroRunOpsPostgresTest(
    "plain reads still route to the replica (no read-your-writes escalation)",
    async ({ prisma14, prisma17 }) => {
      const legacyReplica = laggingReplica(prisma14);
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

      const seed = await seedEnvironment(prisma14, "legacy", "snap_plain_leg");
      const runId = `run_${CUID_25}`;
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_snap_plain_leg",
          taskIdentifier: "my-task",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      await router.findLatestExecutionSnapshot(runId);
      // No writer passed → the read went to the replica, exactly as before the fix.
      expect(legacyReplica.wasHit()).toBe(true);
    }
  );
});
