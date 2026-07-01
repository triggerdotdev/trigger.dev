// DATETIME / MANUAL waitpoint co-location with the owning run (run-ops split).
//
// The bug: `wait.for`/`wait.until` (DATETIME) and wait-token (MANUAL) waitpoints over the ~5s
// checkpoint threshold hang a ksuid run forever. `createDateTimeWaitpoint`/`createManualWaitpoint`
// mint an ALWAYS-cuid WaitpointId, and the routing store routed the upsert by that id → #legacy,
// even though the owning ksuid run lives on #new. `blockRunWithWaitpoint` then writes its block edge
// on #new (routed by run id), but the CTE joins `Waitpoint` LOCALLY on #new — where the
// waitpoint does not exist — so it writes 0 edges and the run is never actually blocked nor resumed.
//
// The fix: thread the owning `runId` into `createDateTimeWaitpoint`/`createManualWaitpoint` and route
// the waitpoint upsert by that run id, co-locating the waitpoint with its run on #new, exactly like
// RUN waitpoints already co-locate via `completedByTaskRunId` and the block edge co-locates via the
// run id. RED before the fix (waitpoint on #legacy, 0 edges, never resumes); GREEN after (waitpoint
// on #new, edge resolves, run resumes after completion).

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
const KSUID_A = "k".repeat(27);
const KSUID_B = "m".repeat(27);
const KSUID_C = "n".repeat(27);
const KSUID_D = "p".repeat(27);

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

