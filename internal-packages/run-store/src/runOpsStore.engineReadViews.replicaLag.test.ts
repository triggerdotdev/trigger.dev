// Property: three run-engine read views tolerate stale/absent values under replica lag. Each issues a
// client-less runStore read, so RoutingRunStore routes it to the OWNING store's REPLICA (readYourWrites
// signal absent). With the replica frozen by the shared laggingReplica, this file asserts what each read
// returns under lag and documents the caller that makes the stale/absent value tolerable. Store built as
// the engine holds it (RoutingRunStore over a legacy + dedicated PostgresRunStore); reads invoked
// exactly as the caller does (same method, no client arg).
//
// Reads covered (one case each):
//   1. concurrencySweeper findRuns — #concurrencySweeperCallback (completedAt <= now-10min)
//   2. resolveTaskRunContext findRun
//   3. forceRequeue span-close findRun (telemetry)
//
// Routing recap: a client-less findRun with an id-classifiable `where` → #findRunRouted → owning store
// findRun → readOnlyPrisma (REPLICA); a client-less findRuns over an id set → #findRunsByIdSet → each
// store's findRuns with client undefined → readOnlyPrisma (REPLICA). All three hit the owning REPLICA.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// A cuid-shaped id (no run-ops v1 marker) classifies LEGACY, so both the create and the id-keyed reads
// route to the legacy (control-plane / prisma14, full schema) store first.
const CUID_25 = "e".repeat(25);

