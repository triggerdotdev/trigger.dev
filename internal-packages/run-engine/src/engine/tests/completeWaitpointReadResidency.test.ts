// completeWaitpoint re-read residency — the COMPLETED-waitpoint re-read inside
// WaitpointSystem.completeWaitpoint must use the RESOLVED store's OWN client, not the
// control-plane client. Two-physical-DB topology with the real dedicated run-ops schema on
// #new (prisma17), modelled on the block-edge residency test.
//
// RED before the fix: completeWaitpoint resolved the #new store (where the ksuid RUN waitpoint
// lives), marked it COMPLETED there, then re-read it via `store.findWaitpoint({where:{id}}, this.$.prisma)`.
// A resolved PostgresRunStore HONORS the passed client, so the re-read hit the control-plane DB
// (#legacy / prisma14), found nothing, and threw "Waitpoint not found" BEFORE enqueueing
// continueRunIfUnblocked → the blocked parent never resumed.
//
// GREEN after: the re-read drops the control-plane client, reads #new's own client, finds the
// COMPLETED waitpoint, and the edge fan-out enqueues continueRunIfUnblocked for the parent, which
// then transitions out of EXECUTING_WITH_WAITPOINTS.

import {
  heteroRunOpsPostgresTest,
  network,
  redisContainer,
  redisOptions,
} from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { PostgresRunStore, RoutingRunStore, type CreateRunInput } from "@internal/run-store";
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

// ksuid (27-char internal id) → classified NEW → routed to the run-ops (#new) store.
const KSUID_A = "n".repeat(27);
// A second ksuid run for the cross-DB (NEW-run → LEGACY-token) case.
const KSUID_X = "x".repeat(27);
// cuid (25-char) → classified LEGACY → a standalone token resident on #legacy (prisma14).
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
      status: "EXECUTING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "parent-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
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
      environmentId: params.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

// Seed an EXECUTING ksuid parent on #new (prisma17) via the routed store, plus a ksuid PENDING RUN
// waitpoint co-resident on #new. Returns the env + ids the block/complete path needs.
async function seedExecutingKsuidParent(
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

  // The RUN waitpoint lives on #new, co-resident with the ksuid run, and is completed-by that run.
  await prisma17.waitpoint.create({
    data: {
      id: waitpointId,
      friendlyId: `wp_${suffix}`,
      type: "RUN",
      status: "PENDING",
      completedByTaskRunId: parentRunId,
      idempotencyKey: `idem_${waitpointId}`,
      userProvidedIdempotencyKey: false,
      projectId: env.project.id,
      environmentId: env.environment.id,
    },
  });

  return env;
}

