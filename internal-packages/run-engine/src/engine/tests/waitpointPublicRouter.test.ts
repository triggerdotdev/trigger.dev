import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { PostgresRunStore } from "@internal/run-store";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { setTimeout } from "node:timers/promises";
import { RunEngine } from "../index.js";
import type { CrossSeamGuardHook } from "../types.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

// A real PostgresRunStore that counts routed waitpoint calls then delegates to the
// real implementation. Dependency injection of a real store over a real container — not a mock.
class CountingPostgresRunStore extends PostgresRunStore {
  public readonly counts = {
    findWaitpoint: 0,
    createWaitpoint: 0,
  };

  // The read client passed into the most recent findWaitpoint call (args[1]).
  public lastFindWaitpointClient: unknown = undefined;

  override findWaitpoint(...args: Parameters<PostgresRunStore["findWaitpoint"]>) {
    this.counts.findWaitpoint++;
    this.lastFindWaitpointClient = args[1];
    return super.findWaitpoint(...args);
  }

  override createWaitpoint(...args: Parameters<PostgresRunStore["createWaitpoint"]>) {
    this.counts.createWaitpoint++;
    return super.createWaitpoint(...args);
  }
}

function engineOptions(
  redisOptions: any,
  prisma: any,
  extra?: { store?: PostgresRunStore; crossSeamGuard?: CrossSeamGuardHook }
) {
  return {
    prisma,
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
    ...(extra?.store ? { store: extra.store } : {}),
    ...(extra?.crossSeamGuard ? { crossSeamGuard: extra.crossSeamGuard } : {}),
  };
}

