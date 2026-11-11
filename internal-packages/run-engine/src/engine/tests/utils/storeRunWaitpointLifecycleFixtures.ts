import { trace } from "@internal/tracing";
import {
  type RedisSnapshotStore,
  PostgresRunStore,
  SnapshotResidencyResolver,
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreDial,
  type RunStore,
} from "@internal/run-store";
import { createRedisClient, type RedisOptions } from "@internal/redis";
import type { PrismaClient } from "@trigger.dev/database";
import { expect, vi } from "vitest";
import { RunEngine } from "../../index.js";
import { createCompletedWaitpointResolver } from "../../systems/completedWaitpointResolver.js";
import { StoreWaitpointCoordinator } from "../../waitpointCoordinator/storeWaitpointCoordinator.js";
import { WaitpointStoreCoordinator } from "../../waitpointCoordinator/storeCoordinator.js";
import type { setupAuthenticatedEnvironment } from "../setup.js";

export function makeRedisRunStore(
  prisma: PrismaClient,
  snapshotStore: RedisSnapshotStore,
  resolveDial: () => SnapshotStoreDial = () => "redis-only"
): TaskRunExecutionSnapshotStore {
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  return new TaskRunExecutionSnapshotStore(delegate, {
    store: snapshotStore,
    mode: "redis-only",
    resolveDial,
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
  opts: {
    store?: WaitpointStoreCoordinator;
    enabled?: boolean;
    isWaitpointStoreEnabled?: (
      organizationId: string,
      organizationFlags?: unknown
    ) => boolean | Promise<boolean>;
    snapshotStore: RedisSnapshotStore;
    recoveryDelayMs?: number;
    workerDisabled?: boolean;
    workerRedisOptions?: RedisOptions;
    finalizationGuardDelayMs?: number;
    resolveDial?: () => SnapshotStoreDial;
    coordinator?: StoreWaitpointCoordinator;
    runStore?: RunStore;
  }
) {
  return new RunEngine({
    prisma,
    completionGuardDelayMs: opts.recoveryDelayMs,
    finalizationGuardDelayMs: opts.finalizationGuardDelayMs,
    store: opts.runStore ?? makeRedisRunStore(prisma, opts.snapshotStore, opts.resolveDial),
    worker: {
      disabled: opts.workerDisabled,
      redis: opts.workerRedisOptions ?? redisOptions,
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
    waitpointStoreEnabled:
      opts.isWaitpointStoreEnabled ?? (opts.store ? () => opts.enabled ?? true : undefined),
    ...(opts.store
      ? {
          waitpointRouting: {
            store: opts.coordinator ?? new StoreWaitpointCoordinator({ store: opts.store }),
            mintPolicy: { resolveMintMode: () => "redis", isCapabilityReady: () => true },
          },
          waitpointStore: opts.store,
          waitpointFanoutStore: opts.store,
        }
      : {}),
  });
}

export async function triggerRun(
  engine: RunEngine,
  env: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>,
  prisma: PrismaClient,
  args: {
    friendlyId: string;
    taskIdentifier: string;
    parentTaskRunId?: string;
    batch?: { id: string; index?: number };
    resumeParentOnCompletion?: boolean;
    idempotencyKey?: string;
    oneTimeUseToken?: string;
    parkedOnExternalDeploymentId?: string;
    debounce?: { key: string; delay: string; mode?: "leading" | "trailing" };
    delayUntil?: Date;
    payload?: string;
    onDebounced?: Parameters<RunEngine["trigger"]>[0]["onDebounced"];
  }
) {
  return engine.trigger(
    {
      number: 1,
      friendlyId: args.friendlyId,
      environment: env,
      taskIdentifier: args.taskIdentifier,
      payload: args.payload ?? "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t_${args.friendlyId}`,
      spanId: `s_${args.friendlyId}`,
      workerQueue: "main",
      queue: `task/${args.taskIdentifier}`,
      isTest: false,
      tags: [],
      parentTaskRunId: args.parentTaskRunId,
      batch: args.batch,
      resumeParentOnCompletion: args.resumeParentOnCompletion,
      idempotencyKey: args.idempotencyKey,
      oneTimeUseToken: args.oneTimeUseToken,
      debounce: args.debounce,
      onDebounced: args.onDebounced,
      delayUntil: args.delayUntil,
      parkedOnExternalDeploymentId: args.parkedOnExternalDeploymentId,
      ...(args.parkedOnExternalDeploymentId
        ? {
            annotations: {
              externalDeploymentId: args.parkedOnExternalDeploymentId,
              triggerSource: "sdk",
              triggerAction: "trigger",
              rootTriggerSource: "sdk",
            },
          }
        : {}),
    },
    prisma
  );
}

export async function dequeueAndStart(engine: RunEngine, consumerId: string) {
  const dequeued = await vi.waitFor(
    async () => {
      const d = await engine.dequeueFromWorkerQueue({
        blockingPopTimeoutSeconds: 1,
        consumerId,
        workerQueue: "main",
      });
      expect(d.length, "Waitpoint condition never settled: d.length").toBe(1);
      return d;
    },
    { timeout: 10_000, interval: 100 }
  );
  return engine.startRunAttempt({
    runId: dequeued[0]!.run.id,
    snapshotId: dequeued[0]!.snapshot.id,
  });
}

// The waitpoint store has its own real Redis user, so failures cannot affect snapshot/queue clients.
export async function restrictedWaitpointStore(
  redisOptions: RedisOptions,
  terminalRetentionMs?: number
) {
  const admin = createRedisClient(redisOptions);
  const username = `waitpoint_${crypto.randomUUID().replaceAll("-", "")}`;
  const password = crypto.randomUUID();
  await admin.call("ACL", "SETUSER", username, "on", `>${password}`, "~*", "+@all");
  const client = createRedisClient({ ...redisOptions, username, password });
  const store = new WaitpointStoreCoordinator({ client, terminalRetentionMs });
  const close = async () => {
    try {
      await store.quit();
      await admin.call("ACL", "DELUSER", username);
    } finally {
      client.disconnect();
      admin.disconnect();
    }
  };
  return { store, admin, username, close };
}