// Mirror of the engine's final-run-status set (getFinalRunStatuses). Inlined to avoid a
// run-store -> run-engine test dependency; concurrencySweeper's `status: { in: ... }` filter only affects the
// PRIMARY-contrast query — the missing-mode replica ignores the where entirely and returns [].
const FINAL_RUN_STATUSES = [
  "CANCELED",
  "INTERRUPTED",
  "COMPLETED_SUCCESSFULLY",
  "COMPLETED_WITH_ERRORS",
  "SYSTEM_FAILURE",
  "CRASHED",
  "EXPIRED",
  "TIMED_OUT",
] as const;

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
  completedAt?: Date | null;
  spanId?: string;
  maxAttempts?: number | null;
  createdAt?: Date;
}) {
  return {
    id: opts.id,
    engine: "V2" as const,
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
    traceId: `trace_${opts.id}`,
    spanId: opts.spanId ?? `span_${opts.id}`,
    queue: "task/my-task",
    isTest: false,
    taskEventStore: "taskEvent",
    depth: 0,
    ...(opts.completedAt !== undefined ? { completedAt: opts.completedAt } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
  };
}

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

describe("run-engine read views under replica lag (client-less -> owning REPLICA)", () => {
  // concurrencySweeper findRuns.
  // The concurrencySweeper callback is handed a set of runIds (from the Redis concurrency set) and asks
  // the store which are FINISHED and completed MORE THAN 10 MINUTES AGO, so it can release their held
  // concurrency. The read is a client-less findRuns → owning REPLICA. Two caller facts make a
  // stale/absent replica tolerable, and this test proves the store-level fact + asserts both:
  //   (a) the `completedAt <= now - 10min` filter: any row that MATCHES was committed to the primary at
  //       least 10 minutes ago, so real replica lag (sub-second..seconds) cannot hide a matching row.
  //   (b) concurrencySweeper runs periodically: a run transiently missed on one scan is re-evaluated on
  //       the next — a miss self-heals, it does not leak concurrency permanently.
  // The consequence of a miss is at worst "concurrency released one scan later", never a wrong release.
  heteroRunOpsPostgresTest(
    "concurrencySweeper findRuns misses the finished run under replica lag",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedEnvironment(prisma14, "sweeper_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      // A genuinely-finished run whose completedAt is 30 min in the past — matches the concurrencySweeper filter.
      const completedAt = new Date(Date.now() - 1000 * 60 * 30);
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId: "run_sweeper_leg",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "COMPLETED_SUCCESSFULLY",
          completedAt,
        }),
      });

      const completedAtOffsetMs = 1000 * 60 * 10; // the caller's default

      // Line-for-line mirror of #concurrencySweeperCallback's read + post-filter.
      const sweeperCallback = async (
        runStore: RoutingRunStore,
        runIds: string[],
        readClient?: unknown
      ) => {
        const runs = (await runStore.findRuns(
          {
            where: {
              id: { in: runIds },
              completedAt: { lte: new Date(Date.now() - completedAtOffsetMs) },
              organizationId: { not: null },
              status: { in: FINAL_RUN_STATUSES as unknown as never },
            },
            select: { id: true, status: true, organizationId: true },
          },
          readClient as never
        )) as Array<{ id: string; status: string; organizationId: string | null }>;
        return runs
          .filter((r) => !!r.organizationId)
          .map((r) => ({ id: r.id, orgId: r.organizationId! }));
      };

      // PRIMARY contrast: thread the writer (as read-your-writes callers do) → the run IS seen. Proves
      // the run genuinely matches the concurrencySweeper predicate, so any miss below is purely the replica read.
      const okReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const routerForPrimary = buildRouter(prisma14, prisma17, okReplica.client);
      const viaPrimary = await sweeperCallback(routerForPrimary, [runId], prisma14);
      expect(viaPrimary).toEqual([{ id: runId, orgId: seed.organization.id }]);

      // ACTUAL caller behavior: client-less findRuns → owning REPLICA. Freeze the legacy replica so the
      // finished run is not visible.
      const lagReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const router = buildRouter(prisma14, prisma17, lagReplica.client);
      const viaReplica = await sweeperCallback(router, [runId]);

      // Store-level fact under lag: concurrencySweeper's read misses the run entirely and returns [].
      expect(lagReplica.wasHit("taskRun")).toBe(true);
      expect(viaReplica).toEqual([]);
      // TOLERATED because (a) a real row matching `completedAt <= now-10min` (here -30min) committed >=10
      // min ago and has surely replicated, and (b) concurrencySweeper re-scans on schedule so a transient miss
      // self-heals — the worst case is concurrency freed one scan later, never a wrong release.
    }
  );

  // resolveTaskRunContext findRun.
  // resolveTaskRunContext builds a V4 TaskRunContext for a run. Its ONLY non-test caller is
  // SpanPresenter #getV4TaskRunContext, a READ-ONLY dashboard presenter that has ALREADY loaded `run`
  // for display and passes run.id. The read is client-less → owning REPLICA. Under lag the store returns
  // a STALE row (asserted below); the resolver copies its scalar fields straight into the display
  // context. Because the sole caller is a read-only span-detail page, a stale field is a cosmetic
  // display artifact that self-heals on the next page load — it drives no mutation or control decision.
  // The extreme case (row wholly absent on the replica) throws a transient 404, likewise a display miss.
  heteroRunOpsPostgresTest(
    "resolveTaskRunContext findRun returns a stale run row under replica lag",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedEnvironment(prisma14, "ctx_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      const friendlyId = "run_ctx_leg";
      // The run has since PROGRESSED on the primary to EXECUTING…
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

      // …but the replica still shows the OLD PENDING snapshot (frozen row). Provide the fields the site
      // asserts on; the legacy read returns this row verbatim (select projection is applied by Postgres,
      // which the frozen replica bypasses, so it returns exactly this shape).
      const staleRow = {
        id: runId,
        friendlyId,
        status: "PENDING",
        runtimeEnvironmentId: seed.environment.id,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
      };
      const lagReplica = laggingReplica(prisma14, [
        { model: "taskRun", mode: "frozen", rows: [staleRow] },
      ]);
      const router = buildRouter(prisma14, prisma17, lagReplica.client);

      // Invoke EXACTLY as resolveTaskRunContext does: client-less findRun({ id }, { select }).
      const run = (await router.findRun(
        { id: runId },
        {
          select: {
            id: true,
            status: true,
            friendlyId: true,
            createdAt: true,
            runtimeEnvironmentId: true,
          },
        }
      )) as { id: string; status: string; friendlyId: string } | null;

      expect(lagReplica.wasHit("taskRun")).toBe(true);
      // Store-level fact: the client-less read is served by the lagging replica → STALE status.
      expect(run).not.toBeNull();
      expect(run!.id).toBe(runId);
      expect(run!.status).toBe("PENDING"); // stale — primary is already EXECUTING

      // Proof the staleness is confined to the replica: the primary read returns the fresh status.
      const onPrimary = (await router.findRun(
        { id: runId },
        { select: { status: true } },
        prisma14
      )) as { status: string } | null;
      expect(onPrimary?.status).toBe("EXECUTING");
      // TOLERATED: the only caller (SpanPresenter #getV4TaskRunContext) is a read-only dashboard
      // presenter — a stale status on the span-detail page self-heals on refresh and drives no mutation.
    }
  );

  // forceRequeue span-close findRun.
  // Inside completeRunAttempt's forceRequeue branch, AFTER the retry/requeue decision has already been
  // made on the primary (retryOutcomeFromCompletion threads this.$.prisma), this client-less findRun
  // re-reads the run purely to shape the `runAttemptFailed` telemetry event (eventBus.emit: status,
  // spanId, createdAt, completedAt, updatedAt). The read is client-less → owning REPLICA. Under lag the
  // store returns a STALE row (asserted below); the stale scalars only populate the emitted span-close
  // event, so a slightly-old status/updatedAt is a cosmetic telemetry artifact — it does not feed the
  // requeue control flow (already decided on the primary). The immutable fields the span close needs
  // (spanId, createdAt) are set at creation and long replicated, so they are correct even under lag.
  heteroRunOpsPostgresTest(
    "forceRequeue span-close findRun returns stale status but correct immutable spanId and createdAt under replica lag",
    async ({ prisma14, prisma17 }) => {
      const seed = await seedEnvironment(prisma14, "requeue_leg");
      const runId = `run_${CUID_25}`; // cuid → LEGACY
      const spanId = "span_requeue_fixed";
      const createdAt = new Date("2024-01-01T00:00:00.000Z");
      // Primary: the run has been requeued back to PENDING with a fresh updatedAt.
      await prisma14.taskRun.create({
        data: taskRunData({
          id: runId,
          friendlyId: "run_requeue_leg",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "PENDING",
          spanId,
          maxAttempts: 3,
          createdAt,
        }),
      });

      // Replica still shows the pre-requeue EXECUTING snapshot with an old updatedAt — but the immutable
      // spanId/createdAt match the primary (they never change after creation).
      const staleRow = {
        id: runId,
        status: "EXECUTING",
        spanId,
        maxAttempts: 3,
        taskEventStore: "taskEvent",
        createdAt,
        completedAt: null as Date | null,
        updatedAt: new Date("2024-01-01T00:00:05.000Z"),
      };
      const lagReplica = laggingReplica(prisma14, [
        { model: "taskRun", mode: "frozen", rows: [staleRow] },
      ]);
      const router = buildRouter(prisma14, prisma17, lagReplica.client);

      // Invoke EXACTLY as the forceRequeue branch does: client-less findRun({ id }, { select }).
      const minimalRun = (await router.findRun(
        { id: runId },
        {
          select: {
            status: true,
            spanId: true,
            maxAttempts: true,
            taskEventStore: true,
            createdAt: true,
            completedAt: true,
            updatedAt: true,
          },
        }
      )) as { status: string; spanId: string; createdAt: Date } | null;

      expect(lagReplica.wasHit("taskRun")).toBe(true);
      expect(minimalRun).not.toBeNull();
      // Store-level fact: mutable fields are STALE off the replica…
      expect(minimalRun!.status).toBe("EXECUTING"); // stale — primary already PENDING (requeued)
      // …but the fields the span close actually depends on are immutable and correct even under lag.
      expect(minimalRun!.spanId).toBe(spanId);
      expect(minimalRun!.createdAt).toEqual(createdAt);

      // Confirm the staleness is replica-only: the primary read shows the requeued PENDING status.
      const onPrimary = (await router.findRun(
        { id: runId },
        { select: { status: true } },
        prisma14
      )) as { status: string } | null;
      expect(onPrimary?.status).toBe("PENDING");
      // TOLERATED: the read's result is only fed to eventBus.emit("runAttemptFailed", ...) (span-close
      // telemetry). The requeue decision was already made on the primary; a stale status/updatedAt in
      // the emitted event is cosmetic and does not alter control flow.
    }
  );
});
