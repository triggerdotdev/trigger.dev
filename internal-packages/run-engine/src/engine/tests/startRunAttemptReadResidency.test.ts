// startRunAttempt gates on the run row: `if (!taskRun.lockedById) throw "Task run is not locked"`.
// Dequeue (lockRunToWorker) writes lockedById on the owning PRIMARY, then the worker issues a
// SEPARATE start-attempt request. That run-row read (findRun, waitpointless) passes no client, so
// under the split it resolves to the owning store's REPLICA. A lagging replica still shows the
// pre-lock row (lockedById null), so the just-dequeued run is rejected with a spurious 400 and never
// starts. The fix threads the writer so the read is read-your-writes on the owning primary (matching
// the sibling getLatestExecutionSnapshot call). Real two-DB topology; replica lag simulated by a proxy.

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

const RUN_OPS_A = "n".repeat(24) + "01"; // run-ops id -> classified NEW -> #new

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
      status: "PENDING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "attempt-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      runTags: [],
      queue: "task/attempt-task",
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

// A lagging replica that has not applied the dequeue lock: taskRun reads still show lockedById null.
// Everything else forwards to the real client. `wasHit` flips true iff a taskRun read ran here.
function laggingLockReplica<C extends RunOpsPrismaClient>(
  real: C
): { client: C; wasHit: () => boolean } {
  let hit = false;
  const laggingTaskRun = new Proxy((real as any).taskRun, {
    get(target, prop) {
      if (prop === "findFirst" || prop === "findUnique" || prop === "findFirstOrThrow") {
        return async (...args: any[]) => {
          hit = true;
          const row = await (target as any)[prop](...args);
          return row ? { ...row, lockedById: null } : row;
        };
      }
      // Bind forwarded methods to the real client: Prisma delegates are proxy-based and not
      // pre-bound, so an unbound method would trip a this/private-field brand check when called.
      const forwarded = (target as any)[prop];
      return typeof forwarded === "function" ? forwarded.bind(target) : forwarded;
    },
  });
  const client = new Proxy(real as any, {
    get(target, prop) {
      if (prop === "taskRun") return laggingTaskRun;
      const forwarded = (target as any)[prop];
      return typeof forwarded === "function" ? forwarded.bind(target) : forwarded;
    },
  }) as C;
  return { client, wasHit: () => hit };
}

describe("RunEngine startRunAttempt — the run-row lock check must read the owning primary, not a lagging replica", () => {
  twoDbEngineTest(
    "a just-dequeued NEW run starts despite a lagging replica that still shows it unlocked",
    async ({ prisma14, prisma17, redisOptions }) => {
      const newReplica = laggingLockReplica(prisma17);
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: newReplica.client as never,
        schemaVariant: "dedicated",
      });
      const legacyStore = new PostgresRunStore({
        prisma: prisma14 as unknown as PrismaClient,
        readOnlyPrisma: prisma14 as unknown as PrismaClient,
        schemaVariant: "legacy",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const engine = new RunEngine({
        store: router,
        ...baseEngineOptions(redisOptions, prisma14),
      });

      try {
        const runId = `run_${RUN_OPS_A}`;
        const env = await seedControlPlaneEnv(prisma14 as unknown as PrismaClient, "startlock");

        await router.createRun(
          buildCreateRunInput({
            runId,
            friendlyId: "run_startlock",
            organizationId: env.organization.id,
            projectId: env.project.id,
            runtimeEnvironmentId: env.environment.id,
          })
        );

        // Dequeue: write a PENDING_EXECUTING snapshot + lock the run on the owning primary.
        const created = await router.findLatestExecutionSnapshot(runId);
        const dequeued = await router.createExecutionSnapshot(
          {
            run: { id: runId, status: "DEQUEUED", attemptNumber: null },
            snapshot: { executionStatus: "PENDING_EXECUTING", description: "dequeued" },
            previousSnapshotId: created!.id,
            environmentId: env.environment.id,
            environmentType: "PRODUCTION",
            projectId: env.project.id,
            organizationId: env.organization.id,
          },
          prisma14 as unknown as PrismaClient
        );
        await prisma17.taskRun.update({
          where: { id: runId },
          data: { status: "DEQUEUED", lockedById: "worker_startlock", lockedAt: new Date() },
        });

        // The run IS locked on the primary; the lagging replica shows it unlocked. RED: findRun (no
        // client) reads the replica -> lockedById null -> ServiceValidationError "Task run is not
        // locked". GREEN: the read routes to the owning primary, so the lock check passes (it then
        // fails later on the unseeded worker-task config, which is out of scope for this gate).
        let errorMessage: string | undefined;
        try {
          await engine.startRunAttempt({ runId, snapshotId: dequeued.id });
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error);
        }
        expect(errorMessage ?? "").not.toContain("Task run is not locked");
        expect(newReplica.wasHit()).toBe(false);
      } finally {
        await engine.quit();
      }
    }
  );
});
