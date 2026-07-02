// RED→GREEN repro for the run-ops split READ-AFTER-WRITE hole:
// RoutingRunStore.findRun/findRunOrThrow dropped the caller's client and always routed the read to
// the owning store's REPLICA (readOnlyPrisma). Read-after-write callers
// (api.v1.sessions / api.v1.tasks.$taskId.trigger) deliberately pass the control-plane WRITER
// (`prisma`) to read back a run they just committed and beat replica lag. Routed to the lagging
// replica the read returned null → "Triggered run X not found" → HTTP 500.
//
// The fix keys on the passed client's IDENTITY: a WRITER (has `$transaction`) means read-your-writes
// → route to the OWNING store's own writer (findRunOnPrimary), for BOTH residencies, WITHOUT leaking
// a control-plane client into a NEW-DB query (each store reads its OWN writer). A replica / nothing
// keeps the default (owning store's replica).
//
// `heteroRunOpsPostgresTest` gives a REAL split topology: prisma17 = RunOpsPrismaClient over the
// dedicated subset schema (#new / 5434), prisma14 = full legacy schema on a SEPARATE physical PG
// container (#legacy / control-plane). NEVER mocked. Replica lag is simulated by backing each store's
// `readOnlyPrisma` with a recording proxy whose taskRun reads return EMPTY (a lagging replica has not
// yet seen the fresh row) while recording that it was hit — so a replica-routed read MISSES and a
// writer-routed read FINDS. Seeds/writes always go through the real writer.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine classifies by internal-id LENGTH: 25 chars → cuid → LEGACY, 27 → ksuid → NEW.
const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / prisma14, full schema)
const KSUID_27 = "k".repeat(27); // → NEW (#new / prisma17, dedicated subset schema)

// A recording "replica" that has NOT yet caught up: its taskRun reads always come back empty and
// record that they ran, so a replica-routed read misses the just-written row. Everything else
// forwards to the real client. `hit` flips true iff a taskRun read was routed here.
function laggingReplica<C extends AnyClient>(real: C): { client: C; wasHit: () => boolean } {
  let hit = false;
  const laggingTaskRun = new Proxy((real as any).taskRun, {
    get(target, prop) {
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
      return (target as any)[prop];
    },
  });
  const client = new Proxy(real, {
    get(target, prop) {
      if (prop === "taskRun") {
        return laggingTaskRun;
      }
      return (target as any)[prop];
    },
  }) as C;
  return { client, wasHit: () => hit };
}

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

function seedEnvironmentDedicated(suffix: string) {
  return {
    organization: { id: `org_${suffix}` },
    project: { id: `proj_${suffix}` },
    environment: { id: `env_${suffix}` },
  };
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
  };
}

