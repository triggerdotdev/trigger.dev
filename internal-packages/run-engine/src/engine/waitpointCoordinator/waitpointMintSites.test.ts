import {
  MEMORYDB_SHARD_KEY,
  PostgresRunStore,
  RedisSnapshotStore,
  RoutingRunStore,
  type RunStore,
} from "@internal/run-store";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { Logger } from "@trigger.dev/core/logger";
import { generateRunOpsIdV2, RunId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient, Waitpoint } from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { PostgresWaitpointOnMemoryDbAnchor } from "../errors.js";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";
import {
  dequeueAndStart,
  makeEngine,
  triggerRun,
} from "../tests/utils/storeRunWaitpointLifecycleFixtures.js";
import { deriveBatchWaitpointId } from "./runWaitpointId.js";
import { WaitpointStoreCoordinator } from "./storeCoordinator.js";
import { LegacyPostgresWaitpointCoordinator } from "./legacyPostgresCoordinator.js";

// These drive the real create sites: calling the helper directly passes even when a site stops
// passing its anchor.
const GEN2_RUN = `${"a".repeat(24)}a2`;
const GEN1_RUN = `${"a".repeat(24)}01`;
const GEN2_BATCH = `${"d".repeat(24)}b2`;
const GEN1_BATCH = `${"d".repeat(24)}01`;

type Captured = { id?: string; friendlyId?: string };

function coordinatorCapturing(captured: Captured) {
  const runStore = {
    findWaitpoint: async () => null,
    upsertWaitpoint: async (args: { create: Captured }) => {
      captured.id = args.create.id;
      captured.friendlyId = args.create.friendlyId;
      return { id: args.create.id } as unknown as Waitpoint;
    },
    createWaitpoint: async (args: { data: Captured }) => {
      captured.id = args.data.id;
      captured.friendlyId = args.data.friendlyId;
      return { id: args.data.id } as unknown as Waitpoint;
    },
  } as unknown as RunStore;

  return new LegacyPostgresWaitpointCoordinator({
    runStore: () => runStore,
    prisma: {} as unknown as PrismaClient,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as Logger,
  });
}

describe("createDateTimeWaitpoint stamps the anchor's shard", () => {
  it("a gen-2 run anchor yields a gen-2 waitpoint id", async () => {
    const captured: Captured = {};
    await coordinatorCapturing(captured).createDateTimeWaitpoint({
      runId: GEN2_RUN,
      projectId: "proj",
      environmentId: "env",
      completedAfter: new Date(),
    });

    expect(captured.id).toHaveLength(26);
    expect(captured.id?.[24]).toBe("a");
    expect(captured.id?.[25]).toBe("2");
    expect(captured.friendlyId).toBe(`waitpoint_${captured.id}`);
  });

  it("a gen-1 run anchor keeps a cuid", async () => {
    const captured: Captured = {};
    await coordinatorCapturing(captured).createDateTimeWaitpoint({
      runId: GEN1_RUN,
      projectId: "proj",
      environmentId: "env",
      completedAfter: new Date(),
    });

    expect(captured.id).toHaveLength(25);
  });
});

describe("createManualWaitpoint stamps the anchor's shard", () => {
  it("a gen-2 run anchor yields a gen-2 waitpoint id", async () => {
    const captured: Captured = {};
    await coordinatorCapturing(captured).createManualWaitpoint({
      runId: GEN2_RUN,
      projectId: "proj",
      environmentId: "env",
    });

    expect(captured.id?.[24]).toBe("a");
    expect(captured.id?.[25]).toBe("2");
  });

  // Catches: a manual waitpoint anchored on a gen-1 run minted on a shard instead of as a cuid.
  it("a gen-1 run anchor keeps a cuid", async () => {
    const captured: Captured = {};
    await coordinatorCapturing(captured).createManualWaitpoint({
      runId: GEN1_RUN,
      projectId: "proj",
      environmentId: "env",
    });

    expect(captured.id).toHaveLength(25);
  });

  it("a standalone token mints by the environment's shard, not by an anchor", async () => {
    const captured: Captured = {};
    await coordinatorCapturing(captured).createManualWaitpoint({
      projectId: "proj",
      environmentId: "env",
      standaloneShardKey: "c",
    });

    expect(captured.id?.[24]).toBe("c");
    expect(captured.id?.[25]).toBe("2");
  });

  it("a standalone token on a gen-1 environment keeps a cuid", async () => {
    const captured: Captured = {};
    await coordinatorCapturing(captured).createManualWaitpoint({
      projectId: "proj",
      environmentId: "env",
      standaloneShardKey: "new",
      standaloneResidency: "NEW",
    });

    expect(captured.id).toHaveLength(25);
  });

  it("an owning run outranks the environment shard", async () => {
    const captured: Captured = {};
    await coordinatorCapturing(captured).createManualWaitpoint({
      runId: GEN2_RUN,
      projectId: "proj",
      environmentId: "env",
      standaloneShardKey: "c",
    });

    expect(captured.id?.[24]).toBe("a");
  });
});

