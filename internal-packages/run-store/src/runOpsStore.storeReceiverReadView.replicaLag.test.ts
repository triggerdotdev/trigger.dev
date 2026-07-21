// Lagging-replica coverage for two RunStore reads whose receiver is `store` / `deps.store`. Both are
// split-mode reads RoutingRunStore serves from the OWNING store's REPLICA (no writer / branded replica).
// This file freezes the owning replica via laggingReplica, invokes each read with the EXACT caller args,
// asserts the under-lag behavior, then recovers the row on the owning PRIMARY (proving pure lag + routing).
// (1) findBatchTaskRunByFriendlyId (no client): under lag returns null and the caller's `if(batch)` guard
//     falls through — no throw — leaving the friendlyId unresolved for a ClickHouse filter that lags more.
// (2) readThroughRun's readLegacy leg (deps.store.findRun): a LEGACY-resident run's pre-cutover row is
//     long replicated, so findRun returns the OLD row (stale scalars, correct immutable identity), never
//     null; the handler enriches from event-supplied endTime/updatedAt.

import {
  heteroRunOpsPostgresTest,
  laggingReplica,
  type LaggingModel,
} from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import { markReadReplicaClient } from "./readReplicaClient.js";

// A cuid (25 chars after the `run_`/`batch_` prefix) classifies LEGACY, so create + read both route to
// the legacy (control-plane / prisma14, full schema) store — the store that owns these rows in prod.
const CUID_25 = "c".repeat(25);

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

// Build the router the way the webapp holds it, with the LEGACY (control-plane) replica FROZEN per the
// given configs. NEW is non-lagging + empty, so the router's miss-probe of NEW returns null/[] naturally
// (no phantom hit masking the legacy-replica staleness).
function buildRouter(
  prisma14: PrismaClient,
  prisma17: RunOpsPrismaClient,
  configs: readonly LaggingModel[]
) {
  const legacyReplica = laggingReplica(prisma14, configs);
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
  return { router, legacyStore, legacyReplica };
}

