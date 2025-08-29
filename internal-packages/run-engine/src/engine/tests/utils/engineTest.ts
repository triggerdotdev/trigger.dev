import { TaskContext, test, TestAPI } from "vitest";
import {
  logCleanup,
  network,
  postgresContainer,
  prisma,
  redisContainer,
  redisOptions,
  StartedNetwork,
  StartedPostgreSqlContainer,
  StartedRedisContainer,
  type PostgresAndRedisContext,
} from "@internal/testcontainers";
import { RunEngine } from "../../index.js";
import { PrismaClient } from "@trigger.dev/database";
import { RedisOptions } from "@internal/redis";
import { trace } from "@internal/tracing";
import { RunEngineOptions } from "../../types.js";

type Use<T> = (value: T) => Promise<void>;

type EngineOptions = {
  worker?: {
    workers?: number;
    tasksPerWorker?: number;
    pollIntervalMs?: number;
  };
  queue?: {
    processWorkerQueueDebounceMs?: number;
    masterQueueConsumersDisabled?: boolean;
  };
  machines?: {
    defaultMachine?: RunEngineOptions["machines"]["defaultMachine"];
    machines?: RunEngineOptions["machines"]["machines"];
    baseCostInCents?: number;
  };
};

const engineOptions = async ({}: TaskContext, use: Use<EngineOptions>) => {
  const options: EngineOptions = {
    worker: {
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      processWorkerQueueDebounceMs: 50,
      masterQueueConsumersDisabled: true,
    },
    machines: {
      defaultMachine: "small-1x",
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
  };

  await use(options);
};

const engine = async (
  {
    engineOptions,
    task,
    redisOptions,
    prisma,
  }: {
    engineOptions: EngineOptions;
    redisOptions: RedisOptions;
    prisma: PrismaClient;
  } & TaskContext,
  use: Use<RunEngine>
) => {
  const engine = new RunEngine({
    prisma,
    worker: {
      redis: redisOptions,
      workers: engineOptions.worker?.workers ?? 1,
      tasksPerWorker: engineOptions.worker?.tasksPerWorker ?? 10,
      pollIntervalMs: engineOptions.worker?.pollIntervalMs ?? 100,
    },
    queue: {
      redis: redisOptions,
      processWorkerQueueDebounceMs: engineOptions.queue?.processWorkerQueueDebounceMs ?? 50,
      masterQueueConsumersDisabled: engineOptions.queue?.masterQueueConsumersDisabled ?? true,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: engineOptions.machines?.defaultMachine ?? ("small-1x" as const),
      machines: engineOptions.machines?.machines ?? {},
      baseCostInCents: engineOptions.machines?.baseCostInCents ?? 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });

  const testName = task.name;

  try {
    await use(engine);
  } finally {
    await logCleanup("engine", engine.quit(), { testName });
  }
};

export type EngineContext = PostgresAndRedisContext & {
  engineOptions: EngineOptions;
  engine: RunEngine;
};

export const engineTest: TestAPI<{
  redisOptions: RedisOptions;
  prisma: PrismaClient;
  engineOptions: EngineOptions;
  engine: RunEngine;
  network: StartedNetwork;
  postgresContainer: StartedPostgreSqlContainer;
  redisContainer: StartedRedisContainer;
}> = test.extend<EngineContext>({
  network,
  postgresContainer,
  prisma,
  redisContainer,
  redisOptions,
  engineOptions,
  engine,
});
