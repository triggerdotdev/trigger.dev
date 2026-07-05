// createExecutionSnapshot's legacy branch records completed waitpoints via Prisma `connect` on the
// implicit _completedWaitpoints M2M, whose FK to Waitpoint rejects a cross-DB (NEW-resident) token.
// A LEGACY parent doing triggerAndWait on a NEW child completes on the NEW token; the resume snapshot
// (routed to #legacy) then connects that NEW token -> FK violation -> the legacy parent hangs forever.
// Fix: drop _completedWaitpoints_B_fkey (migration); with the FK gone the connect records the cross-DB
// link (app-enforced integrity). Real two-DB topology; never mocked.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput } from "./types.js";

const CUID_25 = "c".repeat(25); // LEGACY run -> #legacy (prisma14)

function makeRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
  const legacyStore = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14,
    schemaVariant: "legacy",
  });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
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
      type: "PRODUCTION",
      slug: `prod-${suffix}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
      maximumConcurrencyLimit: 10,
    },
  });
  return { organization, project, environment };
}

function buildCreateRunInput(p: {
  runId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: p.runId,
      engine: "V2",
      status: "EXECUTING",
      friendlyId: "run_cwc",
      runtimeEnvironmentId: p.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      organizationId: p.organizationId,
      projectId: p.projectId,
      taskIdentifier: "cwc-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${p.runId}`,
      spanId: `span_${p.runId}`,
      runTags: [],
      queue: "task/cwc-task",
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
      environmentId: p.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      projectId: p.projectId,
      organizationId: p.organizationId,
    },
  };
}

describe("run-ops split — a LEGACY snapshot can record a cross-DB completed waitpoint (NEW-resident token)", () => {
  heteroRunOpsPostgresTest(
    "createExecutionSnapshot connects a NEW-resident completed token to a LEGACY run's snapshot",
    async ({ prisma14, prisma17 }: { prisma14: PrismaClient; prisma17: RunOpsPrismaClient }) => {
      const router = makeRouter(prisma14, prisma17);
      // The harness builds the schema with `prisma db push`, which re-creates the FK that migration
      // 20260705230000 drops in prod. Mirror the drop on this clone so the connect exercises prod state.
      await prisma14.$executeRawUnsafe(
        `ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"`
      );
      const env = await seedEnvironmentLegacy(prisma14, "cwc");
      const runId = `run_${CUID_25}`; // LEGACY run -> #legacy
      await router.createRun(
        buildCreateRunInput({
          runId,
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );
      const created = await router.findLatestExecutionSnapshot(runId);

      // A completed token minted co-located with a NEW child -> its Waitpoint row lives on #new.
      const tokenId = "waitpoint_" + "y".repeat(20);
      await prisma17.waitpoint.create({
        data: {
          id: tokenId,
          friendlyId: "wp_cwc",
          type: "MANUAL",
          status: "COMPLETED",
          completedAt: new Date(),
          idempotencyKey: `idem_${tokenId}`,
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });

      const snap = await router.createExecutionSnapshot(
        {
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING_WITH_WAITPOINTS", description: "resumed" },
          previousSnapshotId: created!.id,
          completedWaitpoints: [{ id: tokenId, index: 0 }],
          environmentId: env.environment.id,
          environmentType: "PRODUCTION",
          projectId: env.project.id,
          organizationId: env.organization.id,
        },
        prisma14
      );

      // RED: the connect hits _completedWaitpoints_B_fkey (token not on #legacy) -> throws -> parent hangs.
      // GREEN (FK dropped): the cross-DB completed-waitpoint link is recorded.
      const link = (await prisma14.$queryRaw`
        SELECT "B" FROM "_completedWaitpoints" WHERE "A" = ${snap.id}
      `) as { B: string }[];
      expect(link.map((r) => r.B)).toEqual([tokenId]);
    }
  );
});