describe("run-ops split — read-after-write reads the OWNING store's WRITER, not its lagging replica", () => {
  // (a) LEGACY-resident (cuid) run: the run was just committed to the control-plane writer; the
  // control-plane replica lags. Passing the control-plane WRITER as the read-your-writes client must
  // resolve the run via the owning (legacy) writer, NOT the replica.
  heteroRunOpsPostgresTest(
    "LEGACY cuid: read-after-write via the control-plane WRITER finds the fresh run despite replica lag",
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

      const seed = await seedEnvironmentLegacy(prisma14, "raw_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId: "run_raw_leg",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });

      // FAIL-BEFORE proof: a plain replica read (no client) hits the lagging replica → miss.
      const viaReplica = await router.findRun(
        { id: runId },
        { select: { friendlyId: true } }
        // no client → default replica
      );
      expect(viaReplica).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      // PASS-AFTER: read-your-writes with the control-plane WRITER resolves the fresh run.
      const legacyReplica2 = laggingReplica(prisma14);
      const legacyStore2 = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: legacyReplica2.client,
        schemaVariant: "legacy",
      });
      const router2 = new RoutingRunStore({ new: newStore, legacy: legacyStore2 });
      const viaWriter = await router2.findRun(
        { id: runId },
        { select: { friendlyId: true } },
        prisma14 // control-plane WRITER → read-your-writes
      );
      expect(viaWriter).not.toBeNull();
      expect((viaWriter as { friendlyId: string }).friendlyId).toBe("run_raw_leg");
      // The read hit the WRITER, never the replica.
      expect(legacyReplica2.wasHit()).toBe(false);

      // findRunOrThrow: same behavior — writer resolves, replica would have thrown.
      const legacyReplica3 = laggingReplica(prisma14);
      const legacyStore3 = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: legacyReplica3.client,
        schemaVariant: "legacy",
      });
      const router3 = new RoutingRunStore({ new: newStore, legacy: legacyStore3 });
      const orThrow = await router3.findRunOrThrow(
        { id: runId },
        { select: { friendlyId: true } },
        prisma14
      );
      expect((orThrow as { friendlyId: string }).friendlyId).toBe("run_raw_leg");
      expect(legacyReplica3.wasHit()).toBe(false);
    }
  );

  // (b) NEW-resident (ksuid) run: born on the NEW DB (5434). The NEW replica lags. Passing the NEW
  // WRITER as the read-your-writes client must resolve the run via the NEW writer, NOT its replica —
  // and (proving the constraint that motivated the original client-drop) the control-plane writer is
  // never leaked into the NEW query: each store reads its OWN writer.
  heteroRunOpsPostgresTest(
    "NEW ksuid: read-after-write via the NEW WRITER finds the fresh run despite NEW replica lag",
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

      const seed = seedEnvironmentDedicated("raw_new");
      const runId = `run_${KSUID_27}`; // ksuid → NEW
      await prisma17.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId: "run_raw_new",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });

      // FAIL-BEFORE proof: a plain replica read hits the lagging NEW replica → miss.
      const viaReplica = await router.findRun({ id: runId }, { select: { friendlyId: true } });
      expect(viaReplica).toBeNull();
      expect(newReplica.wasHit()).toBe(true);

      // PASS-AFTER: read-your-writes with the NEW WRITER resolves the fresh run on the NEW DB.
      const newReplica2 = laggingReplica(prisma17);
      const newStore2 = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: newReplica2.client as never,
        schemaVariant: "dedicated",
      });
      const router2 = new RoutingRunStore({ new: newStore2, legacy: legacyStore });
      const viaWriter = await router2.findRun(
        { id: runId },
        { select: { friendlyId: true } },
        prisma17 as never // NEW WRITER → read-your-writes
      );
      expect(viaWriter).not.toBeNull();
      expect((viaWriter as { friendlyId: string }).friendlyId).toBe("run_raw_new");
      // The read hit the NEW WRITER, never the NEW replica.
      expect(newReplica2.wasHit()).toBe(false);

      // Even passing the LEGACY (control-plane) WRITER as the read-your-writes signal resolves the
      // ksuid run: the router routes by residency to the NEW store's OWN writer, never forwarding the
      // control-plane client into the NEW DB. (This is the exact live shape — sessions/trigger pass
      // the control-plane `prisma`, and the run may be NEW-resident under split-ON.)
      const newReplica3 = laggingReplica(prisma17);
      const newStore3 = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: newReplica3.client as never,
        schemaVariant: "dedicated",
      });
      const router3 = new RoutingRunStore({ new: newStore3, legacy: legacyStore });
      const viaControlPlaneWriter = await router3.findRun(
        { id: runId },
        { select: { friendlyId: true } },
        prisma14 // control-plane WRITER (writer identity) — router routes to NEW's own writer
      );
      expect((viaControlPlaneWriter as { friendlyId: string }).friendlyId).toBe("run_raw_new");
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

      const seed = await seedEnvironmentLegacy(prisma14, "plain_leg");
      const runId = `run_${CUID_25}`;
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId: "run_plain_leg",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });

      await router.findRun({ id: runId }, { select: { friendlyId: true } });
      // No writer passed → the read went to the replica, exactly as before the fix.
      expect(legacyReplica.wasHit()).toBe(true);
    }
  );
});
