// Waitpoint-store flag lookups per engine operation. The engine's resolver reads the org flag with one
// Organization query on its own PrismaClient, and every query that client runs is counted from Prisma's
// query events. Real Postgres + Redis, no mocks.
import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import type { RunEngineOptions } from "../types.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import {
  organizationFlagResolver,
  organizationQueryCounter,
} from "./utils/organizationFlagLookups.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

type Env = Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>;
const taskIdentifier = "test-task";

function engineWith(
  prisma: PrismaClient,
  redisOptions: RunEngineOptions["queue"]["redis"],
  extra: Partial<RunEngineOptions>
) {
  return new RunEngine({
    prisma,
    worker: { redis: redisOptions, disabled: true },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("waitpoint-flag-lookups", "0.0.0"),
    ...extra,
  });
}

async function environment(prisma: PrismaClient, orgEnabled: boolean): Promise<Env> {
  const seeded = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  await prisma.organization.update({
    where: { id: seeded.organizationId },
    data: { featureFlags: { waitpointStoreEnabled: orgEnabled } },
  });
  return prisma.runtimeEnvironment.findUniqueOrThrow({
    where: { id: seeded.id },
    include: { project: true, organization: true, orgMember: true },
  });
}

async function executingRun(engine: RunEngine, env: Env, prisma: PrismaClient) {
  await setupBackgroundWorker(engine, env, [taskIdentifier]);
  const run = await engine.trigger(
    {
      number: 1,
      friendlyId: "run_flagperop1",
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t-flagperop1",
      spanId: "s-flagperop1",
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );
  for (let i = 0; i < 25; i++) {
    await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_flagperop",
      workerQueue: "main",
    });
    if (dequeued.length > 0) {
      const attempt = await engine.startRunAttempt({
        runId: run.id,
        snapshotId: dequeued[0]!.snapshot.id,
      });
      return { run, attempt };
    }
    await setTimeout(200);
  }
  throw new Error("run never reached the worker queue");
}

async function blockedRun(engine: RunEngine, env: Env, prisma: PrismaClient) {
  const { run } = await executingRun(engine, env, prisma);
  const { waitpoint } = await engine.createManualWaitpoint({
    runId: run.id,
    environmentId: env.id,
    projectId: env.projectId,
  });
  const blocked = await engine.blockRunWithWaitpoint({
    runId: run.id,
    waitpoints: waitpoint.id,
    projectId: env.projectId,
    organizationId: env.organizationId,
  });
  expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(1);
  return { run, blocked };
}

// Each terminal operation, run for a flag-off org and an enabled one. A flag-off org resolves the flag
// once; an enabled org rechecks after the terminal write, so its count is unchanged at 2.
const operations = [
  {
    name: "successful attempt completion",
    run: async (engine: RunEngine, env: Env, prisma: PrismaClient) => {
      const { run, attempt } = await executingRun(engine, env, prisma);
      return async () => {
        const result = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          completion: { id: run.id, ok: true, output: '{"ok":1}', outputType: "application/json" },
        });
        expect(result.run.status).toBe("COMPLETED_SUCCESSFULLY");
      };
    },
  },
  {
    name: "terminal failed attempt",
    run: async (engine: RunEngine, env: Env, prisma: PrismaClient) => {
      const { run, attempt } = await executingRun(engine, env, prisma);
      return async () => {
        const result = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          completion: {
            id: run.id,
            ok: false,
            error: { type: "BUILT_IN_ERROR", name: "Error", message: "boom", stackTrace: "" },
          },
        });
        expect(result.attemptStatus).toBe("RUN_FINISHED");
        expect(result.run.status).toBe("COMPLETED_WITH_ERRORS");
      };
    },
  },
  {
    name: "cancellation",
    run: async (engine: RunEngine, env: Env, prisma: PrismaClient) => {
      const { run } = await executingRun(engine, env, prisma);
      return async () => {
        const result = await engine.cancelRun({ runId: run.id, finalizeRun: true });
        expect(result.snapshot?.executionStatus).toBe("FINISHED");
      };
    },
  },
] as const;