// Seed an EXECUTING ksuid run on #new (prisma17) via the routed store. Returns the env + run id.
async function seedExecutingKsuidRun(
  prisma14: PrismaClient,
  router: RoutingRunStore,
  runId: string,
  suffix: string
) {
  const env = await seedControlPlaneEnv(prisma14, suffix);

  await router.createRun(
    buildCreateRunInput({
      runId,
      friendlyId: `run_${suffix}`,
      organizationId: env.organization.id,
      projectId: env.project.id,
      runtimeEnvironmentId: env.environment.id,
    })
  );

  const created = await router.findLatestExecutionSnapshot(runId);
  await router.createExecutionSnapshot(
    {
      run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
      snapshot: { executionStatus: "EXECUTING", description: "run executing" },
      previousSnapshotId: created!.id,
      environmentId: env.environment.id,
      environmentType: "PRODUCTION",
      projectId: env.project.id,
      organizationId: env.organization.id,
    },
    prisma14
  );

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

describe("DATETIME/MANUAL waitpoint co-location with the owning run (two physical DBs)", () => {
  // RED before fix: the DATETIME waitpoint created for a ksuid run lands on #legacy (routed by its
  // own cuid id), so the block edge (on #new) finds no local waitpoint and the run never blocks/resumes.
  // GREEN after: the waitpoint co-locates on #new, the edge resolves, and the run resumes once the
  // datetime waitpoint completes via the engine's finishWaitpoint timer.
  twoDbEngineTest(
    "createDateTimeWaitpoint co-locates the waitpoint on #new and the run resumes after completion",
    async ({ prisma14, prisma17, redisOptions }) => {
      const p14 = prisma14 as unknown as PrismaClient;
      const router = makeRouter(p14, prisma17);
      const engine = new RunEngine({ store: router, ...baseEngineOptions(redisOptions, prisma14) });

      try {
        const runId = `run_${KSUID_A}`;
        const env = await seedExecutingKsuidRun(p14, router, runId, "dta");

        // ~600ms out so the finishWaitpoint timer fires within the test window.
        const date = new Date(Date.now() + 600);
        const { waitpoint } = await engine.createDateTimeWaitpoint({
          runId,
          projectId: env.project.id,
          environmentId: env.environment.id,
          completedAfter: date,
        });

        // CO-LOCATION: the waitpoint must live on #new next to the run.
        const onNew = await prisma17.waitpoint.findUnique({ where: { id: waitpoint.id } });
        const onLegacy = await p14.waitpoint.findUnique({ where: { id: waitpoint.id } });
        expect(onNew).not.toBeNull(); // RED: null (routed to #legacy by cuid id-shape)
        expect(onLegacy).toBeNull(); // RED: the waitpoint is here instead

        // Block the run on it — the edge co-locates on #new and the CTE joins the local waitpoint.
        await engine.blockRunWithWaitpoint({
          runId,
          waitpoints: waitpoint.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
        });

        const edgesOnNew = await prisma17.taskRunWaitpoint.count({ where: { taskRunId: runId } });
        expect(edgesOnNew).toBe(1); // RED: 0 (no local waitpoint to join)

        const blocked = await engine.getRunExecutionData({ runId });
        expect(blocked?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        // The finishWaitpoint timer completes the waitpoint and the run resumes to EXECUTING.
        await vi.waitFor(
          async () => {
            const ed = await engine.getRunExecutionData({ runId });
            expect(ed?.snapshot.executionStatus).toBe("EXECUTING");
          },
          { timeout: 10_000, interval: 100 }
        );

        const completed = await prisma17.waitpoint.findUnique({ where: { id: waitpoint.id } });
        expect(completed?.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  // MANUAL (wait-token) analog: the waitpoint co-locates with the owning run on #new, the run blocks,
  // and an explicit engine.completeWaitpoint resumes it.
  twoDbEngineTest(
    "createManualWaitpoint co-locates the token on #new and the run resumes after completeWaitpoint",
    async ({ prisma14, prisma17, redisOptions }) => {
      const p14 = prisma14 as unknown as PrismaClient;
      const router = makeRouter(p14, prisma17);
      const engine = new RunEngine({ store: router, ...baseEngineOptions(redisOptions, prisma14) });

      try {
        const runId = `run_${KSUID_B}`;
        const env = await seedExecutingKsuidRun(p14, router, runId, "mna");

        const { waitpoint } = await engine.createManualWaitpoint({
          runId,
          environmentId: env.environment.id,
          projectId: env.project.id,
        });

        const onNew = await prisma17.waitpoint.findUnique({ where: { id: waitpoint.id } });
        const onLegacy = await p14.waitpoint.findUnique({ where: { id: waitpoint.id } });
        expect(onNew).not.toBeNull(); // RED: null
        expect(onLegacy).toBeNull();

        await engine.blockRunWithWaitpoint({
          runId,
          waitpoints: waitpoint.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
        });

        expect(await prisma17.taskRunWaitpoint.count({ where: { taskRunId: runId } })).toBe(1);
        expect((await engine.getRunExecutionData({ runId }))?.snapshot.executionStatus).toBe(
          "EXECUTING_WITH_WAITPOINTS"
        );

        await engine.completeWaitpoint({
          id: waitpoint.id,
          output: { value: '{"ok":true}', type: "application/json", isError: false },
        });

        await vi.waitFor(
          async () => {
            const ed = await engine.getRunExecutionData({ runId });
            expect(ed?.snapshot.executionStatus).toBe("EXECUTING");
          },
          { timeout: 10_000, interval: 100 }
        );
      } finally {
        await engine.quit();
      }
    }
  );

  // Idempotency-keyed path (no deferral). A DATETIME waitpoint created twice with the same
  // (env, idempotencyKey) for the SAME run dedups within the run's own store on #new — the second
  // call returns the cached #new-resident waitpoint, never a phantom #legacy row.
  twoDbEngineTest(
    "idempotency-keyed createDateTimeWaitpoint dedups within the owning run's store on #new",
    async ({ prisma14, prisma17, redisOptions }) => {
      const p14 = prisma14 as unknown as PrismaClient;
      const router = makeRouter(p14, prisma17);
      const engine = new RunEngine({ store: router, ...baseEngineOptions(redisOptions, prisma14) });

      try {
        const runId = `run_${KSUID_C}`;
        const env = await seedExecutingKsuidRun(p14, router, runId, "idem");
        const idempotencyKey = "dedup-key-1";
        const date = new Date(Date.now() + 60_000);

        const first = await engine.createDateTimeWaitpoint({
          runId,
          projectId: env.project.id,
          environmentId: env.environment.id,
          completedAfter: date,
          idempotencyKey,
        });
        expect(first.isCached).toBe(false);

        const second = await engine.createDateTimeWaitpoint({
          runId,
          projectId: env.project.id,
          environmentId: env.environment.id,
          completedAfter: date,
          idempotencyKey,
        });
        expect(second.isCached).toBe(true);
        expect(second.waitpoint.id).toBe(first.waitpoint.id);

        // Both the dedup probe and the create must target #new — exactly one row, and it is on #new.
        expect(
          await prisma17.waitpoint.findUnique({ where: { id: first.waitpoint.id } })
        ).not.toBeNull();
        expect(await p14.waitpoint.findUnique({ where: { id: first.waitpoint.id } })).toBeNull();
        expect(
          await prisma17.waitpoint.count({
            where: { environmentId: env.environment.id, idempotencyKey },
          })
        ).toBe(1);
        expect(
          await p14.waitpoint.count({
            where: { environmentId: env.environment.id, idempotencyKey },
          })
        ).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  // Idempotency-keyed MANUAL analog with the same per-run-DB dedup invariant.
  twoDbEngineTest(
    "idempotency-keyed createManualWaitpoint dedups within the owning run's store on #new",
    async ({ prisma14, prisma17, redisOptions }) => {
      const p14 = prisma14 as unknown as PrismaClient;
      const router = makeRouter(p14, prisma17);
      const engine = new RunEngine({ store: router, ...baseEngineOptions(redisOptions, prisma14) });

      try {
        const runId = `run_${KSUID_D}`;
        const env = await seedExecutingKsuidRun(p14, router, runId, "idemm");
        const idempotencyKey = "dedup-key-2";

        const first = await engine.createManualWaitpoint({
          runId,
          environmentId: env.environment.id,
          projectId: env.project.id,
          idempotencyKey,
        });
        expect(first.isCached).toBe(false);

        const second = await engine.createManualWaitpoint({
          runId,
          environmentId: env.environment.id,
          projectId: env.project.id,
          idempotencyKey,
        });
        expect(second.isCached).toBe(true);
        expect(second.waitpoint.id).toBe(first.waitpoint.id);

        expect(
          await prisma17.waitpoint.findUnique({ where: { id: first.waitpoint.id } })
        ).not.toBeNull();
        expect(await p14.waitpoint.findUnique({ where: { id: first.waitpoint.id } })).toBeNull();
        expect(
          await prisma17.waitpoint.count({
            where: { environmentId: env.environment.id, idempotencyKey },
          })
        ).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );
});
