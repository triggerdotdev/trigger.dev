// blockRunWithWaitpoint's block-time pending check is UNROUTED — countPendingWaitpoints($waitpoints)
// with no client falls to the owning store's REPLICA. When a waitpoint completes on the PRIMARY just
// before the parent blocks (the wait/token/batch-child race), a lagging replica still reports it
// PENDING → isRunBlocked=true → no continueRunIfUnblocked is enqueued → the run is stranded in
// EXECUTING_WITH_WAITPOINTS forever (the production hang under the run-ops split).
// GREEN fix: countPendingWaitpoints($waitpoints, prisma) — routed to the owning primary via #ownPrimary.
// Real two-DB topology (#new=prisma17 dedicated, #legacy=prisma14); replica lag simulated by a
// recording proxy, as in runOpsStore.readAfterWrite.test.ts.

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

// run-ops id (version "1" at index 25) → classified NEW → routed to the run-ops (#new) store.
const RUN_OPS_A = "n".repeat(24) + "01";

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

// Seed an EXECUTING run-ops parent on #new (prisma17) via the routed store, plus a run-ops id PENDING
// RUN waitpoint co-resident on #new.
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

// A lagging NEW replica that has NOT yet applied the waitpoint completion: its pending-count query
// (the only $queryRaw countPendingWaitpoints issues) reports every queried waitpoint as still PENDING.
// Everything else forwards to the real client. `wasHit` flips true iff the pending-count query ran here.
function laggingPendingReplica<C extends RunOpsPrismaClient>(
  real: C
): { client: C; wasHit: () => boolean } {
  let hit = false;
  const client = new Proxy(real as any, {
    get(target, prop) {
      if (prop === "$queryRaw") {
        return (strings: TemplateStringsArray, ...values: any[]) => {
          const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
          if (sql.includes("pending_count")) {
            hit = true;
            const ids = values[0];
            const stalePending = Array.isArray(ids) ? ids.length : 1;
            // stale replica: the just-completed waitpoint(s) still look PENDING
            return Promise.resolve([{ pending_count: BigInt(stalePending) }]);
          }
          return (target as any).$queryRaw(strings, ...values);
        };
      }
      // Bind forwarded methods to the real client (Prisma delegates are proxy-based, not pre-bound).
      const forwarded = (target as any)[prop];
      return typeof forwarded === "function" ? forwarded.bind(target) : forwarded;
    },
  }) as C;
  return { client, wasHit: () => hit };
}

describe("RunEngine blockRunWithWaitpoint — block-time pending check must read the owning primary, not a lagging replica", () => {
  twoDbEngineTest(
    "a waitpoint completed on the primary just before block does not strand the run (continueRunIfUnblocked is enqueued)",
    async ({ prisma14, prisma17, redisOptions }) => {
      // #new reads go to a LAGGING replica whose pending-count still reports PENDING.
      const newReplica = laggingPendingReplica(prisma17);
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
        const parentRunId = `run_${RUN_OPS_A}`;
        const waitpointId = `waitpoint_${RUN_OPS_A}`;
        const env = await seedExecutingRunOpsParent(
          prisma14 as unknown as PrismaClient,
          prisma17,
          router,
          parentRunId,
          waitpointId,
          "replag"
        );

        // THE RACE: the waitpoint completes on the PRIMARY just before the parent blocks on it.
        await prisma17.waitpoint.update({
          where: { id: waitpointId },
          data: { status: "COMPLETED", completedAt: new Date() },
        });

        // The primary shows COMPLETED (0 pending); the lagging replica will still report PENDING.
        expect((await prisma17.waitpoint.findFirst({ where: { id: waitpointId } }))?.status).toBe(
          "COMPLETED"
        );

        const enqueueSpy = vi.spyOn((engine as any).worker, "enqueue");

        // Block the parent on the already-completed waitpoint. The block-time pending check should see
        // 0 pending and enqueue continueRunIfUnblocked. Under the unrouted replica read it sees stale
        // PENDING and enqueues nothing → the run hangs.
        await engine.blockRunWithWaitpoint({
          runId: parentRunId,
          waitpoints: waitpointId,
          projectId: env.project.id,
          organizationId: env.organization.id,
          tx: prisma14 as unknown as PrismaClient,
        });

        const continueEnqueued = enqueueSpy.mock.calls.some(
          ([arg]) =>
            (arg as any)?.job === "continueRunIfUnblocked" &&
            (arg as any)?.payload?.runId === parentRunId
        );
        // RED: not enqueued (block-time check read the lagging replica → stale PENDING → stranded).
        // GREEN: enqueued (block-time check routed to the owning primary → sees COMPLETED → 0 pending).
        expect(continueEnqueued).toBe(true);

        // And the fix means the pending check no longer touches the lagging replica at all.
        expect(newReplica.wasHit()).toBe(false);
      } finally {
        await engine.quit();
      }
    }
  );
});