describe("waitpoint flag lookups per operation", () => {
  // Catches: completion, failure or cancel resolving a flag-off org's flag again in #finalizeRun.
  containerTest.for(operations)(
    "a flag-off org resolves the flag once per $name",
    async (operation, { prisma, postgresContainer, redisOptions }) => {
      const counter = organizationQueryCounter(postgresContainer.getConnectionUri());
      const env = await environment(prisma, false);
      const engine = engineWith(prisma, redisOptions, {
        waitpointStoreEnabled: organizationFlagResolver(counter.client),
      });
      try {
        const act = await operation.run(engine, env, prisma);
        const measured = await counter.measure(act);
        expect(measured.lookups).toBe(1);
      } finally {
        await engine.quit();
        await counter.client.$disconnect();
      }
    }
  );

  // Catches: reusing an enabled decision across the terminal write, so #finalizeRun skips its recheck.
  containerTest.for(operations)(
    "an enabled org still rechecks the flag per $name",
    async (operation, { prisma, postgresContainer, redisOptions }) => {
      const counter = organizationQueryCounter(postgresContainer.getConnectionUri());
      const env = await environment(prisma, true);
      const engine = engineWith(prisma, redisOptions, {
        waitpointStoreEnabled: organizationFlagResolver(counter.client),
      });
      try {
        const act = await operation.run(engine, env, prisma);
        const measured = await counter.measure(act);
        expect(measured.lookups).toBe(2);
      } finally {
        await engine.quit();
        await counter.client.$disconnect();
      }
    }
  );

  // Catches: the reused disabled decision leaking into an enabled org's terminal cleanup. An enabled
  // org's finalization releases the run's remaining blockers; a flag-off org's leaves them.
  containerTest.for([true, false])(
    "a successful completion still runs the enabled terminal cleanup (org enabled=%s)",
    async (orgEnabled, { prisma, postgresContainer, redisOptions }) => {
      const counter = organizationQueryCounter(postgresContainer.getConnectionUri());
      const env = await environment(prisma, orgEnabled);
      const engine = engineWith(prisma, redisOptions, {
        waitpointStoreEnabled: organizationFlagResolver(counter.client),
      });
      try {
        const { run, blocked } = await blockedRun(engine, env, prisma);
        const completed = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: blocked.id,
          completion: { id: run.id, ok: true, output: '{"ok":1}', outputType: "application/json" },
        });
        expect(completed.snapshot.executionStatus).toBe("FINISHED");
        expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(
          orgEnabled ? 0 : 1
        );
      } finally {
        await engine.quit();
        await counter.client.$disconnect();
      }
    }
  );
});