// Seed an EXECUTING ksuid parent on #new (prisma17) AND a standalone MANUAL token resident on
// #legacy (prisma14, cuid) — the tolerated NEW-run → LEGACY-token cross-DB direction (standalone
// tokens are minted on LEGACY). The token is NOT created on #new. Returns both envs + ids.
async function seedKsuidParentAndLegacyToken(
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

  // The standalone MANUAL token lives on #legacy ONLY (cuid id, no owning run) — NOT on #new.
  await prisma14.waitpoint.create({
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

describe("RunEngine completeWaitpoint re-read residency (two physical DBs, dedicated #new)", () => {
  twoDbEngineTest(
    "completeWaitpoint finds the #new-resident RUN waitpoint and unblocks the parent",
    async ({ prisma14, prisma17, redisOptions }) => {
      const router = makeRouter(prisma14 as unknown as PrismaClient, prisma17);
      const engine = new RunEngine({
        store: router,
        ...baseEngineOptions(redisOptions, prisma14),
      });

      try {
        const parentRunId = `run_${KSUID_A}`;
        const waitpointId = `waitpoint_${KSUID_A}`;
        const env = await seedExecutingKsuidParent(
          prisma14 as unknown as PrismaClient,
          prisma17,
          router,
          parentRunId,
          waitpointId,
          "wpread"
        );

        // Block the parent on the #new waitpoint (the edge routes onto #new by owning run id). The
        // parent transitions to EXECUTING_WITH_WAITPOINTS.
        await engine.blockRunWithWaitpoint({
          runId: parentRunId,
          waitpoints: waitpointId,
          projectId: env.project.id,
          organizationId: env.organization.id,
          tx: prisma14 as unknown as PrismaClient,
        });

        const blocked = await engine.getRunExecutionData({ runId: parentRunId });
        expect(blocked?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        // Capture the unblock enqueue. RED: completeWaitpoint throws "Waitpoint not found" before
        // we ever reach this enqueue. GREEN: it enqueues continueRunIfUnblocked for the parent.
        const enqueueSpy = vi.spyOn((engine as any).worker, "enqueue");

        // RED before fix: rejects with "Waitpoint not found" (re-read hit the control-plane DB).
        // GREEN after fix: completes, returning the COMPLETED waitpoint.
        const completed = await engine.completeWaitpoint({
          id: waitpointId,
          output: { value: '{"ok":true}', isError: false },
        });

        expect(completed.id).toBe(waitpointId);
        expect(completed.status).toBe("COMPLETED");

        // The waitpoint is COMPLETED on its OWN DB (#new), never on the control-plane DB.
        const onNew = await prisma17.waitpoint.findFirst({ where: { id: waitpointId } });
        expect(onNew?.status).toBe("COMPLETED");
        const onLegacy = await (prisma14 as unknown as PrismaClient).waitpoint.findFirst({
          where: { id: waitpointId },
        });
        expect(onLegacy).toBeNull();

        // The unblock path ran: a continueRunIfUnblocked job was enqueued for the blocked parent.
        const continueEnqueued = enqueueSpy.mock.calls.some(
          ([arg]) =>
            (arg as any)?.job === "continueRunIfUnblocked" &&
            (arg as any)?.payload?.runId === parentRunId
        );
        expect(continueEnqueued).toBe(true);

        // Drive the enqueued job's body to prove the parent actually resumes (no longer blocked).
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

  // End-to-end cross-DB gate: a ksuid run on #new blocked on a standalone MANUAL token resident on
  // #legacy (the tolerated NEW-run → LEGACY-token direction — standalone tokens are minted on
  // LEGACY). RED before the writer fix: blockRunWithWaitpointEdges' dedicated branch joined
  // `FROM "Waitpoint" w`, which matched 0 rows on #new (the token is on #legacy) → 0 edges → the run
  // stays EXECUTING_WITH_WAITPOINTS forever and completing the token finds no edge to resume.
  // GREEN after: the edge is written on #new from the waitpointId directly; completing the LEGACY
  // token (the completion fan-out discovers the #new edge and resolves its COMPLETED status across
  // both DBs) resumes the NEW run.
  twoDbEngineTest(
    "completeWaitpoint on a LEGACY-resident token unblocks a ksuid run whose edge lives on #new",
    async ({ prisma14, prisma17, redisOptions }) => {
      const router = makeRouter(prisma14 as unknown as PrismaClient, prisma17);
      const engine = new RunEngine({
        store: router,
        ...baseEngineOptions(redisOptions, prisma14),
      });

      try {
        const parentRunId = `run_${KSUID_X}`; // ksuid run → #new
        const waitpointId = `waitpoint_${CUID_25}`; // cuid standalone token → #legacy
        const env = await seedKsuidParentAndLegacyToken(
          prisma14 as unknown as PrismaClient,
          prisma17,
          router,
          parentRunId,
          waitpointId,
          "xdbtok"
        );

        // Block the NEW run on the LEGACY token. The edge must land on #new (FK-free), NOT require the
        // token to be local. RED: 0 edges (the wrong-DB Waitpoint join), so the run never suspends.
        await engine.blockRunWithWaitpoint({
          runId: parentRunId,
          waitpoints: waitpointId,
          projectId: env.project.id,
          organizationId: env.organization.id,
          tx: prisma14 as unknown as PrismaClient,
        });

        // The block edge is physically on #new; #legacy holds none for the ksuid run (safety invariant).
        expect(await prisma17.taskRunWaitpoint.count({ where: { taskRunId: parentRunId } })).toBe(
          1
        );
        expect(
          await (prisma14 as unknown as PrismaClient).taskRunWaitpoint.count({
            where: { taskRunId: parentRunId },
          })
        ).toBe(0);

        const blocked = await engine.getRunExecutionData({ runId: parentRunId });
        expect(blocked?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        const enqueueSpy = vi.spyOn((engine as any).worker, "enqueue");

        // Complete the LEGACY token via the engine path. completeWaitpoint resolves the token's own
        // store (#legacy), marks it COMPLETED there, then fans the waitpointId edge read across BOTH
        // DBs → discovers the #new-resident edge → enqueues continueRunIfUnblocked.
        const completed = await engine.completeWaitpoint({
          id: waitpointId,
          output: { value: '{"resumed":"cross-db"}', isError: false },
        });
        expect(completed.status).toBe("COMPLETED");

        // Token COMPLETED on #legacy only.
        expect(
          (
            await (prisma14 as unknown as PrismaClient).waitpoint.findFirst({
              where: { id: waitpointId },
            })
          )?.status
        ).toBe("COMPLETED");
        expect(await prisma17.waitpoint.findFirst({ where: { id: waitpointId } })).toBeNull();

        // The fan-out enqueued the unblock for the NEW run.
        const continueEnqueued = enqueueSpy.mock.calls.some(
          ([arg]) =>
            (arg as any)?.job === "continueRunIfUnblocked" &&
            (arg as any)?.payload?.runId === parentRunId
        );
        expect(continueEnqueued).toBe(true);

        // Driving the unblock body resolves the LEGACY token's COMPLETED status across both DBs
        // and resumes the NEW run.
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