describe("createBatchWaitpoint stamps the batch's shard", () => {
  // Catches: a batch waitpoint that stops taking a gen-2 batch's shard, or mints one for a gen-1 batch.
  it("a gen-2 batch yields a waitpoint id on its shard, a gen-1 batch a cuid", async () => {
    const onShard: Captured = {};
    await coordinatorCapturing(onShard).createBatchWaitpoint({
      batchId: GEN2_BATCH,
      projectId: "proj",
      environmentId: "env",
    });
    expect(onShard.id).toHaveLength(26);
    expect(onShard.id?.[24]).toBe("b");
    expect(onShard.id?.[25]).toBe("2");

    const cuid: Captured = {};
    await coordinatorCapturing(cuid).createBatchWaitpoint({
      batchId: GEN1_BATCH,
      projectId: "proj",
      environmentId: "env",
    });
    expect(cuid.id).toHaveLength(25);
  });
});

describe("mintAssociatedWaitpointData stamps the anchor's shard", () => {
  const mint = (anchorRunId: string) =>
    coordinatorCapturing({}).mintAssociatedWaitpointData({
      projectId: "proj",
      environmentId: "env",
      anchorRunId,
    });

  it("a gen-2 run anchor yields a gen-2 waitpoint id", () => {
    const data = mint(GEN2_RUN);
    expect(data.id).toHaveLength(26);
    expect(data.id[24]).toBe("a");
    expect(data.id[25]).toBe("2");
    expect(data.friendlyId).toBe(`waitpoint_${data.id}`);
  });

  it("a gen-1 run anchor keeps a cuid", () => {
    expect(mint(GEN1_RUN).id).toHaveLength(25);
  });

  it("mints a fresh core, so the waitpoint id never equals the run's own body", () => {
    expect(mint(GEN2_RUN).id).not.toBe(GEN2_RUN);
  });

  it("a batch anchor stamps the batch's shard", () => {
    expect(mint(GEN2_BATCH).id[24]).toBe("b");
  });
});

// Every method call is recorded and resolves to null; `then` stays undefined so nothing awaits it.
function countingStore(calls: string[]): RunStore {
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === "then"
          ? undefined
          : (..._args: unknown[]) => {
              calls.push(String(prop));
              return Promise.resolve(null);
            },
    }
  ) as unknown as RunStore;
}

function coordinatorCounting(calls: string[]) {
  return new LegacyPostgresWaitpointCoordinator({
    runStore: () => countingStore(calls),
    prisma: {} as unknown as PrismaClient,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as Logger,
  });
}

async function refusalOf(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to be refused");
}

function expectRefused(error: unknown, anchorId: string) {
  expect(error).toBeInstanceOf(PostgresWaitpointOnMemoryDbAnchor);
  expect(error).toMatchObject({
    name: "PostgresWaitpointOnMemoryDbAnchor",
    anchorId,
    message: `A Postgres waitpoint cannot be anchored on "${anchorId}": it is a MemoryDB run or batch`,
  });
}

