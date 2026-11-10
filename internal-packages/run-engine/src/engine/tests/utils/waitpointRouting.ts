import { trace } from "@internal/tracing";
import { RunEngine } from "../../index.js";
import type { RunEngineOptions } from "../../types.js";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { PostgresRunStore } from "@internal/run-store";
import { Logger } from "@trigger.dev/core/logger";
import type { PrismaClient } from "@trigger.dev/database";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
} from "../../../../../run-store/src/testFixtures/snapshotIdFixture.js";
import { LegacyPostgresWaitpointCoordinator } from "../../waitpointCoordinator/legacyPostgresCoordinator.js";
import {
  RoutingWaitpointCoordinator,
  type RoutingWaitpointCoordinatorOptions,
} from "../../waitpointCoordinator/routingCoordinator.js";
import { StoreWaitpointCoordinator } from "../../waitpointCoordinator/storeWaitpointCoordinator.js";
import type { WaitpointStoreCoordinator } from "../../waitpointCoordinator/storeCoordinator.js";

export function routing(
  prisma: PrismaClient,
  store?: WaitpointStoreCoordinator,
  options: Partial<RoutingWaitpointCoordinatorOptions> = {}
) {
  const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  return new RoutingWaitpointCoordinator({
    legacy: new LegacyPostgresWaitpointCoordinator({
      runStore: () => runStore,
      prisma,
      logger: new Logger("routingCoordinator.store.test", "error"),
    }),
    store: store ? new StoreWaitpointCoordinator({ store }) : undefined,
    mintPolicy: { resolveMintMode: () => "redis", isCapabilityReady: () => true },
    ...options,
  });
}

export async function keys(redisOptions: RedisOptions, pattern = "wp:v1:*") {
  const redis = createRedisClient(redisOptions);
  try {
    return (await redis.keys(pattern)).sort();
  } finally {
    await redis.quit();
  }
}

export async function context(prisma: PrismaClient) {
  const env = await seedSnapshotEnvironment(prisma);
  return {
    projectId: env.projectId,
    environmentId: env.id,
    completedAfter: new Date(Date.now() + 60_000),
    mintContext: { organizationId: env.organizationId, parentResidency: "redis-primary" as const },
  };
}

export async function parent(prisma: PrismaClient) {
  const env = await seedSnapshotEnvironment(prisma);
  const runId = generateInternalId();
  const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  await runStore.createRun({
    data: buildCreateRunData(runId, env),
    snapshot: {
      id: generateInternalId(),
      createdAt: new Date(),
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "created",
      runStatus: "PENDING",
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    },
  });
  return {
    runId,
    organizationId: env.organizationId,
    projectId: env.projectId,
    environmentId: env.id,
    client: prisma,
  };
}

export async function blockers(prisma: PrismaClient, store: WaitpointStoreCoordinator) {
  const args = await parent(prisma);
  const legacy = await routing(prisma).createDateTimeWaitpoint({
    ...args,
    completedAfter: new Date(),
  });
  const stored = await new StoreWaitpointCoordinator({ store }).createDateTimeWaitpoint({
    ...args,
    completedAfter: new Date(),
  });
  return { args, legacyId: legacy.waitpoint.id, storeId: stored.waitpoint.id };
}

export async function seedMixed(prisma: PrismaClient, store: WaitpointStoreCoordinator) {
  const fixture = await blockers(prisma, store);
  await routing(prisma).registerBlocks({ ...fixture.args, waitpointIds: [fixture.legacyId] });
  await store.absorbBlockers({
    runId: fixture.args.runId,
    blockId: "block",
    edges: [
      { waitpointId: fixture.storeId, type: "DATETIME", createdAt: new Date().toISOString() },
    ],
  });
  return fixture;
}

// Access the existing real client for fixture markers and durable publication; no method is replaced.
export function coordinatorRedis(store: WaitpointStoreCoordinator): Redis {
  return (store as unknown as { redis: Redis }).redis;
}

export function routingEngine(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  extra: Partial<RunEngineOptions> = {}
) {
  return new RunEngine({
    prisma,
    worker: {
      redis: redisOptions,
      disabled: true,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: { redis: redisOptions },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: { "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("waitpoint-system-routing", "test"),
    logLevel: "error",
    ...extra,
    waitpointRouting: {
      store: extra.waitpointStore
        ? new StoreWaitpointCoordinator({
            store: extra.waitpointStore as WaitpointStoreCoordinator,
          })
        : undefined,
      ...extra.waitpointRouting,
    },
  });
}
