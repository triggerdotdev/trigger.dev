import { trace } from "@internal/tracing";
import { RunEngine } from "../../index.js";
import type { RunEngineOptions } from "../../types.js";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { type RedisOptions } from "@internal/redis";
import { PostgresRunStore } from "@internal/run-store";

import type { PrismaClient } from "@trigger.dev/database";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
} from "../../../../../run-store/src/testFixtures/snapshotIdFixture.js";

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
  return { runId, projectId: env.projectId, environmentId: env.id, client: prisma };
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
  });
}
