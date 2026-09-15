// clearBlockingWaitpoints (called by attemptFailed) deleted edges via the caller's control-plane tx.
// A NEW run's TaskRunWaitpoint edges live on #new, so the control-plane deleteMany matched 0 rows and
// left them orphaned; on a retry+re-block those stale PENDING edges re-block the run forever. The fix
// routes the delete through the store (which fans across both DBs, dropping the tx for the cross-DB
// path). Real two-DB topology; never mocked.

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

const twoDbEngineTest = heteroRunOpsPostgresTest.extend<{
  redisContainer: any;
  redisOptions: any;
}>({
  network,
  redisContainer,
  redisOptions,
});

const RUN_OPS_A = "n".repeat(24) + "01"; // run-ops id -> NEW (#new / prisma17)

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
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: p.runId,
      engine: "V2",
      status: "EXECUTING",
      friendlyId: "run_clearwp",
      runtimeEnvironmentId: p.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      organizationId: p.organizationId,
      projectId: p.projectId,
      taskIdentifier: "clearwp-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${p.runId}`,
      spanId: `span_${p.runId}`,
      runTags: [],
      queue: "task/clearwp-task",
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

describe("RunEngine clearBlockingWaitpoints — clears a NEW run's edges even with a control-plane tx", () => {
  twoDbEngineTest(
    "a control-plane tx does not leave a NEW run's #new-resident blocking edge orphaned",
    async ({ prisma14, prisma17, redisOptions }) => {
      const router = makeRouter(prisma14 as unknown as PrismaClient, prisma17);
      const engine = new RunEngine({
        store: router,
        ...baseEngineOptions(redisOptions, prisma14),
      });

      try {
        const runId = `run_${RUN_OPS_A}`;
        const env = await seedControlPlaneEnv(prisma14 as unknown as PrismaClient, "clearwp");
        await router.createRun(
          buildCreateRunInput({
            runId,
            organizationId: env.organization.id,
            projectId: env.project.id,
            runtimeEnvironmentId: env.environment.id,
          })
        );
        // A NEW run's blocking edge lives on #new.
        await prisma17.taskRunWaitpoint.create({
          data: {
            id: "trw_clearwp_0000000000001",
            taskRunId: runId,
            waitpointId: "waitpoint_clearwp_00000001",
            projectId: env.project.id,
          },
        });

        // attemptFailed passes the control-plane tx; the #new edge must still be cleared.
        const count = await engine.waitpointSystem.clearBlockingWaitpoints({
          runId,
          tx: prisma14 as unknown as PrismaClient,
        });

        // RED: the tx deletes on #legacy -> 0; the #new edge is orphaned.
        // GREEN: the routed delete fans out -> the #new edge is cleared.
        expect(count).toBe(1);
        expect(await prisma17.taskRunWaitpoint.count({ where: { taskRunId: runId } })).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );
});
