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
import { markReadReplicaClient } from "./readReplicaClient.js";
import { RoutingRunStore } from "./runOpsStore.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine classifies by internal-id LENGTH: 25 chars → cuid → LEGACY, 27 → run-ops id → NEW.
const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / prisma14, full schema)
const NEW_ID_26 = "k".repeat(24) + "01"; // → NEW (#new / prisma17, dedicated subset schema)

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

// A writer that records whether a taskRun read reached it, and otherwise behaves as the real client.
function recordingWriter<C extends AnyClient>(real: C): { client: C; wasHit: () => boolean } {
  let hit = false;
  const taskRun = new Proxy((real as any).taskRun, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (typeof prop === "string" && prop.startsWith("find") && typeof value === "function") {
        return (...args: unknown[]) => {
          hit = true;
          return value.apply(target, args);
        };
      }
      return value;
    },
  });
  const client = new Proxy(real, {
    get(target, prop) {
      return prop === "taskRun" ? taskRun : (target as any)[prop];
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

  // (b) NEW-resident (run-ops id) run: born on the NEW DB (5434). The NEW replica lags. Passing the NEW
  // WRITER as the read-your-writes client must resolve the run via the NEW writer, NOT its replica —
  // and (proving the constraint that motivated the original client-drop) the control-plane writer is
  // never leaked into the NEW query: each store reads its OWN writer.
  heteroRunOpsPostgresTest(
    "NEW run-ops id: read-after-write via the NEW WRITER finds the fresh run despite NEW replica lag",
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
      const runId = `run_${NEW_ID_26}`; // run-ops id → NEW
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
      // run-ops run: the router routes by residency to the NEW store's OWN writer, never forwarding the
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

  // Both stores get a lagging replica, so any replica-routed taskRun read misses or throws
  // "lagging replica" and records the hit; both writers record whether a taskRun read reached them.
  function makeLaggingRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
    const legacyReplica = laggingReplica(prisma14);
    const newReplica = laggingReplica(prisma17);
    const legacyWriter = recordingWriter(prisma14);
    const newWriter = recordingWriter(prisma17);
    const router = new RoutingRunStore({
      new: new PostgresRunStore({
        prisma: newWriter.client as never,
        readOnlyPrisma: newReplica.client as never,
        schemaVariant: "dedicated",
      }),
      legacy: new PostgresRunStore({
        prisma: legacyWriter.client,
        readOnlyPrisma: legacyReplica.client,
        schemaVariant: "legacy",
      }),
    });
    const hits = () => ({
      newWriter: newWriter.wasHit(),
      legacyWriter: legacyWriter.wasHit(),
      newReplica: newReplica.wasHit(),
      legacyReplica: legacyReplica.wasHit(),
    });
    return { router, legacyReplica, newReplica, hits };
  }
  const notFound = { code: "P2025", name: "PrismaClientKnownRequestError" };
  const none = { newWriter: false, legacyWriter: false, newReplica: false, legacyReplica: false };

  // Catches: a run-id read reaching any client but the owning writer (or replica, for a replica caller).
  heteroRunOpsPostgresTest(
    "findRunOrThrow with a run id and a caller client reads only the owning store's writer",
    async ({ prisma14, prisma17 }) => {
      const seed = seedEnvironmentDedicated("ort_new");
      const runId = `run_${NEW_ID_26}`;
      await prisma17.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId: "run_ort_new",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        }),
      });
      const select = { select: { friendlyId: true } };

      // 1. NEW run, control-plane writer as caller → NEW writer.
      const found = makeLaggingRouter(prisma14, prisma17);
      const run = await found.router.findRunOrThrow({ id: runId }, select, prisma14);
      expect(run.friendlyId).toBe("run_ort_new");
      expect(found.hits()).toEqual({ ...none, newWriter: true });

      // 2. Missing NEW-shaped id → P2025 from the NEW writer.
      const missingNew = makeLaggingRouter(prisma14, prisma17);
      await expect(
        missingNew.router.findRunOrThrow({ id: `run_${"j".repeat(24)}01` }, select, prisma14)
      ).rejects.toMatchObject(notFound);
      expect(missingNew.hits()).toEqual({ ...none, newWriter: true });

      // 3. Missing cuid-shaped id → P2025 from the LEGACY writer.
      const missingLegacy = makeLaggingRouter(prisma14, prisma17);
      await expect(
        missingLegacy.router.findRunOrThrow({ id: `run_${"d".repeat(25)}` }, select, prisma14)
      ).rejects.toMatchObject(notFound);
      expect(missingLegacy.hits()).toEqual({ ...none, legacyWriter: true });

      // 4. A branded replica as caller keeps the owning store's replica.
      const viaReplica = makeLaggingRouter(prisma14, prisma17);
      await expect(
        viaReplica.router.findRunOrThrow({ id: runId }, select, markReadReplicaClient({}) as never)
      ).rejects.toThrow("lagging replica");
      expect(viaReplica.hits()).toEqual({ ...none, newReplica: true });
    }
  );

  // Catches: a no-id read with a caller writer that reads a replica or tries LEGACY before NEW.
  heteroRunOpsPostgresTest(
    "findRunOrThrow with a caller client and no run id tries the NEW writer, then the LEGACY writer, and throws P2025 when both miss",
    async ({ prisma14, prisma17 }) => {
      const { router, hits } = makeLaggingRouter(prisma14, prisma17);
      const dedicated = seedEnvironmentDedicated("ort_fan_new");
      const legacy = await seedEnvironmentLegacy(prisma14, "ort_fan_leg");
      const legacyEnv = {
        organizationId: legacy.organization.id,
        projectId: legacy.project.id,
        runtimeEnvironmentId: legacy.environment.id,
      };
      const newRunId = `run_${NEW_ID_26}`;
      const legacyRunId = `run_${CUID_25}`;
      const legacyOnlyRunId = `run_${"e".repeat(25)}`;
      await prisma17.taskRun.create({
        data: {
          ...taskRunData({
            id: newRunId,
            friendlyId: "run_fan_new",
            organizationId: dedicated.organization.id,
            projectId: dedicated.project.id,
            runtimeEnvironmentId: dedicated.environment.id,
          }),
          spanId: "span_both",
        },
      });
      await prisma14.taskRun.create({
        data: {
          ...taskRunData({ id: legacyRunId, friendlyId: "run_fan_leg", ...legacyEnv }),
          spanId: "span_both",
        },
      });
      await prisma14.taskRun.create({
        data: {
          ...taskRunData({ id: legacyOnlyRunId, friendlyId: "run_fan_leg_only", ...legacyEnv }),
          spanId: "span_legacy_only",
        },
      });
      const select = { select: { id: true } };

      const onBoth = await router.findRunOrThrow({ spanId: "span_both" }, select, prisma14);
      expect(onBoth.id).toBe(newRunId);

      const legacyOnly = await router.findRunOrThrow(
        { spanId: "span_legacy_only" },
        select,
        prisma14
      );
      expect(legacyOnly.id).toBe(legacyOnlyRunId);

      // A replica leg would return null or throw "lagging replica"; P2025 means the LEGACY writer threw.
      await expect(
        router.findRunOrThrow({ spanId: "span_nowhere" }, select, prisma14)
      ).rejects.toMatchObject(notFound);

      expect(hits()).toEqual({ ...none, newWriter: true, legacyWriter: true });
    }
  );

  // Catches: a dropped field list, a client with no field list reading a replica, or a branded replica reaching a writer.
  heteroRunOpsPostgresTest(
    "findRunOrThrow with a caller client keeps the field list or reads the whole row, and a branded replica fans out over the replicas",
    async ({ prisma14, prisma17 }) => {
      const dedicated = seedEnvironmentDedicated("ort_rows_new");
      const legacy = await seedEnvironmentLegacy(prisma14, "ort_rows_leg");
      const newRunId = `run_${NEW_ID_26}`;
      const legacyRunId = `run_${CUID_25}`;
      await prisma17.taskRun.create({
        data: taskRunData({
          id: newRunId,
          friendlyId: "run_rows_new",
          organizationId: dedicated.organization.id,
          projectId: dedicated.project.id,
          runtimeEnvironmentId: dedicated.environment.id,
        }),
      });
      await prisma14.taskRun.create({
        data: {
          ...taskRunData({
            id: legacyRunId,
            friendlyId: "run_rows_leg",
            organizationId: legacy.organization.id,
            projectId: legacy.project.id,
            runtimeEnvironmentId: legacy.environment.id,
          }),
          spanId: "span_rows_legacy",
        },
      });

      // 1. Run id with a field list → only the selected field (plus `id`, which the run-ops
      // schema's select always keeps), from the NEW writer.
      const selected = makeLaggingRouter(prisma14, prisma17);
      expect(
        await selected.router.findRunOrThrow(
          { id: newRunId },
          { select: { friendlyId: true } },
          prisma14
        )
      ).toEqual({ friendlyId: "run_rows_new", id: newRunId });
      expect(selected.hits()).toEqual({ ...none, newWriter: true });

      // 2. Run id, client and no field list → the whole row, from the NEW writer.
      const wholeRow = makeLaggingRouter(prisma14, prisma17);
      const row = await wholeRow.router.findRunOrThrow({ id: newRunId }, prisma14);
      expect(row).toMatchObject({ friendlyId: "run_rows_new", taskIdentifier: "my-task" });
      expect(wholeRow.hits()).toEqual({ ...none, newWriter: true });

      // 3. No run id with a field list → only the selected field, from the LEGACY writer.
      const fanSelected = makeLaggingRouter(prisma14, prisma17);
      expect(
        await fanSelected.router.findRunOrThrow(
          { spanId: "span_rows_legacy" },
          { select: { id: true } },
          prisma14
        )
      ).toEqual({ id: legacyRunId });
      expect(fanSelected.hits()).toEqual({ ...none, newWriter: true, legacyWriter: true });

      // 4. No run id, client and no field list, every database misses → P2025 from the LEGACY writer.
      const fanMissing = makeLaggingRouter(prisma14, prisma17);
      await expect(
        fanMissing.router.findRunOrThrow({ spanId: "span_rows_nowhere" }, prisma14)
      ).rejects.toMatchObject(notFound);
      expect(fanMissing.hits()).toEqual({ ...none, newWriter: true, legacyWriter: true });

      // 5. No run id and a branded replica → both replicas, no writer.
      const fanReplica = makeLaggingRouter(prisma14, prisma17);
      await expect(
        fanReplica.router.findRunOrThrow(
          { spanId: "span_rows_legacy" },
          { select: { id: true } },
          markReadReplicaClient({}) as never
        )
      ).rejects.toThrow("lagging replica");
      expect(fanReplica.hits()).toEqual({ ...none, newReplica: true, legacyReplica: true });
    }
  );
});