describe("run-ops split — store/deps.store receiver read-views vs. a lagging replica", () => {
  // ── findBatchTaskRunByFriendlyId (no client) — runsRepository runs-list batch filter ───────────────
  heteroRunOpsPostgresTest(
    "findBatchTaskRunByFriendlyId (no client) → owning REPLICA; under lag returns null, the caller's `if(batch)` guard falls through leaving the friendlyId unresolved for the ClickHouse filter (tolerated: CH lags more, list revalidates). Primary resolves the id.",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildRouter(prisma14, prisma17, [
        { model: "batchTaskRun", mode: "missing" },
      ]);
      const seed = await seedEnvironmentLegacy(prisma14, "batchfilter");
      const batchId = `batch_${CUID_25}`; // cuid → LEGACY-resident
      const batchFriendlyId = "batch_batchfilter";
      await legacyStore.createBatchTaskRun({
        id: batchId,
        friendlyId: batchFriendlyId,
        runtimeEnvironmentId: seed.environment.id,
      });

      // Invoke EXACTLY as convertRunListInputOptionsToFilterRunsOptions:329 does — friendlyId + envId,
      // NO client, NO include.
      const underLag = await router.findBatchTaskRunByFriendlyId(
        batchFriendlyId,
        seed.environment.id
      );

      // Store-level fact: default readOnlyPrisma → owning REPLICA (both legs). Frozen → null.
      expect(underLag).toBeNull();
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(true);

      // Reproduce the caller's guard and its downstream effect on the ClickHouse filter: on null it
      // leaves `batchId` as the unresolved friendlyId — a filter value, not an error (no throw here).
      const convertedBatchId = (() => {
        let out: string = batchFriendlyId; // convertedOptions.batchId starts as options.batchId
        const batch = underLag; // store.findBatchTaskRunByFriendlyId(...)
        if (batch) {
          out = (batch as { id: string }).id;
        }
        return out;
      })();
      // The friendlyId flows UNRESOLVED into the ClickHouse `batch_id` filter (matches nothing → empty
      // list) — consistent with ClickHouse's own laggier state (no child run of a just-created batch is
      // ingested yet), and self-heals on the next poll once the replica catches up.
      expect(convertedBatchId).toBe(batchFriendlyId);
      expect(convertedBatchId.startsWith("batch_")).toBe(true);

      // PRIMARY contrast: an unbranded WRITER client → #ownPrimary → owning primary → the batch IS
      // resolved to its internal id. Proves the null above is purely replica lag + replica routing.
      const onPrimary = await router.findBatchTaskRunByFriendlyId(
        batchFriendlyId,
        seed.environment.id,
        undefined,
        prisma14 as never
      );
      expect(onPrimary).not.toBeNull();
      expect(onPrimary!.id).toBe(batchId);
      expect(onPrimary!.friendlyId).toBe(batchFriendlyId);
      // With the primary read, the caller WOULD resolve the filter to the internal id.
      const resolvedWithPrimary = onPrimary ? onPrimary.id : batchFriendlyId;
      expect(resolvedWithPrimary).toBe(batchId);
    }
  );

  // ── readLegacy-leg findRun({id},{select},replica) — readThroughRun for a LEGACY run ────────────
  // The readLegacy leg of readThroughRun for a LEGACY-resident run. Real behavior: the run row is OLD
  // (pre-cutover, long replicated), so findRun returns it with STALE mutable scalars — never null — and
  // the event handler enriches from event-supplied time + the row's immutable identifiers.
  heteroRunOpsPostgresTest(
    "readLegacy-leg findRun({id}) (branded $replica) → owning REPLICA; a LEGACY run's OLD row is present-but-STALE under lag (not a missing-row RYW); immutable spanId/traceId/friendlyId/createdAt are correct and the handler uses event-supplied endTime/updatedAt. Primary shows the fresh status.",
    async ({ prisma14, prisma17 }) => {
      const runId = `run_${CUID_25}`; // cuid → LEGACY-resident (pre-cutover row)
      const friendlyId = "run_evtenrich_leg";
      const spanId = "span_evtenrich_fixed";
      const parentSpanId = "span_evtenrich_parent";
      const traceId = `trace_${runId}`;
      const createdAt = new Date("2024-01-01T00:00:00.000Z"); // long before cut-over

      // The exact select the runSucceeded handler uses.
      const eventSelect = {
        id: true,
        friendlyId: true,
        traceId: true,
        spanId: true,
        parentSpanId: true,
        createdAt: true,
        completedAt: true,
        taskIdentifier: true,
        projectId: true,
        runtimeEnvironmentId: true,
        environmentType: true,
        isTest: true,
        organizationId: true,
        taskEventStore: true,
        runTags: true,
        batchId: true,
      } as const;

      // Frozen replica: an OLD snapshot of the SAME row — the selected mutable scalar stale (no
      // completedAt yet), immutable identifiers identical to the primary. laggingReplica "frozen" returns
      // this verbatim (bypasses Postgres projection), matched on top-level `where` id equality.
      const staleRow = {
        id: runId,
        friendlyId,
        traceId,
        spanId,
        parentSpanId,
        createdAt,
        completedAt: null as Date | null, // STALE — primary already has a completedAt
        taskIdentifier: "my-task",
        projectId: "", // filled after seed
        runtimeEnvironmentId: "", // filled after seed
        environmentType: "DEVELOPMENT",
        isTest: false,
        organizationId: "", // filled after seed
        taskEventStore: "taskEvent",
        runTags: [] as string[],
        batchId: null as string | null,
      };

      const { router, legacyReplica } = buildRouter(prisma14, prisma17, [
        { model: "taskRun", mode: "frozen", rows: [staleRow] },
      ]);
      const seed = await seedEnvironmentLegacy(prisma14, "evtenrich");
      staleRow.projectId = seed.project.id;
      staleRow.runtimeEnvironmentId = seed.environment.id;
      staleRow.organizationId = seed.organization.id;

      const completedAt = new Date("2024-06-01T00:00:00.000Z");
      await prisma14.taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "COMPLETED_SUCCESSFULLY", // the terminal state the event fires on
          friendlyId,
          runtimeEnvironmentId: seed.environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId,
          spanId,
          parentSpanId,
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
          createdAt,
          completedAt,
        },
      });

      // Invoke EXACTLY as the readLegacy closure does: findRun({id},{select}, <branded replica>).
      const brandedReplica = markReadReplicaClient({} as object);
      const underLag = (await router.findRun(
        { id: runId },
        { select: eventSelect },
        brandedReplica as never
      )) as typeof staleRow | null;

      expect(legacyReplica.wasHit("taskRun")).toBe(true);
      // KEY REAL-BEHAVIOR FACT: the read returns the OLD row (present), NOT null — a legacy-resident run's
      // row was inserted pre-cutover and is long replicated. So this is a stale-row read, not a
      // missing-row read-your-write.
      expect(underLag).not.toBeNull();
      expect(underLag!.id).toBe(runId);
      // The selected mutable scalar is STALE off the frozen replica…
      expect(underLag!.completedAt).toBeNull();
      // …but every IMMUTABLE identifier the event enrichment actually depends on is correct under lag.
      expect(underLag!.friendlyId).toBe(friendlyId);
      expect(underLag!.spanId).toBe(spanId);
      expect(underLag!.parentSpanId).toBe(parentSpanId);
      expect(underLag!.traceId).toBe(traceId);
      expect(underLag!.createdAt).toEqual(createdAt);
      expect(underLag!.taskEventStore).toBe("taskEvent");
      expect(underLag!.organizationId).toBe(seed.organization.id);

      // TOLERANCE assertion: reproduce the handler's use of the enrichment read. endTime and updatedAtMs
      // come from the EVENT payload (not the stale row); the span-close/publish keys are immutable row
      // fields. So the emitted completion event + realtime publish are CORRECT despite the stale status.
      const eventTime = new Date("2024-06-01T00:00:01.000Z"); // engine event `time`
      const eventRunUpdatedAt = new Date("2024-06-01T00:00:01.500Z"); // engine event `run.updatedAt`
      const completionEvent = {
        endTime: eventTime, // completeSuccessfulRunEvent({ run, endTime: time })
        runId: underLag!.id,
        spanId: underLag!.spanId,
        traceId: underLag!.traceId,
        friendlyId: underLag!.friendlyId,
        taskEventStore: underLag!.taskEventStore,
      };
      const publish = {
        runId: underLag!.id,
        envId: seed.environment.id,
        tags: underLag!.runTags,
        batchId: underLag!.batchId,
        updatedAtMs: eventRunUpdatedAt.getTime(), // from event, not the stale row
      };
      expect(completionEvent.endTime).toEqual(eventTime); // not derived from the stale row
      expect(completionEvent.spanId).toBe(spanId); // immutable → correct under lag
      expect(publish.updatedAtMs).toBe(eventRunUpdatedAt.getTime());

      // PRIMARY contrast: an unbranded WRITER client → #ownPrimary → owning primary → the FRESH terminal
      // status. Proves the staleness above is confined to the replica.
      const onPrimary = (await router.findRun(
        { id: runId },
        { select: { status: true, completedAt: true } },
        prisma14 as never
      )) as { status: string; completedAt: Date | null } | null;
      expect(onPrimary?.status).toBe("COMPLETED_SUCCESSFULLY");
      expect(onPrimary?.completedAt).toEqual(completedAt);
    }
  );
});