describe("a MemoryDB anchor is refused at each coordinator mint site", () => {
  // Catches: a Postgres DATETIME waitpoint anchored on a MemoryDB run, or a refusal after the dedup look-up.
  it("createDateTimeWaitpoint refuses before any run store call", async () => {
    const calls: string[] = [];
    const runId = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
    const error = await refusalOf(() =>
      coordinatorCounting(calls).createDateTimeWaitpoint({
        runId,
        projectId: "proj",
        environmentId: "env",
        completedAfter: new Date(),
        idempotencyKey: "key",
      })
    );
    expectRefused(error, runId);
    expect(calls).toEqual([]);
  });

  // Catches: a Postgres MANUAL waitpoint anchored on a MemoryDB run, or a refusal after the dedup look-up.
  it("createManualWaitpoint refuses before any run store call", async () => {
    const calls: string[] = [];
    const runId = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
    const error = await refusalOf(() =>
      coordinatorCounting(calls).createManualWaitpoint({
        runId,
        projectId: "proj",
        environmentId: "env",
        idempotencyKey: "key",
      })
    );
    expectRefused(error, runId);
    expect(calls).toEqual([]);
  });

  // Catches: a child's RUN waitpoint minted for Postgres on a MemoryDB run or batch.
  it("mintAssociatedWaitpointData throws synchronously for a run or batch anchor", () => {
    const calls: string[] = [];
    for (const anchorRunId of [
      generateRunOpsIdV2(MEMORYDB_SHARD_KEY),
      generateRunOpsIdV2(MEMORYDB_SHARD_KEY), // a batch id has the same shape
    ]) {
      let error: unknown;
      try {
        coordinatorCounting(calls).mintAssociatedWaitpointData({
          projectId: "proj",
          environmentId: "env",
          anchorRunId,
        });
      } catch (thrown) {
        error = thrown;
      }
      expectRefused(error, anchorRunId);
    }
    expect(calls).toEqual([]);
  });

  // Catches: a refusal that reads a character position instead of the id's shape.
  it("does not refuse a cuid whose 24th character is m, or that ends in m2", async () => {
    for (const cuid of ["clh4abcdefghijklnopqrstmu", "clh4abcdefghijklnopqrstm2"]) {
      expect(cuid).toHaveLength(25);
      expect(
        coordinatorCapturing({}).mintAssociatedWaitpointData({
          projectId: "proj",
          environmentId: "env",
          anchorRunId: cuid,
        }).id
      ).toHaveLength(25);
      const captured: Captured = {};
      await coordinatorCapturing(captured).createDateTimeWaitpoint({
        runId: cuid,
        projectId: "proj",
        environmentId: "env",
        completedAfter: new Date(),
      });
      expect(captured.id).toHaveLength(25);
    }
  });

  // Catches: a Postgres BATCH waitpoint anchored on a MemoryDB batch.
  it("createBatchWaitpoint refuses before any run store call", async () => {
    const calls: string[] = [];
    const batchId = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
    const error = await refusalOf(() =>
      coordinatorCounting(calls).createBatchWaitpoint({
        batchId,
        projectId: "proj",
        environmentId: "env",
      })
    );
    expectRefused(error, batchId);
    expect(calls).toEqual([]);
  });
});

function routingWithStandIn(prisma: PrismaClient, standIn: RunStore) {
  return new RoutingRunStore({
    new: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
    legacy: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
    shards: [{ key: MEMORYDB_SHARD_KEY, store: standIn }],
  });
}

function engineWithStandIn(redisOptions: any, prisma: PrismaClient, standIn: RunStore) {
  return new RunEngine({
    prisma,
    store: routingWithStandIn(prisma, standIn),
    worker: {
      disabled: true,
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 20,
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
  });
}

describe("the engine reaches the refusal on the path the waitpoint flag off takes", () => {
  // Catches: a wait, child or batch of a MemoryDB run that writes a Postgres waitpoint or run.
  containerTest(
    "each engine entry point rejects a MemoryDB anchor and writes nothing",
    async ({ prisma, redisOptions }) => {
      const calls: string[] = [];
      const engine = engineWithStandIn(redisOptions, prisma, countingStore(calls));
      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const ids = {
          environmentId: environment.id,
          projectId: environment.projectId,
          organizationId: environment.organizationId,
        };

        const expectRefusedWithoutWrites = async (
          anchorId: string,
          call: () => Promise<unknown>
        ) => {
          const before = [await prisma.waitpoint.count(), await prisma.taskRun.count()];
          calls.length = 0;
          expectRefused(await refusalOf(call), anchorId);
          expect([await prisma.waitpoint.count(), await prisma.taskRun.count()]).toEqual(before);
          expect(calls).toEqual([]);
        };

        const dateTimeRunId = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
        await expectRefusedWithoutWrites(dateTimeRunId, () =>
          engine.createDateTimeWaitpoint({
            ...ids,
            runId: dateTimeRunId,
            completedAfter: new Date(Date.now() + 60_000),
          })
        );

        const manualRunId = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
        await expectRefusedWithoutWrites(manualRunId, () =>
          engine.createManualWaitpoint({ ...ids, runId: manualRunId })
        );

        const childId = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
        const parentId = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
        await expectRefusedWithoutWrites(childId, () =>
          engine.trigger(
            {
              number: 1,
              friendlyId: `run_${childId}`,
              environment,
              taskIdentifier: "child-task",
              payload: "{}",
              payloadType: "application/json",
              context: {},
              traceContext: {},
              traceId: "t12345",
              spanId: "s12345",
              workerQueue: "main",
              queue: "task/child-task",
              isTest: false,
              tags: [],
              parentTaskRunId: parentId,
              resumeParentOnCompletion: true,
            },
            prisma
          )
        );

        const batchId = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
        await expectRefusedWithoutWrites(batchId, () =>
          engine.blockRunWithCreatedBatch({
            ...ids,
            runId: generateRunOpsIdV2(MEMORYDB_SHARD_KEY),
            batchId,
          })
        );
      } finally {
        await engine.quit();
      }
    }
  );
});

