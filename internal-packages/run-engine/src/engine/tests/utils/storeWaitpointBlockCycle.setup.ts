import { trace } from "@internal/tracing";
import {
  type RedisSnapshotStore,
  PostgresRunStore,
  SnapshotResidencyResolver,
  TaskRunExecutionSnapshotStore,
  type RunStore,
} from "@internal/run-store";
import { generateWaitpointId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { type RedisOptions } from "@internal/redis";
import type { PrismaClient } from "@trigger.dev/database";
import { expect, vi } from "vitest";
import { RunEngine } from "../../index.js";
import { cycleAnchorSnapshotId } from "../../systems/waitpointSystem.js";
import { createCompletedWaitpointResolver } from "../../systems/completedWaitpointResolver.js";
import { StoreWaitpointCoordinator } from "../../waitpointCoordinator/storeWaitpointCoordinator.js";
import type { WaitpointStoreCoordinator } from "../../waitpointCoordinator/storeCoordinator.js";
import type { WaitpointCoordinator } from "../../waitpointCoordinator/types.js";
import type { setupAuthenticatedEnvironment } from "../setup.js";

export async function boundedBarrier(promise: Promise<void>, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

vi.setConfig({ testTimeout: 60_000 });

function makeRedisRunStore(
  prisma: PrismaClient,
  snapshotStore: RedisSnapshotStore
): TaskRunExecutionSnapshotStore {
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  return new TaskRunExecutionSnapshotStore(delegate, {
    store: snapshotStore,
    mode: "redis-only",
    resolveDial: () => "redis-only",
    residencyResolver: new SnapshotResidencyResolver({
      store: snapshotStore,
    }),
    resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
    logicalRunStoreRoute: "logical:1",
  });
}

export function makeEngine(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  store: WaitpointStoreCoordinator,
  snapshotStore: RedisSnapshotStore,
  // The real adapter the routing coordinator drives.
  coordinator: WaitpointCoordinator = new StoreWaitpointCoordinator({ store }),
  // The activation flag. Enabled discovery uses the actual durable run marker.
  isWaitpointStoreEnabled: () => boolean = () => true,
  retryWarmStartThresholdMs?: number,
  runStore?: RunStore,
  workerDisabled = false
) {
  return new RunEngine({
    prisma,
    retryWarmStartThresholdMs,
    store: runStore ?? makeRedisRunStore(prisma, snapshotStore),
    worker: {
      redis: redisOptions,
      disabled: workerDisabled,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
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
    tracer: trace.getTracer("test", "0.0.0"),
    // Arm the store, redis-primary-eligible for every org in these tests.
    waitpointStoreEnabled: isWaitpointStoreEnabled,
    waitpointRouting: {
      store: coordinator,
      mintPolicy: { resolveMintMode: () => "redis", isCapabilityReady: () => true },
    },
    // The completed-record reader, so a Redis-primary resume resolves store completions.
    waitpointStore: store,
  });
}

export async function seedStoreWaitpoint(
  store: WaitpointStoreCoordinator,
  environmentId: string,
  projectId: string,
  organizationId: string,
  type: "MANUAL" | "RUN" = "MANUAL"
): Promise<string> {
  const id = generateWaitpointId(type);
  const now = new Date().toISOString();
  const record = {
    id,
    friendlyId: WaitpointId.toFriendlyId(id),
    type,
    environmentId,
    projectId,
    organizationId,
    completedByTaskRunId: type === "RUN" ? `child_${id}` : undefined,
    createdAt: now,
    updatedAt: now,
    userProvidedIdempotencyKey: false,
    tags: [],
  };
  // Match the native MANUAL producer: catalog ownership precedes canonical publication.
  if (type === "MANUAL") await store.manualCatalog.publish(record, Date.now() + 300_000);
  await store.createIfAbsent({ record, status: "PENDING" });
  return id;
}

export async function runToExecuting(
  engine: RunEngine,
  env: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>,
  taskIdentifier: string,
  prisma: PrismaClient,
  friendlyId: string
) {
  const run = await engine.trigger(
    {
      number: 1,
      friendlyId,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t_${friendlyId}`,
      spanId: `s_${friendlyId}`,
      workerQueue: "main",
      queue: "task/test-task",
      isTest: false,
      tags: [],
    },
    prisma
  );
  const dequeued = await vi.waitFor(
    async () => {
      const d = await engine.dequeueFromWorkerQueue({
        consumerId: `c_${friendlyId}`,
        workerQueue: "main",
        blockingPopTimeoutSeconds: 1,
      });
      expect(d.length, "run never reached the worker queue").toBe(1);
      return d;
    },
    { timeout: 10_000, interval: 100 }
  );
  const attempt = await engine.startRunAttempt({
    runId: dequeued[0]!.run.id,
    snapshotId: dequeued[0]!.snapshot.id,
  });
  expect(attempt.snapshot.executionStatus).toBe("EXECUTING");
  return run;
}

export async function describeLiveWatchers(
  store: WaitpointStoreCoordinator,
  waitpointId: string
): Promise<number> {
  const d = await store.describeWaitpoint(waitpointId);
  return d.outcome === "exists" ? d.liveWatchers : 0;
}

export async function captureAnchor(engine: RunEngine, runId: string): Promise<string> {
  const snapshot = await engine.runStore.findLatestExecutionSnapshot(runId);
  expect(snapshot, "run has no snapshot to capture a cycle anchor").not.toBeNull();
  return cycleAnchorSnapshotId(snapshot!);
}

export function blockStore(
  engine: RunEngine,
  args: {
    runId: string;
    projectId: string;
    organizationId: string;
    waitpoints: string[];
    blockOperation: {
      id: string;
      absorptionId?: string;
      cycleAnchor: string;
      expectedPreviousBlockId?: string;
    };
  }
) {
  return engine.blockRunWithWaitpoint({
    runId: args.runId,
    waitpoints: args.waitpoints,
    projectId: args.projectId,
    organizationId: args.organizationId,

    // Default the contribution id to the block id: one absorption per block, as most tests do.
    blockOperation: {
      ...args.blockOperation,
      absorptionId: args.blockOperation.absorptionId ?? args.blockOperation.id,
    },
  });
}