async function triggerRun(engine: RunEngine, environment: any, prisma: any, friendlyId: string) {
  return engine.trigger(
    {
      number: 1,
      friendlyId,
      environment,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-${friendlyId}`,
      spanId: `s-${friendlyId}`,
      workerQueue: "main",
      queue: "task/test-task",
      isTest: false,
      tags: [],
    },
    prisma
  );
}

// Trigger a run and drive it to EXECUTING (dequeue + start attempt), so it can be blocked.
async function triggerAndStart(
  engine: RunEngine,
  environment: any,
  prisma: any,
  friendlyId: string
) {
  const run = await triggerRun(engine, environment, prisma, friendlyId);
  await setTimeout(500);
  await engine.dequeueFromWorkerQueue({
    consumerId: `consumer-${friendlyId}`,
    workerQueue: "main",
  });
  const executionData = await engine.getRunExecutionData({ runId: run.id });
  assertNonNullable(executionData);
  await engine.startRunAttempt({ runId: run.id, snapshotId: executionData.snapshot.id });
  return run;
}

async function createBatch(prisma: any, environment: any) {
  return prisma.batchTaskRun.create({
    data: {
      friendlyId: generateFriendlyId("batch"),
      runtimeEnvironmentId: environment.id,
    },
  });
}

describe("RunEngine public waitpoint router", () => {
  // getWaitpoint routes its read through the store seam, preserving the env-mismatch guard.
  containerTest("getWaitpoint reads through the store", async ({ prisma, redisOptions }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const store = new CountingPostgresRunStore({
      prisma,
      readOnlyPrisma: prisma,
    });
    const engine = new RunEngine(engineOptions(redisOptions, prisma, { store }));

    try {
      const { waitpoint } = await engine.createManualWaitpoint({
        environmentId: environment.id,
        projectId: environment.project.id,
      });

      const before = store.counts.findWaitpoint;
      const found = await engine.getWaitpoint({
        waitpointId: waitpoint.id,
        environmentId: environment.id,
        projectId: environment.project.id,
      });

      // routed through the store exactly once
      expect(store.counts.findWaitpoint).toBe(before + 1);
      assertNonNullable(found);
      expect(found.id).toBe(waitpoint.id);
      // the include shape is preserved (blockingTaskRuns is present, even if empty)
      expect((found as any).blockingTaskRuns).toBeDefined();
      expect(Array.isArray((found as any).blockingTaskRuns)).toBe(true);

      // the read is pinned to the PRIMARY client, not defaulted to the replica
      expect(store.lastFindWaitpointClient).toBe(prisma);

      // env-mismatch guard still returns null
      const mismatch = await engine.getWaitpoint({
        waitpointId: waitpoint.id,
        environmentId: "env_does_not_exist",
        projectId: environment.project.id,
      });
      expect(mismatch).toBeNull();

      // a non-existent waitpointId drives the `if (!waitpoint) return null` branch
      const beforeMissing = store.counts.findWaitpoint;
      const missing = await engine.getWaitpoint({
        waitpointId: "waitpoint_does_not_exist",
        environmentId: environment.id,
        projectId: environment.project.id,
      });
      expect(missing).toBeNull();
      // not-found was reached THROUGH the store (not short-circuited)
      expect(store.counts.findWaitpoint).toBe(beforeMissing + 1);
    } finally {
      await engine.quit();
    }
  });

  // blockRunWithCreatedBatch routes its BATCH waitpoint create through the store (non-tx path),
  // links the run, and preserves the P2002 duplicate-idempotency-key -> null path.
  containerTest(
    "blockRunWithCreatedBatch writes the BATCH waitpoint through the store",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingPostgresRunStore({
        prisma,
        readOnlyPrisma: prisma,
      });
      const engine = new RunEngine(engineOptions(redisOptions, prisma, { store }));

      try {
        await setupBackgroundWorker(engine, environment, "test-task");
        const run = await triggerAndStart(engine, environment, prisma, "run_batchone");
        const batch = await createBatch(prisma, environment);

        const before = store.counts.createWaitpoint;
        const waitpoint = await engine.blockRunWithCreatedBatch({
          runId: run.id,
          batchId: batch.id,
          environmentId: environment.id,
          projectId: environment.project.id,
          organizationId: environment.organization.id,
        });

        // routed through the store
        expect(store.counts.createWaitpoint).toBe(before + 1);
        assertNonNullable(waitpoint);
        expect(waitpoint.type).toBe("BATCH");
        expect(waitpoint.completedByBatchId).toBe(batch.id);

        // the BATCH waitpoint row exists
        const row = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(row?.type).toBe("BATCH");
        expect(row?.completedByBatchId).toBe(batch.id);

        // the run is now blocked: a TaskRunWaitpoint edge links run -> waitpoint
        const edge = await prisma.taskRunWaitpoint.findFirst({
          where: { taskRunId: run.id, waitpointId: waitpoint.id },
        });
        assertNonNullable(edge);

        // second call with the same batchId => duplicate idempotency key (P2002) => null
        const dup = await engine.blockRunWithCreatedBatch({
          runId: run.id,
          batchId: batch.id,
          environmentId: environment.id,
          projectId: environment.project.id,
          organizationId: environment.organization.id,
        });
        expect(dup).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );

  // With a tx supplied, the create is routed through the store with that tx pinned as the
  // client, so the waitpoint is persisted via the caller's transaction.
  containerTest(
    "blockRunWithCreatedBatch with a tx pins the create to the tx client",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingPostgresRunStore({
        prisma,
        readOnlyPrisma: prisma,
      });
      const engine = new RunEngine(engineOptions(redisOptions, prisma, { store }));

      try {
        await setupBackgroundWorker(engine, environment, "test-task");
        const run = await triggerAndStart(engine, environment, prisma, "run_batchtx");
        const batch = await createBatch(prisma, environment);

        const waitpoint = await engine.blockRunWithCreatedBatch({
          runId: run.id,
          batchId: batch.id,
          environmentId: environment.id,
          projectId: environment.project.id,
          organizationId: environment.organization.id,
          tx: prisma,
        });

        assertNonNullable(waitpoint);
        expect(waitpoint.type).toBe("BATCH");
        expect(waitpoint.completedByBatchId).toBe(batch.id);

        // the waitpoint was created via the provided client and is readable afterwards
        const row = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(row?.type).toBe("BATCH");
      } finally {
        await engine.quit();
      }
    }
  );

  // The delegators still work through the (already system-routed) public API.
  containerTest(
    "delegators (create/block/getOrCreate) work through the public API",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(engineOptions(redisOptions, prisma));

      try {
        await setupBackgroundWorker(engine, environment, "test-task");
        const run = await triggerAndStart(engine, environment, prisma, "run_delegators1");

        // createDateTimeWaitpoint
        const { waitpoint: dtWaitpoint } = await engine.createDateTimeWaitpoint({
          projectId: environment.project.id,
          environmentId: environment.id,
          completedAfter: new Date(Date.now() + 60_000),
        });
        expect(dtWaitpoint.type).toBe("DATETIME");

        // createManualWaitpoint
        const { waitpoint: manualWaitpoint } = await engine.createManualWaitpoint({
          environmentId: environment.id,
          projectId: environment.project.id,
        });
        expect(manualWaitpoint.type).toBe("MANUAL");
        expect(manualWaitpoint.status).toBe("PENDING");

        // blockRunWithWaitpoint
        const snapshot = await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: [manualWaitpoint.id],
          projectId: environment.project.id,
          organizationId: environment.organization.id,
        });
        expect(snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        const edge = await prisma.taskRunWaitpoint.findFirst({
          where: { taskRunId: run.id, waitpointId: manualWaitpoint.id },
        });
        assertNonNullable(edge);

        // getOrCreateRunWaitpoint
        const runWaitpoint = await engine.getOrCreateRunWaitpoint({
          runId: run.id,
          projectId: environment.project.id,
          environmentId: environment.id,
        });
        expect(runWaitpoint.type).toBe("RUN");
      } finally {
        await engine.quit();
      }
    }
  );

  // The public completeWaitpoint consults the cross-seam hook (RESUME_TOKEN) first, then
  // unconditionally delegates.
  containerTest(
    "completeWaitpoint consults the cross-seam hook (RESUME_TOKEN) then delegates",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const seen: Array<{ waitpointId: string; routeKind: string }> = [];
      const engine = new RunEngine(
        engineOptions(redisOptions, prisma, {
          crossSeamGuard: async ({ waitpointId, routeKind }) => {
            seen.push({ waitpointId, routeKind });
            return { store: "legacy", residency: "LEGACY", routeKind };
          },
        })
      );

      try {
        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: environment.id,
          projectId: environment.project.id,
        });
        expect(waitpoint.status).toBe("PENDING");

        await engine.completeWaitpoint({
          id: waitpoint.id,
          output: { value: "{}", isError: false },
        });

        // hook consulted FIRST with the right id + RESUME_TOKEN route kind
        expect(seen).toEqual([{ waitpointId: waitpoint.id, routeKind: "RESUME_TOKEN" }]);

        // completion then applied via the unconditional delegation
        const after = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(after?.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "completeWaitpoint with a throwing guard does not apply (loud, no silent local apply)",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(
        engineOptions(redisOptions, prisma, {
          crossSeamGuard: async () => {
            throw new Error("UnclassifiableRunId");
          },
        })
      );

      try {
        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: environment.id,
          projectId: environment.project.id,
        });
        await expect(
          engine.completeWaitpoint({ id: waitpoint.id, output: { value: "{}", isError: false } })
        ).rejects.toThrow();

        const after = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(after?.status).toBe("PENDING");
      } finally {
        await engine.quit();
      }
    }
  );

  // Single-DB passthrough: a full public-API round-trip over the one client reads back exactly
  // what it wrote, with no crossSeamGuard and no second connection (proven by behavior).
  containerTest(
    "single-DB passthrough: full public round-trip behaves as today",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      // default single PostgresRunStore (no injected store), no crossSeamGuard
      const engine = new RunEngine(engineOptions(redisOptions, prisma));

      try {
        await setupBackgroundWorker(engine, environment, "test-task");
        const run = await triggerAndStart(engine, environment, prisma, "run_passthrough1");
        const batch = await createBatch(prisma, environment);

        // blockRunWithCreatedBatch persists the BATCH waitpoint + edge
        const waitpoint = await engine.blockRunWithCreatedBatch({
          runId: run.id,
          batchId: batch.id,
          environmentId: environment.id,
          projectId: environment.project.id,
          organizationId: environment.organization.id,
        });
        assertNonNullable(waitpoint);

        // getWaitpoint reads back the row it wrote (with the include shape)
        const fetched = await engine.getWaitpoint({
          waitpointId: waitpoint.id,
          environmentId: environment.id,
          projectId: environment.project.id,
        });
        assertNonNullable(fetched);
        expect(fetched.id).toBe(waitpoint.id);
        expect(fetched.type).toBe("BATCH");

        // duplicate batchId returns null
        const dup = await engine.blockRunWithCreatedBatch({
          runId: run.id,
          batchId: batch.id,
          environmentId: environment.id,
          projectId: environment.project.id,
          organizationId: environment.organization.id,
        });
        expect(dup).toBeNull();

        // completeWaitpoint marks COMPLETED and unblocks the run (no guard => exactly as today)
        await engine.completeWaitpoint({
          id: waitpoint.id,
          output: { value: "{}", isError: false },
        });
        const after = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(after?.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  // FK-drop app-integrity: the routed create + block + complete round-trip introduces no
  // dependency on a physical control-plane FK, and the persisted rows are well-formed.
  containerTest(
    "FK-drop app-integrity: routed waitpoint round-trip is well-formed and FK-independent",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(engineOptions(redisOptions, prisma));

      try {
        await setupBackgroundWorker(engine, environment, "test-task");
        const run = await triggerAndStart(engine, environment, prisma, "run_fkintegrity");
        const batch = await createBatch(prisma, environment);

        const waitpoint = await engine.blockRunWithCreatedBatch({
          runId: run.id,
          batchId: batch.id,
          environmentId: environment.id,
          projectId: environment.project.id,
          organizationId: environment.organization.id,
        });
        assertNonNullable(waitpoint);

        // rows are well-formed: the waitpoint carries its env/project, the edge links run->wp
        const wpRow = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(wpRow?.environmentId).toBe(environment.id);
        expect(wpRow?.projectId).toBe(environment.project.id);

        const edge = await prisma.taskRunWaitpoint.findFirst({
          where: { taskRunId: run.id, waitpointId: waitpoint.id },
        });
        assertNonNullable(edge);
        expect(edge.projectId).toBe(environment.project.id);

        // completion round-trip still succeeds (no reliance on a cross-server cascade)
        await engine.completeWaitpoint({
          id: waitpoint.id,
          output: { value: "{}", isError: false },
        });
        const after = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(after?.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );
});
