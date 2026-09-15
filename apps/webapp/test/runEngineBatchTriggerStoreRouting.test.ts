import { describe, expect, vi } from "vitest";

// Redirect the module-level db client to the per-test container prisma so the worker-path
// env resolution (`findEnvironmentById`/`controlPlaneResolver`, which read `~/db.server`)
// hits the real container DB. The DB itself is never mocked — only the module binding is
// pointed at the container client created by the fixture.
const dbHolder = vi.hoisted(() => ({ prisma: undefined as any }));
vi.mock("~/db.server", () => ({
  get prisma() {
    return dbHolder.prisma;
  },
  get $replica() {
    return dbHolder.prisma;
  },
}));

import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import { containerTestWithIsolatedRedisNoClickhouse as containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { RunEngineBatchTriggerService } from "../app/runEngine/services/batchTrigger.server";

vi.setConfig({ testTimeout: 120_000 });

function buildEngine(prisma: PrismaClient, redisOptions: any, store?: RoutingRunStore) {
  return new RunEngine({
    prisma,
    ...(store ? { store } : {}),
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
      disabled: true,
    },
    queue: { redis: redisOptions },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0005,
    },
    batchQueue: { redis: redisOptions },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

function batchCreateData(params: {
  id: string;
  friendlyId: string;
  runtimeEnvironmentId: string;
  runCount: number;
  payload: string;
}) {
  return {
    id: params.id,
    friendlyId: params.friendlyId,
    runtimeEnvironmentId: params.runtimeEnvironmentId,
    runCount: params.runCount,
    runIds: [] as string[],
    payload: params.payload,
    payloadType: "application/json",
    options: {},
    batchVersion: "runengine:v1",
  };
}

describe("RunEngineBatchTriggerService store routing", () => {
  // The service issues BatchTaskRun create/find/update through `this._engine.runStore`.
  // With an injected RoutingRunStore whose NEW slot is a PostgresRunStore, those calls
  // land on the run-ops store (born on NEW), not on a separate `this._prisma` path.
  containerTest(
    "create/find/update route through the injected run-ops store",
    async ({ prisma, redisOptions }) => {
      dbHolder.prisma = prisma;
      const runStore = new RoutingRunStore({
        new: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        legacy: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
      });
      const engine = buildEngine(prisma, redisOptions, runStore);

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const service = new RunEngineBatchTriggerService("sequential", prisma, engine);

      // The service holds the injected routing store.
      expect(service["_engine"].runStore).toBe(runStore);

      // (create) Born on the run-ops store and present in the DB.
      const { id, friendlyId } = BatchId.generate();
      const created = await service["_engine"].runStore.createBatchTaskRun(
        batchCreateData({
          id,
          friendlyId,
          runtimeEnvironmentId: authenticatedEnvironment.id,
          runCount: 1,
          payload: "[]",
        })
      );
      expect(created.id).toBe(id);
      expect(await prisma.batchTaskRun.findUnique({ where: { id } })).not.toBeNull();

      // (find + update) Drive the worker entrypoint with an empty payload so no child runs
      // are triggered: the path exercises findBatchTaskRunById -> findEnvironmentById ->
      // inline-payload parse -> updateBatchTaskRun, all through the store.
      await service.processBatchTaskRun({
        batchId: id,
        processingId: "0",
        range: { start: 0, count: 50 },
        attemptCount: 0,
        strategy: "sequential",
      });

      // The update routed through the store ran (processingJobsCount incremented by the 0
      // processed items; runIds untouched). The row is the one written to the run-ops DB.
      const after = await prisma.batchTaskRun.findUnique({ where: { id } });
      expect(after).not.toBeNull();
      expect(after!.processingJobsCount).toBe(0);
      expect(after!.runIds).toEqual([]);

      await engine.quit();
    }
  );

  // Single-DB passthrough (self-host collapse): with no `store` injected, the engine
  // defaults to a PostgresRunStore over the one client, byte-identical to pre-routing.
  containerTest(
    "single-DB passthrough uses the default PostgresRunStore",
    async ({ prisma, redisOptions }) => {
      dbHolder.prisma = prisma;
      const engine = buildEngine(prisma, redisOptions);

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const service = new RunEngineBatchTriggerService("sequential", prisma, engine);

      // The default store is a plain PostgresRunStore (no RoutingRunStore, no second client).
      expect(service["_engine"].runStore).toBeInstanceOf(PostgresRunStore);
      expect(service["_engine"].runStore).not.toBeInstanceOf(RoutingRunStore);

      const { id, friendlyId } = BatchId.generate();
      await service["_engine"].runStore.createBatchTaskRun(
        batchCreateData({
          id,
          friendlyId,
          runtimeEnvironmentId: authenticatedEnvironment.id,
          runCount: 1,
          payload: "[]",
        })
      );

      await service.processBatchTaskRun({
        batchId: id,
        processingId: "0",
        range: { start: 0, count: 50 },
        attemptCount: 0,
        strategy: "sequential",
      });

      const after = await prisma.batchTaskRun.findUnique({ where: { id } });
      expect(after).not.toBeNull();
      expect(after!.processingJobsCount).toBe(0);

      await engine.quit();
    }
  );
});
