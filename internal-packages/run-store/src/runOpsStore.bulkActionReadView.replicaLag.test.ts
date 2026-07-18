// Lagging-replica coverage for BULK ACTION member hydration on the run-ops split. BulkActionV2's
// CANCEL and REPLAY branches hydrate each batch's runs via a client-less id-set findRuns, so the bounded
// id-set path reads each OWNING store's REPLICA: a run on its owning PRIMARY but not yet on that store's
// REPLICA is dropped → a PARTIAL merge. Both are tolerated: the id set comes from a ClickHouse list fed
// DOWNSTREAM of Postgres, so a not-yet-replicated run isn't in ClickHouse yet and lands in a later page.
// The tests FORCE the (in-practice-unreachable) stale window at the store, prove the merge drops the
// lagging-store row, and prove that row really exists on the primary.
// Real split topology via heteroRunOpsPostgresTest — NEVER mocked.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput, RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// classifyResidency routes a run-ops v1 body → NEW, everything else → LEGACY.
const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / prisma14, full schema)

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
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "COMPLETED_SUCCESSFULLY",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      traceContext: { trace: "ctx" },
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "FINISHED",
      description: "Run finished",
      runStatus: "COMPLETED_SUCCESSFULLY",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

// Exactly the projection the CANCEL branch reads.
const CANCEL_SELECT = {
  id: true,
  engine: true,
  friendlyId: true,
  status: true,
  createdAt: true,
  completedAt: true,
  taskEventStore: true,
} as const;

describe("run-ops split — bulk-action member hydration (id-set findRuns) vs. a lagging replica", () => {
  // CANCEL branch. The id set is ClickHouse-sourced; here we FORCE the (in practice
  // unreachable) stale window: freeze the LEGACY replica while a LEGACY-resident run lives on the
  // LEGACY primary, and put a second, NEW-resident run whose replica is live in the same batch.
  // The no-client findRuns(id-set) drops the lagging-store row and keeps the other → PARTIAL merge.
  // Tolerated: the drop is safe because an id only reaches this batch after ClickHouse (which lags
  // MORE than the PG replica) has it, by which point the PG replica already has the row.
  heteroRunOpsPostgresTest(
    "cancel: id-set findRuns (no client) drops the lagging-legacy-replica run, keeps the live-new-replica run",
    async ({ prisma14, prisma17 }) => {
      // LEGACY replica frozen; NEW replica live.
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

      const legacySeed = await seedEnvironment(prisma14, "legacy", "bulk_cancel_leg");
      const laggingRunId = `run_${CUID_25}`; // cuid → LEGACY (owning replica is frozen)
      await legacyStore.createRun(
        buildCreateRunInput({
          runId: laggingRunId,
          friendlyId: "run_bulk_cancel_leg",
          organizationId: legacySeed.organization.id,
          projectId: legacySeed.project.id,
          runtimeEnvironmentId: legacySeed.environment.id,
        })
      );

      const newSeed = await seedEnvironment(prisma17, "dedicated", "bulk_cancel_new");
      const liveRunId = `run_${generateRunOpsId()}`; // v1 body → NEW (owning replica is live)
      await newStore.createRun(
        buildCreateRunInput({
          runId: liveRunId,
          friendlyId: "run_bulk_cancel_new",
          organizationId: newSeed.organization.id,
          projectId: newSeed.project.id,
          runtimeEnvironmentId: newSeed.environment.id,
        })
      );

      // EXACT call site — id set from listRunIds, select projection, NO client.
      const runIdsToProcess = [laggingRunId, liveRunId];
      const runs = (await router.findRuns({
        where: { id: { in: runIdsToProcess } },
        select: CANCEL_SELECT,
      })) as Array<{ id: string }>;

      // Fact: the lagging LEGACY replica returned nothing for its run, so the merge is
      // PARTIAL — only the live-replica (NEW) run survives. The cancel branch would iterate just
      // that one run this batch; the lagging one is silently absent from `runs`.
      const ids = runs.map((r) => r.id).sort();
      expect(ids).toEqual([liveRunId]);
      expect(ids).not.toContain(laggingRunId);
      expect(legacyReplica.wasHit()).toBe(true);

      // The dropped run genuinely exists on the LEGACY primary — prove the miss is pure lag/routing,
      // not a nonexistent row: re-read with the WRITER (→ owning primaries) returns BOTH.
      const viaPrimary = (await router.findRuns(
        { where: { id: { in: runIdsToProcess } }, select: CANCEL_SELECT },
        prisma14 as never
      )) as Array<{ id: string }>;
      expect(viaPrimary.map((r) => r.id).sort()).toEqual([laggingRunId, liveRunId].sort());
      // Tolerated: batch ids are ClickHouse-sourced (lags more than the PG replica) — see header.
    }
  );

  // REPLAY branch. Same id-set read, full row (no select), roles swapped so the OTHER
  // owning store lags: freeze the NEW replica, keep LEGACY live. Same tolerance as above.
  heteroRunOpsPostgresTest(
    "replay: id-set findRuns (no client, full row) drops the lagging-new-replica run, keeps the live-legacy-replica run",
    async ({ prisma14, prisma17 }) => {
      // NEW replica frozen; LEGACY replica live.
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

      const newSeed = await seedEnvironment(prisma17, "dedicated", "bulk_replay_new");
      const laggingRunId = `run_${generateRunOpsId()}`; // v1 body → NEW (owning replica is frozen)
      await newStore.createRun(
        buildCreateRunInput({
          runId: laggingRunId,
          friendlyId: "run_bulk_replay_new",
          organizationId: newSeed.organization.id,
          projectId: newSeed.project.id,
          runtimeEnvironmentId: newSeed.environment.id,
        })
      );

      const legacySeed = await seedEnvironment(prisma14, "legacy", "bulk_replay_leg");
      const liveRunId = `run_${CUID_25}`; // cuid → LEGACY (owning replica is live)
      await legacyStore.createRun(
        buildCreateRunInput({
          runId: liveRunId,
          friendlyId: "run_bulk_replay_leg",
          organizationId: legacySeed.organization.id,
          projectId: legacySeed.project.id,
          runtimeEnvironmentId: legacySeed.environment.id,
        })
      );

      // EXACT call site — id set from listRunIds, FULL row (no select), NO client.
      const runIdsToProcess = [laggingRunId, liveRunId];
      const runs = (await router.findRuns({
        where: { id: { in: runIdsToProcess } },
      })) as Array<{ id: string }>;

      // Fact: the frozen NEW replica returns nothing for its run; only the live LEGACY
      // run survives the merge. The replay branch would replay just that one run this batch.
      const ids = runs.map((r) => r.id).sort();
      expect(ids).toEqual([liveRunId]);
      expect(ids).not.toContain(laggingRunId);
      expect(newReplica.wasHit()).toBe(true);

      // The dropped NEW run genuinely exists on the NEW primary: re-read with the WRITER returns BOTH.
      const viaPrimary = (await router.findRuns(
        { where: { id: { in: runIdsToProcess } } },
        prisma17 as never
      )) as Array<{ id: string }>;
      expect(viaPrimary.map((r) => r.id).sort()).toEqual([laggingRunId, liveRunId].sort());
      // Tolerated: batch ids are ClickHouse-sourced (lags more than the PG replica) — see header.
    }
  );
});
