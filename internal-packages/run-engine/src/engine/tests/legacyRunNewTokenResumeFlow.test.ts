// Completion -> resume FLOW test for the direction crossDbTokenBlock.test.ts's writer fix enables but
// never itself exercises end-to-end: a LEGACY (cuid) run blocks on a standalone MANUAL token that is
// NEW-resident (run-ops id) — e.g. the token was minted co-located with a run-ops sibling. This test
// drives the real engine path (blockRunWithWaitpoint -> completeWaitpoint -> continueRunIfUnblocked)
// across the two PHYSICAL DBs to prove the blocking edge is discovered and the run actually resumes,
// not just that the edge write succeeds (that unit-level assertion already lives in
// runOpsStore.crossDbTokenBlock.test.ts). Mirrors completeWaitpointReadResidency.test.ts's own
// cross-DB case, but with the run/token residencies swapped. Real two-physical-DB topology; never
// mocked.

import {
  heteroRunOpsPostgresTest,
  network,
  redisContainer,
  redisOptions,
} from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { PostgresRunStore, RoutingRunStore, type CreateRunInput } from "@internal/run-store";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { expect, vi } from "vitest";
import { RunEngine } from "../index.js";

const twoDbEngineTest = heteroRunOpsPostgresTest.extend<{
  redisContainer: any;
  redisOptions: any;
}>({
  network,
  redisContainer,
  redisOptions,
});

// 25-char cuid body (no v1 version marker at index 25) -> classifies LEGACY -> #legacy (prisma14).
const CUID_25 = "c".repeat(25);

