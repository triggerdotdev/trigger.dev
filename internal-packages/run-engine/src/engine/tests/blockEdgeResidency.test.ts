// Block-edge write goes to the wrong DB so the parent never suspends. Two-physical-DB topology with
// the real dedicated run-ops schema on #new (prisma17). RED before the fix: the control-plane tx
// threaded by RunEngine.trigger forces the raw CTE to join `Waitpoint` on #legacy, where the run-ops id
// waitpoint does not exist, so 0 edges are written and the parent stays EXECUTING. GREEN after: the
// block path always routes through the store, landing the edge + WaitpointRunConnection on #new and
// suspending the parent. (Snapshot reads/writes route by run id regardless of tx.)

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
import { expect } from "vitest";
import { RunEngine } from "../index.js";

// Compose the two-physical-DB run-ops fixture (prisma14 = full control-plane DB,
// prisma17 = dedicated run-ops subset DB) with a per-test redis the RunEngine needs.
const twoDbEngineTest = heteroRunOpsPostgresTest.extend<{
  redisContainer: any;
  redisOptions: any;
}>({
  network,
  redisContainer,
  redisOptions,
});

// run-ops id (v1 internal id, version "1" at index 25) → classified NEW → routed to the run-ops (#new) store.
const RUN_OPS_A = "k".repeat(24) + "01";
const RUN_OPS_B = "m".repeat(24) + "01";

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

// On the dedicated subset there are no Organization/Project/RuntimeEnvironment models — the run-ops
// rows carry FK-free scalar owning ids. On legacy (control-plane) we seed the real env the engine's
// resolver / enqueue path reads (maxConc etc.).
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

// Seed an EXECUTING run-ops parent run on #new (prisma17) via the routed store, then a run-ops id PENDING
// RUN waitpoint co-resident on #new. Returns the env + ids the block path needs.
async function seedExecutingRunOpsParent(
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

  // Move the parent to EXECUTING (so blockRunWithWaitpoint transitions it to
  // EXECUTING_WITH_WAITPOINTS rather than SUSPENDED) — written via the routed store onto #new.
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

  // The associated waitpoint lives on #new (co-resident with the run-ops run).
  await prisma17.waitpoint.create({
    data: {
      id: waitpointId,
      friendlyId: `wp_${suffix}`,
      type: "RUN",
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

describe("RunEngine block-edge residency (two physical DBs, dedicated #new)", () => {
  // RED before fix / GREEN after: a run-ops parent blocked by a #new-resident waitpoint, with the
  // control-plane tx threaded exactly as RunEngine.trigger does, ends EXECUTING_WITH_WAITPOINTS with
  // the edge + WaitpointRunConnection physically on #new.
  twoDbEngineTest(
    "blockRunWithWaitpoint suspends a run-ops parent with the edge on #new (control-plane tx threaded)",
    async ({ prisma14, prisma17, redisOptions }) => {
      const router = makeRouter(prisma14 as unknown as PrismaClient, prisma17);
      const engine = new RunEngine({
        store: router,
        ...baseEngineOptions(redisOptions, prisma14),
      });

      try {
        const parentRunId = `run_${RUN_OPS_A}`;
        const waitpointId = `waitpoint_${RUN_OPS_A}`;
        const env = await seedExecutingRunOpsParent(
          prisma14 as unknown as PrismaClient,
          prisma17,
          router,
          parentRunId,
          waitpointId,
          "blockedge-a"
        );

        // RunEngine.trigger threads the control-plane client as `tx` — the wrong-DB trigger.
        await engine.blockRunWithWaitpoint({
          runId: parentRunId,
          waitpoints: waitpointId,
          projectId: env.project.id,
          organizationId: env.organization.id,
          tx: prisma14 as unknown as PrismaClient,
        });

        const edgesOnNew = await prisma17.taskRunWaitpoint.count({
          where: { taskRunId: parentRunId },
        });
        const connectionsOnNew = await prisma17.waitpointRunConnection.count({
          where: { taskRunId: parentRunId, waitpointId },
        });
        const edgesOnLegacy = await (prisma14 as unknown as PrismaClient).taskRunWaitpoint.count({
          where: { taskRunId: parentRunId },
        });

        expect(edgesOnNew).toBe(1); // RED: 0 (CTE on #legacy found no waitpoint → no edge)
        expect(connectionsOnNew).toBe(1); // the explicit join replacing legacy _WaitpointRunConnections
        expect(edgesOnLegacy).toBe(0); // never written to the wrong DB

        // And the engine actually suspended the parent.
        const data = await engine.getRunExecutionData({ runId: parentRunId });
        expect(data?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
      } finally {
        await engine.quit();
      }
    }
  );

  // The lockless (batch-item) path likewise must write the edge on #new. The lockless method does
  // not transition the snapshot (the parent is already EXECUTING_WITH_WAITPOINTS from
  // blockRunWithCreatedBatch), so we assert the edge + connection land on #new.
  twoDbEngineTest(
    "blockRunWithWaitpointLockless writes the edge on #new (control-plane tx threaded)",
    async ({ prisma14, prisma17, redisOptions }) => {
      const router = makeRouter(prisma14 as unknown as PrismaClient, prisma17);
      const engine = new RunEngine({
        store: router,
        ...baseEngineOptions(redisOptions, prisma14),
      });

      try {
        const parentRunId = `run_${RUN_OPS_B}`;
        const waitpointId = `waitpoint_${RUN_OPS_B}`;
        const env = await seedExecutingRunOpsParent(
          prisma14 as unknown as PrismaClient,
          prisma17,
          router,
          parentRunId,
          waitpointId,
          "blockedge-b"
        );

        // The lockless method lives on the waitpoint system; reach it via the engine instance.
        await (engine as any).waitpointSystem.blockRunWithWaitpointLockless({
          runId: parentRunId,
          waitpoints: waitpointId,
          projectId: env.project.id,
          batch: { id: `batch_${RUN_OPS_B}`, index: 0 },
          tx: prisma14 as unknown as PrismaClient,
        });

        const edgesOnNew = await prisma17.taskRunWaitpoint.count({
          where: { taskRunId: parentRunId },
        });
        const connectionsOnNew = await prisma17.waitpointRunConnection.count({
          where: { taskRunId: parentRunId, waitpointId },
        });
        const edgesOnLegacy = await (prisma14 as unknown as PrismaClient).taskRunWaitpoint.count({
          where: { taskRunId: parentRunId },
        });

        expect(edgesOnNew).toBe(1); // RED: 0 (lockless CTE on #legacy found no waitpoint)
        expect(connectionsOnNew).toBe(1);
        expect(edgesOnLegacy).toBe(0);

        // countPendingWaitpoints fans out and sees the #new PENDING waitpoint as a live blocker.
        expect(await router.countPendingWaitpoints([waitpointId])).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );
});