describe("blockRunWithCreatedBatch with the waitpoint store on", () => {
  // Catches: a generation 3 batch given a Postgres BATCH waitpoint on the waitpoint store's lock arm.
  containerTest(
    "refuses a MemoryDB batch when the native batch arm declines it",
    async ({ prisma, redisOptions }) => {
      const calls: string[] = [];
      const engine = makeEngine(prisma, redisOptions, {
        store: new WaitpointStoreCoordinator({ redisOptions }),
        snapshotStore: new RedisSnapshotStore({ redisOptions, completedTtlMs: 60000 }),
        runStore: routingWithStandIn(prisma, countingStore(calls)),
        workerDisabled: true,
        // The store is wired and on, but cannot mint a native batch, so the native arm returns undefined.
        isCapabilityReady: () => false,
      });
      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const organizationId = environment.organizationId;
        expect(await engine.waitpointSystem.isWaitpointStoreEnabled(organizationId)).toBe(true);
        expect(await engine.waitpointSystem.isStoreRoutingEnabled(organizationId)).toBe(true);

        const batchId = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
        const before = [await prisma.waitpoint.count(), await prisma.taskRun.count()];
        calls.length = 0;
        const error = await refusalOf(() =>
          engine.blockRunWithCreatedBatch({
            runId: generateRunOpsIdV2(MEMORYDB_SHARD_KEY),
            batchId,
            environmentId: environment.id,
            projectId: environment.projectId,
            organizationId,
          })
        );
        expectRefused(error, batchId);
        expect([await prisma.waitpoint.count(), await prisma.taskRun.count()]).toEqual(before);
        expect(calls).toEqual([]);
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: the refusal placed before the native batch arm, which takes a MemoryDB batch to the store.
  containerTest(
    "lets the native batch arm take a MemoryDB batch to the store",
    async ({ prisma, redisOptions }) => {
      const engine = makeEngine(prisma, redisOptions, {
        store: new WaitpointStoreCoordinator({ redisOptions }),
        snapshotStore: new RedisSnapshotStore({ redisOptions, completedTtlMs: 60000 }),
        resolveDial: () => "off",
        recoveryDelayMs: 60000,
      });
      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, environment, ["parent"]);
        const parent = await triggerRun(engine, environment, prisma, {
          friendlyId: RunId.generate().friendlyId,
          taskIdentifier: "parent",
        });
        await dequeueAndStart(engine, "memorydb-batch-parent");
        const batchId = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
        await prisma.batchTaskRun.create({
          data: {
            id: batchId,
            friendlyId: `batch_${batchId}`,
            runtimeEnvironmentId: environment.id,
            runCount: 1,
            expectedCount: 1,
            sealed: false,
            status: "PENDING",
          },
        });

        const waitpoint = await engine.blockRunWithCreatedBatch({
          runId: parent.id,
          batchId,
          environmentId: environment.id,
          projectId: environment.projectId,
          organizationId: environment.organizationId,
        });

        expect(waitpoint?.id).toBe(deriveBatchWaitpointId(batchId));
        expect(await prisma.waitpoint.count({ where: { completedByBatchId: batchId } })).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );
});
