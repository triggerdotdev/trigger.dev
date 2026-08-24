// Lagging-replica coverage for the run-GET / run-detail read views ("routes-run-get"). Each read is
// exercised against real Postgres with the owning store's replica FROZEN via laggingReplica, driving the
// exact exported route caller that issues it. Every read RoutingRunStore serves from the OWNING store's
// REPLICA — a client-less findRun/findTaskRunAttempt, or a findRun passed the BRANDED $replica (the brand
// keeps the read on a replica, it does not escalate). We build the router exactly as ~/v3/runStore.server
// holds it (legacy + dedicated PostgresRunStore) and invoke each read as the caller does.
//
// Shared tolerance, asserted concretely per read: the fields that drive any control decision
// (routing/auth/redirect/queue keys — projectId, runtimeEnvironmentId, organizationId, spanId, traceId,
// createdAt, engine, queue, concurrencyKey, taskEventStore) are IMMUTABLE, so even a STALE replica row
// carries correct values. The only lag effect is transient ABSENCE → a not-found/error-redirect/empty
// display that self-heals on the next load and drives no mutation. Displayed mutable fields (status,
// cost, completedAt, output) are cosmetic and self-heal.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import { markReadReplicaClient } from "./readReplicaClient.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// A cuid-shaped id (25 chars, no run-ops v1 marker) classifies LEGACY, so a friendlyId-keyed read
// routes to the legacy (control-plane / prisma14, full schema) store's replica first.
const CUID_25 = "e".repeat(25);
// A v1-marked 26-char body classifies NEW, routing to the dedicated (#new / prisma17) store — used for
// the findTaskRunAttempt case so we can freeze the NEW replica without control-plane FK seeding.
const NEW_ID_26 = "k".repeat(24) + "01";

// Final attempt statuses (FINAL_ATTEMPT_STATUSES). Inlined to avoid a run-store→webapp
// test dependency; only used to mirror the caller's findTaskRunAttempt `where`.
const FINAL_ATTEMPT_STATUSES = ["COMPLETED", "FAILED", "CANCELED"] as const;

async function seedLegacyEnvironment(prisma: PrismaClient, suffix: string) {
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
  engine?: "V1" | "V2";
  createdAt?: Date;
  completedAt?: Date | null;
  concurrencyKey?: string | null;
  traceId?: string;
}) {
  return {
    id: opts.id,
    engine: (opts.engine ?? "V2") as "V1" | "V2",
    status: (opts.status ?? "PENDING") as never,
    friendlyId: opts.friendlyId,
    runtimeEnvironmentId: opts.runtimeEnvironmentId,
    environmentType: "DEVELOPMENT" as const,
    organizationId: opts.organizationId,
    projectId: opts.projectId,
    taskIdentifier: "my-task",
    payload: "{}",
    payloadType: "application/json",
    traceContext: {},
    traceId: opts.traceId ?? `trace_${opts.id}`,
    spanId: opts.spanId ?? `span_${opts.id}`,
    queue: "task/my-task",
    isTest: false,
    taskEventStore: "taskEvent",
    depth: 0,
    ...(opts.concurrencyKey !== undefined ? { concurrencyKey: opts.concurrencyKey } : {}),
    ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
    ...(opts.completedAt !== undefined ? { completedAt: opts.completedAt } : {}),
  };
}

// Build the router exactly as runStore.server holds it: a legacy store (prisma14) + a dedicated store
// (prisma17). Either store's REPLICA (readOnlyPrisma) can be swapped for a frozen client so a
// friendlyId/id-routed read is served stale.
function buildRouter(
  prisma14: PrismaClient,
  prisma17: unknown,
  opts?: { legacyReplica?: AnyClient; newReplica?: AnyClient }
): RoutingRunStore {
  const legacyStore = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: (opts?.legacyReplica ?? prisma14) as never,
    schemaVariant: "legacy",
  });
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: (opts?.newReplica ?? prisma17) as never,
    schemaVariant: "dedicated",
  });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