function baseEngineOptions(redisOptions: any, prisma: any) {
  return {
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

async function seedControlPlaneEnv(prisma: PrismaClient, suffix: string) {
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
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: p.runId,
      engine: "V2",
      status: "EXECUTING",
      friendlyId: p.friendlyId,
      runtimeEnvironmentId: p.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      organizationId: p.organizationId,
      projectId: p.projectId,
      taskIdentifier: "parent-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${p.runId}`,
      spanId: `span_${p.runId}`,
      runTags: [],
      queue: "task/parent-task",
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

// Seed an EXECUTING LEGACY (cuid) parent run on #legacy (prisma14), plus a standalone MANUAL token
// that is NEW-resident (run-ops id, minted co-located with some other run-ops sibling) on #new
// (prisma17) ONLY — the token is never created on #legacy.
async function seedExecutingLegacyParentAndNewToken(
  prisma14: PrismaClient,
  prisma17: RunOpsPrismaClient,
  router: RoutingRunStore,
  parentRunId: string,
  waitpointId: string,
  suffix: string
) {
  const env = await seedControlPlaneEnv(prisma14, suffix);

  await router.createRun(
    buildCreateRunInput({
      runId: parentRunId,
      friendlyId: `run_${suffix}_parent`,
      organizationId: env.organization.id,
      projectId: env.project.id,
      runtimeEnvironmentId: env.environment.id,
    })
  );

  const created = await router.findLatestExecutionSnapshot(parentRunId);
  await router.createExecutionSnapshot(
    {
      run: { id: parentRunId, status: "EXECUTING", attemptNumber: 1 },
      snapshot: { executionStatus: "EXECUTING", description: "parent executing" },
      previousSnapshotId: created!.id,
      environmentId: env.environment.id,
      environmentType: "PRODUCTION",
      projectId: env.project.id,
      organizationId: env.organization.id,
    },
    prisma14
  );

  // Standalone MANUAL token lives on #new ONLY (run-ops id) — NOT on #legacy.
  await prisma17.waitpoint.create({
    data: {
      id: waitpointId,
      friendlyId: `wp_${suffix}`,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: `idem_${waitpointId}`,
      userProvidedIdempotencyKey: false,
      projectId: env.project.id,
      environmentId: env.environment.id,
    },
  });

  return env;
}

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

describe("RunEngine completion->resume flow — a LEGACY run blocked on a NEW-resident token resumes across the seam", () => {
  twoDbEngineTest(
    "completeWaitpoint on the NEW token finds the #legacy edge and unblocks the LEGACY run",
    async ({ prisma14, prisma17, redisOptions }) => {
      const router = makeRouter(prisma14 as unknown as PrismaClient, prisma17);

      // The harness builds the schema with `prisma db push`, which re-creates the FKs that the
      // run-ops split migrations drop in prod (see runOpsStore.crossDbTokenBlock.test.ts). Mirror
      // those drops on this clone so the cross-DB edge write exercises real prod state.
      await (prisma14 as unknown as PrismaClient).$executeRawUnsafe(
        `ALTER TABLE "TaskRunWaitpoint" DROP CONSTRAINT IF EXISTS "TaskRunWaitpoint_waitpointId_fkey"`
      );
      await (prisma14 as unknown as PrismaClient).$executeRawUnsafe(
        `ALTER TABLE "_WaitpointRunConnections" DROP CONSTRAINT IF EXISTS "_WaitpointRunConnections_B_fkey"`
      );
      // continueRunIfUnblocked's resume snapshot connects the now-COMPLETED (NEW-resident) token via
      // _completedWaitpoints (migration 20260705230000 drops this FK in prod; see
      // runOpsStore.crossDbCompletedWaitpoint.test.ts).
      await (prisma14 as unknown as PrismaClient).$executeRawUnsafe(
        `ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"`
      );

      const engine = new RunEngine({
        store: router,
        ...baseEngineOptions(redisOptions, prisma14),
      });

      try {
        const parentRunId = `run_${CUID_25}`; // LEGACY run -> #legacy
        const tokenId = `waitpoint_${generateRunOpsId()}`; // NEW-resident standalone token -> #new
        const env = await seedExecutingLegacyParentAndNewToken(
          prisma14 as unknown as PrismaClient,
          prisma17,
          router,
          parentRunId,
          tokenId,
          "xdbresume"
        );

        // Block the LEGACY run on the NEW token. The edge must land on #legacy (the run's own DB,
        // FK-free now that the migration-dropped constraints are mirrored above).
        await engine.blockRunWithWaitpoint({
          runId: parentRunId,
          waitpoints: tokenId,
          projectId: env.project.id,
          organizationId: env.organization.id,
          tx: prisma14 as unknown as PrismaClient,
        });

        expect(
          await (prisma14 as unknown as PrismaClient).taskRunWaitpoint.count({
            where: { taskRunId: parentRunId },
          })
        ).toBe(1);
        expect(await prisma17.taskRunWaitpoint.count({ where: { taskRunId: parentRunId } })).toBe(
          0
        );

        const blocked = await engine.getRunExecutionData({ runId: parentRunId });
        expect(blocked?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        const enqueueSpy = vi.spyOn((engine as any).worker, "enqueue");

        // Complete the NEW token via the engine path. forWaitpointCompletion resolves #new (run-ops
        // id, no pins); completeWaitpoint marks it COMPLETED there, then fans the waitpointId edge
        // read across BOTH DBs (findManyTaskRunWaitpoints) to discover the #legacy-resident edge.
        const completed = await engine.completeWaitpoint({
          id: tokenId,
          output: { value: '{"resumed":"legacy-run-new-token"}', isError: false },
        });
        expect(completed.status).toBe("COMPLETED");

        // Token COMPLETED on #new only.
        expect((await prisma17.waitpoint.findFirst({ where: { id: tokenId } }))?.status).toBe(
          "COMPLETED"
        );
        expect(
          await (prisma14 as unknown as PrismaClient).waitpoint.findFirst({
            where: { id: tokenId },
          })
        ).toBeNull();

        // The fan-out found the #legacy edge and enqueued the unblock for the LEGACY run.
        const continueEnqueued = enqueueSpy.mock.calls.some(
          ([arg]) =>
            (arg as any)?.job === "continueRunIfUnblocked" &&
            (arg as any)?.payload?.runId === parentRunId
        );
        expect(continueEnqueued).toBe(true);

        // Driving the unblock body re-resolves the NEW token's COMPLETED status across the seam
        // (continueRunIfUnblocked's blockingWaitpoints read rehydrates `waitpoint` cross-DB) and
        // actually resumes the LEGACY run — the higher-level outcome, not just the edge write.
        const result = await (engine as any).waitpointSystem.continueRunIfUnblocked({
          runId: parentRunId,
        });
        expect(result.status).toBe("unblocked");

        const after = await engine.getRunExecutionData({ runId: parentRunId });
        expect(after?.snapshot.executionStatus).not.toBe("EXECUTING_WITH_WAITPOINTS");
      } finally {
        await engine.quit();
      }
    }
  );
});