describe("waitpoint flag lookups of a suspend", () => {
  const checkpoint = {
    type: "KUBERNETES" as const,
    reason: "TEST_CHECKPOINT",
    location: "test-location",
    imageRef: "test-image-ref",
  };

  // The engine's resolver, wrapped to read the environment's checkpoint row count (on the engine's
  // own client) each time it is called.
  function countingResolver(prisma: PrismaClient, client: PrismaClient, env: Env) {
    const resolve = organizationFlagResolver(client);
    const rowsSeen: number[] = [];
    const resolver: NonNullable<RunEngineOptions["waitpointStoreEnabled"]> = async (
      organizationId,
      organizationFlags
    ) => {
      rowsSeen.push(
        await prisma.taskRunCheckpoint.count({ where: { runtimeEnvironmentId: env.id } })
      );
      return resolve(organizationId, organizationFlags);
    };
    return { resolver, rowsSeen };
  }

  // Waitpoint routing and store wired as the webapp wires them. The suspend's own flag lookup runs
  // only behind the routing, and the store adds one lookup to every latest-snapshot read.
  function routedEngine(
    prisma: PrismaClient,
    redisOptions: RunEngineOptions["queue"]["redis"],
    resolver: NonNullable<RunEngineOptions["waitpointStoreEnabled"]>
  ) {
    const store = new WaitpointStoreCoordinator({ redisOptions });
    const engine = engineWith(prisma, redisOptions, {
      waitpointStoreEnabled: resolver,
      waitpointRouting: {
        store: new StoreWaitpointCoordinator({ store }),
        mintPolicy: { resolveMintMode: () => "redis", isCapabilityReady: () => true },
      },
      waitpointStore: store,
      waitpointFanoutStore: store,
    });
    return { engine, store };
  }

  // Catches: a suspend of a waiting run resolving the flag again after the checkpoint insert, or not
  // at all; or a discarded suspend resolving it beyond its latest read.
  containerTest(
    "a suspend of a waiting run makes one lookup after the checkpoint insert, and a discarded one only its latest read's",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const counter = organizationQueryCounter(postgresContainer.getConnectionUri());
      const env = await environment(prisma, false);
      const { resolver, rowsSeen } = countingResolver(prisma, counter.client, env);
      const { engine, store } = routedEngine(prisma, redisOptions, resolver);
      try {
        const { run, blocked } = await blockedRun(engine, env, prisma);
        expect(blocked.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        rowsSeen.length = 0;
        const suspend = await counter.measure(() =>
          engine.createCheckpoint({ runId: run.id, snapshotId: blocked.id, checkpoint })
        );
        expect(suspend.result.ok).toBe(true);
        if (!suspend.result.ok) return;
        expect(suspend.result.snapshot.executionStatus).toBe("SUSPENDED");
        // The latest read's lookup (no checkpoint row yet), then the suspend's own (one row).
        expect(suspend.lookups).toBe(2);
        expect(rowsSeen).toEqual([0, 1]);

        rowsSeen.length = 0;
        const discarded = await counter.measure(() =>
          engine.createCheckpoint({
            runId: run.id,
            snapshotId: suspend.result.ok ? suspend.result.snapshot.id : "",
            checkpoint,
          })
        );
        expect(discarded.result).toEqual({
          ok: false,
          error: "Status SUSPENDED is not checkpointable",
        });
        // Only the latest read's lookup; no row is added.
        expect(discarded.lookups).toBe(1);
        expect(rowsSeen).toEqual([1]);
        expect(
          await prisma.taskRunCheckpoint.count({ where: { runtimeEnvironmentId: env.id } })
        ).toBe(1);
      } finally {
        await engine.quit();
        await store.quit();
        await counter.client.$disconnect();
      }
    }
  );

  // Catches: a suspend of an executing run resolving the waitpoint flag after the checkpoint insert.
  containerTest(
    "a suspend of an executing run makes no lookup after the checkpoint insert and is accepted",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const counter = organizationQueryCounter(postgresContainer.getConnectionUri());
      const env = await environment(prisma, false);
      const { resolver, rowsSeen } = countingResolver(prisma, counter.client, env);
      const { engine, store } = routedEngine(prisma, redisOptions, resolver);
      try {
        const { run, attempt } = await executingRun(engine, env, prisma);
        expect(attempt.snapshot.executionStatus).toBe("EXECUTING");

        rowsSeen.length = 0;
        const suspend = await counter.measure(() =>
          engine.createCheckpoint({ runId: run.id, snapshotId: attempt.snapshot.id, checkpoint })
        );
        expect(suspend.result.ok).toBe(true);
        // Only the latest read's lookup, before the insert.
        expect(suspend.lookups).toBe(1);
        expect(rowsSeen).toEqual([0]);
        expect(
          await prisma.taskRunCheckpoint.count({ where: { runtimeEnvironmentId: env.id } })
        ).toBe(1);
      } finally {
        await engine.quit();
        await store.quit();
        await counter.client.$disconnect();
      }
    }
  );
});