describe("routes-run-get read views under replica lag (owning REPLICA)", () => {
  // orgs redirect — legacy canonical redirect.
  // Reads a run by friendlyId to get { projectId, runtimeEnvironmentId } and redirects to the v3 run
  // path. Both selected fields are IMMUTABLE (set at creation).
  //  (a) frozen-missing replica → null → the loader throws 404. Tolerated: this is a GET navigation, the
  //      run list the link came from is served by the same replica, and a transient not-found self-heals
  //      on the next load; it drives no mutation.
  //  (b) frozen-STALE replica (run has since progressed to EXECUTING) → the decision fields projectId /
  //      runtimeEnvironmentId are STILL CORRECT because they never change — so the redirect target is
  //      right even off a lagging replica.
  heteroRunOpsPostgresTest(
    "orgs redirect findRun: frozen-missing → null (transient 404, self-heals); frozen-stale → immutable projectId/runtimeEnvironmentId still correct",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedLegacyEnvironment(prisma14, "site1_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      const friendlyId = "run_site1";
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "EXECUTING", // primary is already progressed
        }),
      });

      const site1 = (router: RoutingRunStore) =>
        router.findRun(
          { friendlyId },
          { select: { projectId: true, runtimeEnvironmentId: true } }
        ) as Promise<{ projectId: string; runtimeEnvironmentId: string } | null>;

      // (a) missing: replica has not replicated the run → null → 404.
      const missing = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const viaMissing = await site1(
        buildRouter(prisma14, prisma17, { legacyReplica: missing.client })
      );
      expect(missing.wasHit("taskRun")).toBe(true);
      expect(viaMissing).toBeNull();

      // Primary contrast: the run genuinely exists (so the null above was purely the lagging replica).
      const onPrimary = (await buildRouter(prisma14, prisma17).findRun(
        { friendlyId },
        { select: { projectId: true, runtimeEnvironmentId: true } },
        prisma14
      )) as { projectId: string } | null;
      expect(onPrimary?.projectId).toBe(seed.project.id);

      // (b) stale: replica shows the OLD PENDING snapshot — but the redirect's decision fields are
      // immutable, so the stale row still carries the correct projectId / runtimeEnvironmentId.
      const staleRow = {
        friendlyId,
        projectId: seed.project.id,
        runtimeEnvironmentId: seed.environment.id,
        status: "PENDING",
      };
      const frozen = laggingReplica(prisma14, [
        { model: "taskRun", mode: "frozen", rows: [staleRow] },
      ]);
      const viaStale = await site1(
        buildRouter(prisma14, prisma17, { legacyReplica: frozen.client })
      );
      expect(frozen.wasHit("taskRun")).toBe(true);
      expect(viaStale).not.toBeNull();
      expect(viaStale!.projectId).toBe(seed.project.id);
      expect(viaStale!.runtimeEnvironmentId).toBe(seed.environment.id);
    }
  );

  // run inspector loader.
  // The run inspector fetcher reads a run by friendlyId for a large DISPLAY projection.
  // frozen-missing → null → 404 on the fetcher, which self-heals on the next poll/refresh.
  // frozen-stale → a stale status/cost is displayed (cosmetic); the immutable id/projectId/
  // runtimeEnvironmentId/createdAt that gate the follow-on auth + attempt reads are still correct.
  heteroRunOpsPostgresTest(
    "run inspector findRun: frozen-missing → null (fetcher 404 self-heals); frozen-stale → status cosmetic-stale but immutable id/projectId/createdAt correct",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedLegacyEnvironment(prisma14, "site2_leg");
      const runId = `run_${CUID_25}`;
      const friendlyId = "run_site2";
      const createdAt = new Date("2024-01-01T00:00:00.000Z");
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "COMPLETED_SUCCESSFULLY", // primary finished
          createdAt,
        }),
      });

      const select = {
        id: true,
        friendlyId: true,
        status: true,
        projectId: true,
        runtimeEnvironmentId: true,
        createdAt: true,
      } as const;
      const site2 = (router: RoutingRunStore) =>
        router.findRun({ friendlyId }, { select }) as Promise<{
          id: string;
          status: string;
          projectId: string;
          createdAt: Date;
          runtimeEnvironmentId: string;
        } | null>;

      const missing = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const viaMissing = await site2(
        buildRouter(prisma14, prisma17, { legacyReplica: missing.client })
      );
      expect(missing.wasHit("taskRun")).toBe(true);
      expect(viaMissing).toBeNull();

      const staleRow = {
        id: runId,
        friendlyId,
        status: "EXECUTING", // stale — primary is COMPLETED_SUCCESSFULLY
        projectId: seed.project.id,
        runtimeEnvironmentId: seed.environment.id,
        createdAt,
      };
      const frozen = laggingReplica(prisma14, [
        { model: "taskRun", mode: "frozen", rows: [staleRow] },
      ]);
      const viaStale = await site2(
        buildRouter(prisma14, prisma17, { legacyReplica: frozen.client })
      );
      expect(frozen.wasHit("taskRun")).toBe(true);
      expect(viaStale).not.toBeNull();
      expect(viaStale!.status).toBe("EXECUTING"); // cosmetic-stale (display only)
      // Immutable decision fields correct even off the lagging replica:
      expect(viaStale!.id).toBe(runId);
      expect(viaStale!.projectId).toBe(seed.project.id);
      expect(viaStale!.runtimeEnvironmentId).toBe(seed.environment.id);
      expect(viaStale!.createdAt).toEqual(createdAt);

      // Primary shows the fresh status — proving the staleness is confined to the replica.
      const onPrimary = (await buildRouter(prisma14, prisma17).findRun(
        { friendlyId },
        { select: { status: true } },
        prisma14
      )) as { status: string } | null;
      expect(onPrimary?.status).toBe("COMPLETED_SUCCESSFULLY");
    }
  );

  // finished-attempt output findTaskRunAttempt.
  // On a finished run, the inspector reads the final TaskRunAttempt (client-less) purely to display its
  // output/error. A classifiable taskRunId routes to the owning store's REPLICA. Routed here via a
  // run-ops id so we can freeze the #new replica without control-plane FK seeding. Under lag the read
  // misses the live attempt (returns null) → the panel shows empty output on a finished run, which
  // self-heals on the next load; it drives no mutation.
  heteroRunOpsPostgresTest(
    "finished-attempt findTaskRunAttempt: frozen-missing NEW replica misses the live attempt (null) — empty-output display self-heals; primary sees it",
    async ({ prisma14, prisma17 }) => {
      const runId = `run_${NEW_ID_26}`; // run-ops id → NEW (#new / prisma17)
      const attemptId = `attempt_${NEW_ID_26}`;
      // Seed run + attempt on the dedicated (#new) primary. The dedicated subset schema does not enforce
      // the control-plane FKs, so synthetic org/proj/env ids are fine (mirrors batchProbeReadClient).
      await prisma17.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId: "run_site3",
          organizationId: "org_site3",
          projectId: "proj_site3",
          runtimeEnvironmentId: "env_site3",
          status: "COMPLETED_SUCCESSFULLY",
        }) as never,
      });
      await prisma17.taskRunAttempt.create({
        data: {
          id: attemptId,
          number: 1,
          friendlyId: "attempt_site3",
          taskRunId: runId,
          backgroundWorkerId: `bw_${NEW_ID_26}`,
          backgroundWorkerTaskId: `bwt_${NEW_ID_26}`,
          runtimeEnvironmentId: "env_site3",
          queueId: `queue_${NEW_ID_26}`,
          status: "COMPLETED",
          output: '{"ok":true}',
          outputType: "application/json",
        } as never,
      });

      const site3 = (router: RoutingRunStore) =>
        router.findTaskRunAttempt({
          select: { output: true, outputType: true, error: true },
          where: {
            status: { in: FINAL_ATTEMPT_STATUSES as unknown as never },
            taskRunId: runId,
          },
          orderBy: { createdAt: "desc" },
        }) as Promise<{ output: string | null } | null>;

      // Freeze the NEW replica (taskRunAttempt missing) → client-less read served there misses it.
      const missing = laggingReplica(prisma17 as AnyClient, [
        { model: "taskRunAttempt", mode: "missing" },
      ]);
      const viaReplica = await site3(
        buildRouter(prisma14, prisma17, { newReplica: missing.client })
      );
      expect(missing.wasHit("taskRunAttempt")).toBe(true);
      expect(viaReplica).toBeNull(); // empty output shown on a finished run; self-heals

      // Primary contrast: threading the writer finds the live attempt (proves the miss was pure lag).
      const onPrimary = await site3(buildRouter(prisma14, prisma17)).then(() =>
        buildRouter(prisma14, prisma17).findTaskRunAttempt(
          {
            select: { output: true, outputType: true, error: true },
            where: {
              status: { in: FINAL_ATTEMPT_STATUSES as unknown as never },
              taskRunId: runId,
            },
            orderBy: { createdAt: "desc" },
          },
          prisma17 as never
        )
      );
      expect(onPrimary).not.toBeNull();
      expect((onPrimary as { output: string }).output).toBe('{"ok":true}');
    }
  );

  // public short-link redirect.
  // Reads a run by friendlyId for { spanId, projectId, runtimeEnvironmentId } and redirects to the v3
  // run path (attaching ?span=). All three fields are IMMUTABLE. frozen-missing →
  // null → redirectWithErrorMessage ("run doesn't exist or no permission") — a transient error redirect
  // that self-heals; frozen-stale → spanId/projectId/runtimeEnvironmentId still correct.
  heteroRunOpsPostgresTest(
    "short-link redirect findRun: frozen-missing → null (transient error redirect); frozen-stale → immutable spanId/projectId/runtimeEnvironmentId correct",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedLegacyEnvironment(prisma14, "site4_leg");
      const runId = `run_${CUID_25}`;
      const friendlyId = "run_site4";
      const spanId = "span_site4_fixed";
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "EXECUTING",
          spanId,
        }),
      });

      const site4 = (router: RoutingRunStore) =>
        router.findRun(
          { friendlyId },
          { select: { spanId: true, projectId: true, runtimeEnvironmentId: true } }
        ) as Promise<{ spanId: string; projectId: string; runtimeEnvironmentId: string } | null>;

      const missing = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const viaMissing = await site4(
        buildRouter(prisma14, prisma17, { legacyReplica: missing.client })
      );
      expect(missing.wasHit("taskRun")).toBe(true);
      expect(viaMissing).toBeNull();

      const staleRow = {
        friendlyId,
        spanId,
        projectId: seed.project.id,
        runtimeEnvironmentId: seed.environment.id,
      };
      const frozen = laggingReplica(prisma14, [
        { model: "taskRun", mode: "frozen", rows: [staleRow] },
      ]);
      const viaStale = await site4(
        buildRouter(prisma14, prisma17, { legacyReplica: frozen.client })
      );
      expect(frozen.wasHit("taskRun")).toBe(true);
      expect(viaStale).not.toBeNull();
      expect(viaStale!.spanId).toBe(spanId);
      expect(viaStale!.projectId).toBe(seed.project.id);
      expect(viaStale!.runtimeEnvironmentId).toBe(seed.environment.id);

      const onPrimary = (await buildRouter(prisma14, prisma17).findRun(
        { friendlyId },
        { select: { spanId: true } },
        prisma14
      )) as { spanId: string } | null;
      expect(onPrimary?.spanId).toBe(spanId);
    }
  );

  // admin queue-debug loader.
  // Reads a run by friendlyId for { id, engine, queue, concurrencyKey, runtimeEnvironmentId, projectId }
  // and introspects the run-queue Redis sets. frozen-missing → null → 404 on an
  // admin debug tool (self-heals); frozen-stale → engine/queue/concurrencyKey (all immutable) still
  // correct, so the Redis keys it builds are the right ones even off a lagging replica.
  heteroRunOpsPostgresTest(
    "debug findRun: frozen-missing → null (admin-tool 404 self-heals); frozen-stale → immutable engine/queue/concurrencyKey correct",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedLegacyEnvironment(prisma14, "site5_leg");
      const runId = `run_${CUID_25}`;
      const friendlyId = "run_site5";
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "EXECUTING",
          engine: "V2",
          concurrencyKey: "ck-site5",
        }),
      });

      const select = {
        id: true,
        engine: true,
        friendlyId: true,
        queue: true,
        concurrencyKey: true,
        runtimeEnvironmentId: true,
        projectId: true,
      } as const;
      const site5 = (router: RoutingRunStore) =>
        router.findRun({ friendlyId }, { select }) as Promise<{
          engine: string;
          queue: string;
          concurrencyKey: string | null;
          projectId: string;
        } | null>;

      const missing = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const viaMissing = await site5(
        buildRouter(prisma14, prisma17, { legacyReplica: missing.client })
      );
      expect(missing.wasHit("taskRun")).toBe(true);
      expect(viaMissing).toBeNull();

      const staleRow = {
        id: runId,
        friendlyId,
        engine: "V2",
        queue: "task/my-task",
        concurrencyKey: "ck-site5",
        runtimeEnvironmentId: seed.environment.id,
        projectId: seed.project.id,
      };
      const frozen = laggingReplica(prisma14, [
        { model: "taskRun", mode: "frozen", rows: [staleRow] },
      ]);
      const viaStale = await site5(
        buildRouter(prisma14, prisma17, { legacyReplica: frozen.client })
      );
      expect(frozen.wasHit("taskRun")).toBe(true);
      expect(viaStale).not.toBeNull();
      expect(viaStale!.engine).toBe("V2");
      expect(viaStale!.queue).toBe("task/my-task");
      expect(viaStale!.concurrencyKey).toBe("ck-site5");
      expect(viaStale!.projectId).toBe(seed.project.id);

      const onPrimary = (await buildRouter(prisma14, prisma17).findRun(
        { friendlyId },
        { select: { queue: true } },
        prisma14
      )) as { queue: string } | null;
      expect(onPrimary?.queue).toBe("task/my-task");
    }
  );

  // log-detail run-status annotation.
  // This caller is DISTINCT: it passes the BRANDED $replica as the 3rd findRun arg. The brand is a
  // read-replica signal, so readYourWrites=false and the read STAYS on the owning REPLICA (the brand
  // never escalates to the primary). The result is used only as `runStatus = run?.status` — an OPTIONAL
  // display annotation on a log-detail row. First prove the branded client does
  // NOT route to primary (frozen-stale → the read returns the STALE status), then that missing → null →
  // runStatus undefined (the caller optional-chains and tolerates it). Contrast: an UNBRANDED writer
  // escalates to the primary → fresh status.
  heteroRunOpsPostgresTest(
    "log-detail findRun(branded $replica): brand keeps read on REPLICA → stale status (tolerated via run?.status); unbranded writer escalates to fresh",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedLegacyEnvironment(prisma14, "site6_leg");
      const runId = `run_${CUID_25}`;
      const friendlyId = "run_site6";
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "COMPLETED_SUCCESSFULLY", // primary finished
        }),
      });

      // Frozen replica shows the stale EXECUTING snapshot and backs the legacy store's readOnlyPrisma.
      const staleRow = {
        friendlyId,
        runtimeEnvironmentId: seed.environment.id,
        status: "EXECUTING",
      };
      const frozen = laggingReplica(prisma14, [
        { model: "taskRun", mode: "frozen", rows: [staleRow] },
      ]);
      const router = buildRouter(prisma14, prisma17, { legacyReplica: frozen.client });

      // The 3rd findRun arg is a ROUTING SIGNAL only — the router reads its presence + brand and never
      // forwards it to the store (the store always reads its own readOnlyPrisma). So a standalone
      // branded object faithfully stands in for the branded $replica the caller passes, without leaking
      // the brand onto prisma14 (branding the frozen Proxy would forward the symbol to its writer target
      // and wrongly mark prisma14 as a replica).
      const brandedReplicaSignal = markReadReplicaClient({}) as AnyClient;

      // Invoke EXACTLY as the caller does: findRun(where, {select:{status}}, $replica-branded).
      const run = (await router.findRun(
        { friendlyId, runtimeEnvironmentId: seed.environment.id },
        { select: { status: true } },
        brandedReplicaSignal as never
      )) as { status: string } | null;
      const runStatus = run?.status; // the caller's runStatus

      expect(frozen.wasHit("taskRun")).toBe(true);
      // The BRANDED client did NOT escalate to primary: the read is served by the (stale) replica.
      expect(runStatus).toBe("EXECUTING"); // stale — primary is COMPLETED_SUCCESSFULLY
      // Tolerated: runStatus is only a display annotation on the log row (`run?.status`), self-heals.

      // Contrast: an UNBRANDED writer IS a read-your-writes signal → escalates to primary → fresh.
      const viaWriter = (await router.findRun(
        { friendlyId, runtimeEnvironmentId: seed.environment.id },
        { select: { status: true } },
        prisma14
      )) as { status: string } | null;
      expect(viaWriter?.status).toBe("COMPLETED_SUCCESSFULLY");

      // And missing → null → runStatus undefined (optional, tolerated).
      const missing = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const routerMissing = buildRouter(prisma14, prisma17, { legacyReplica: missing.client });
      const runMissing = (await routerMissing.findRun(
        { friendlyId, runtimeEnvironmentId: seed.environment.id },
        { select: { status: true } },
        brandedReplicaSignal as never
      )) as { status: string } | null;
      expect(missing.wasHit("taskRun")).toBe(true);
      expect(runMissing?.status).toBeUndefined();
    }
  );

  // trace-export download.
  // Reads a run by friendlyId for the trace-export window + auth: { friendlyId, traceId, organizationId,
  // runtimeEnvironmentId, createdAt, completedAt, taskEventStore, taskIdentifier }.
  // frozen-missing → null → the buffer fallback (or 404) handles it, self-heals. frozen-stale is SAFE:
  // every field the ClickHouse trace query keys on — traceId, organizationId, runtimeEnvironmentId,
  // createdAt, taskEventStore — is IMMUTABLE; the only mutable field, completedAt, is used as the export
  // END bound (`run.completedAt ?? undefined`), and a stale null just yields an OPEN-ENDED window (a
  // superset of events), never a truncated/lossy export.
  heteroRunOpsPostgresTest(
    "trace-download findRun: frozen-missing → null (buffer fallback self-heals); frozen-stale → immutable traceId/org/createdAt correct, stale null completedAt = open-ended (superset) not lossy",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedLegacyEnvironment(prisma14, "site7_leg");
      const runId = `run_${CUID_25}`;
      const friendlyId = "run_site7";
      const traceId = "trace_site7_fixed";
      const createdAt = new Date("2024-01-01T00:00:00.000Z");
      const completedAt = new Date("2024-01-01T00:05:00.000Z");
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "COMPLETED_SUCCESSFULLY",
          traceId,
          createdAt,
          completedAt, // primary: the run has completed
        }),
      });

      const select = {
        friendlyId: true,
        traceId: true,
        organizationId: true,
        runtimeEnvironmentId: true,
        createdAt: true,
        completedAt: true,
        taskEventStore: true,
        taskIdentifier: true,
      } as const;
      const site7 = (router: RoutingRunStore) =>
        router.findRun({ friendlyId }, { select }) as Promise<{
          traceId: string;
          organizationId: string | null;
          createdAt: Date;
          completedAt: Date | null;
          taskEventStore: string;
        } | null>;

      const missing = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const viaMissing = await site7(
        buildRouter(prisma14, prisma17, { legacyReplica: missing.client })
      );
      expect(missing.wasHit("taskRun")).toBe(true);
      expect(viaMissing).toBeNull();

      // Stale replica: still-RUNNING snapshot, completedAt null (not yet replicated), old status.
      const staleRow = {
        friendlyId,
        traceId,
        organizationId: seed.organization.id,
        runtimeEnvironmentId: seed.environment.id,
        createdAt,
        completedAt: null as Date | null, // stale — primary already has a completedAt
        taskEventStore: "taskEvent",
        taskIdentifier: "my-task",
      };
      const frozen = laggingReplica(prisma14, [
        { model: "taskRun", mode: "frozen", rows: [staleRow] },
      ]);
      const viaStale = await site7(
        buildRouter(prisma14, prisma17, { legacyReplica: frozen.client })
      );
      expect(frozen.wasHit("taskRun")).toBe(true);
      expect(viaStale).not.toBeNull();
      // Immutable trace-query keys correct even off the lagging replica:
      expect(viaStale!.traceId).toBe(traceId);
      expect(viaStale!.organizationId).toBe(seed.organization.id);
      expect(viaStale!.createdAt).toEqual(createdAt);
      expect(viaStale!.taskEventStore).toBe("taskEvent");
      // The one mutable field is the export END bound: a stale null → open-ended window (superset), the
      // export streams MORE events, never fewer — not a lossy/truncated download.
      expect(viaStale!.completedAt).toBeNull();

      const onPrimary = (await buildRouter(prisma14, prisma17).findRun(
        { friendlyId },
        { select: { completedAt: true } },
        prisma14
      )) as { completedAt: Date | null } | null;
      expect(onPrimary?.completedAt).toEqual(completedAt); // primary has the real end bound
    }
  );
});
