// Store-seam characterization of the read primitive behind the session-run liveness probe — NOT a
// caller guard. Under owning-replica lag, findRun({id},{select},$replica) misses the just-written run
// (→ null) and the same findRun on the WRITER recovers it. This exercises only the store reads against
// real Postgres. The caller contract (ensureRunForSession reuses the live run and does NOT double-
// trigger the session) is locked separately by the real caller-driven realtime-services replica-lag
// guard, which drives ensureRunForSession end-to-end.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

// ownerEngine classifies by internal-id LENGTH: 25 chars → cuid → LEGACY, 26 → run-ops id → NEW.
const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / prisma14, full schema)
const NEW_ID_26 = "k".repeat(24) + "01"; // → NEW (#new / prisma17, dedicated subset schema)

// The probe select mirrors getRunStatusAndFriendlyId exactly.
const PROBE_SELECT = { select: { status: true, friendlyId: true } } as const;

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
  status?: "PENDING" | "EXECUTING" | "COMPLETED_SUCCESSFULLY";
}) {
  return {
    id: opts.id,
    engine: "V2" as const,
    // Non-final by default: this is the "run is still alive, reuse it" case the probe must recover.
    status: opts.status ?? "EXECUTING",
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

describe("store reads behind the session-run liveness probe — replica misses, writer recovers", () => {
  // (a) LEGACY-resident (cuid) session run: triggered moments ago on the control-plane writer; the
  // control-plane replica lags. The branded-$replica probe misses; the writer re-probe finds the
  // fresh EXECUTING run → ensureRunForSession reuses it instead of double-triggering.
  heteroRunOpsPostgresTest(
    "LEGACY cuid: branded-replica probe misses under lag; writer re-probe finds the live run",
    async ({ prisma14, prisma17 }) => {
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

      const seed = await seedEnvironmentLegacy(prisma14, "sess_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId: "run_sess_leg",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "EXECUTING",
        }),
      });

      // Step 1 — the getRunStatusAndFriendlyId probe. The call site passes the branded $replica; at
      // the routing layer that is identical to omitting the client (both route to the owning store's
      // OWN replica and neither escalates to the primary — the brand only suppresses escalation).
      // Under lag the owning replica hasn't applied the fresh row → MISS. A naive caller treating this
      // null as "run vanished" would double-trigger the session.
      const viaReplica = await router.findRun({ id: runId }, PROBE_SELECT);
      expect(viaReplica).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      // Step 2 — ensureRunForSession's compensation: re-read on the control-plane WRITER before
      // deciding liveness. Fresh row is found with its non-final status → the session reuses the
      // still-alive run and does NOT double-trigger.
      const legacyReplica2 = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const legacyStore2 = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: legacyReplica2.client,
        schemaVariant: "legacy",
      });
      const router2 = new RoutingRunStore({ new: newStore, legacy: legacyStore2 });
      const viaWriter = (await router2.findRun({ id: runId }, PROBE_SELECT, prisma14)) as {
        status: string;
        friendlyId: string;
      } | null;
      expect(viaWriter).not.toBeNull();
      expect(viaWriter!.friendlyId).toBe("run_sess_leg");
      // Non-final status ⇒ isFinalRunStatus(probe.status) is false ⇒ reuse branch (return existing).
      expect(viaWriter!.status).toBe("EXECUTING");
      // The re-probe hit the WRITER, never the replica.
      expect(legacyReplica2.wasHit()).toBe(false);
    }
  );

  // (b) NEW-resident (run-ops id) session run under split: the session row + currentRunId live on the
  // control-plane, but the run itself is on the NEW DB whose replica lags. The probe passes the
  // BRANDED control-plane $replica; the router routes by residency to the NEW store's OWN replica →
  // miss. The writer re-probe (control-plane writer identity) routes to the NEW store's OWN writer →
  // finds the fresh run. Mirrors the live shape (sessions pass the control-plane clients; the run may
  // be NEW-resident under split-ON).
  heteroRunOpsPostgresTest(
    "NEW run-ops id: branded-replica probe misses under NEW-replica lag; writer re-probe finds the live run",
    async ({ prisma14, prisma17 }) => {
      const newReplica = laggingReplica(prisma17, [{ model: "taskRun", mode: "missing" }]);
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

      const seed = seedEnvironmentDedicated("sess_new");
      const runId = `run_${NEW_ID_26}`; // run-ops id → NEW
      await prisma17.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId: "run_sess_new",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "EXECUTING",
        }),
      });

      // Step 1 — the probe routes by residency to the NEW store's OWN (lagging) replica → miss.
      const viaReplica = await router.findRun({ id: runId }, PROBE_SELECT);
      expect(viaReplica).toBeNull();
      expect(newReplica.wasHit()).toBe(true);

      // Step 2 — writer re-probe. Passing the control-plane WRITER (writer identity) routes to the
      // NEW store's OWN writer (never forwarding the control-plane client into the NEW DB) → finds
      // the fresh run with its non-final status → reuse, no double-trigger.
      const newReplica2 = laggingReplica(prisma17, [{ model: "taskRun", mode: "missing" }]);
      const newStore2 = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: newReplica2.client as never,
        schemaVariant: "dedicated",
      });
      const router2 = new RoutingRunStore({ new: newStore2, legacy: legacyStore });
      const viaWriter = (await router2.findRun({ id: runId }, PROBE_SELECT, prisma14)) as {
        status: string;
        friendlyId: string;
      } | null;
      expect(viaWriter).not.toBeNull();
      expect(viaWriter!.friendlyId).toBe("run_sess_new");
      expect(viaWriter!.status).toBe("EXECUTING");
      expect(newReplica2.wasHit()).toBe(false);
    }
  );
});
