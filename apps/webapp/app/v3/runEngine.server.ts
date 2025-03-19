import { RunEngine } from "@internal/run-engine";
import { defaultMachine } from "@trigger.dev/platform/v3";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { allMachines } from "./machinePresets.server";
import { tracer } from "./tracer.server";

export const engine = singleton("RunEngine", createRunEngine);

export type { RunEngine };

function createRunEngine() {
  const engine = new RunEngine({
    prisma,
    worker: {
      workers: env.RUN_ENGINE_WORKER_COUNT,
      tasksPerWorker: env.RUN_ENGINE_TASKS_PER_WORKER,
      pollIntervalMs: env.RUN_ENGINE_WORKER_POLL_INTERVAL,
      redis: {
        keyPrefix: "engine:",
        port: env.RUN_ENGINE_WORKER_REDIS_PORT ?? undefined,
        host: env.RUN_ENGINE_WORKER_REDIS_HOST ?? undefined,
        username: env.RUN_ENGINE_WORKER_REDIS_USERNAME ?? undefined,
        password: env.RUN_ENGINE_WORKER_REDIS_PASSWORD ?? undefined,
        enableAutoPipelining: true,
        ...(env.RUN_ENGINE_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      },
    },
    machines: {
      defaultMachine,
      machines: allMachines(),
      baseCostInCents: env.CENTS_PER_RUN,
    },
    queue: {
      defaultEnvConcurrency: env.DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT,
      redis: {
        keyPrefix: "engine:",
        port: env.RUN_ENGINE_RUN_QUEUE_REDIS_PORT ?? undefined,
        host: env.RUN_ENGINE_RUN_QUEUE_REDIS_HOST ?? undefined,
        username: env.RUN_ENGINE_RUN_QUEUE_REDIS_USERNAME ?? undefined,
        password: env.RUN_ENGINE_RUN_QUEUE_REDIS_PASSWORD ?? undefined,
        enableAutoPipelining: true,
        ...(env.RUN_ENGINE_RUN_QUEUE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      },
      queueSelectionStrategyOptions: {
        parentQueueLimit: env.RUN_ENGINE_PARENT_QUEUE_LIMIT,
        biases: {
          concurrencyLimitBias: env.RUN_ENGINE_CONCURRENCY_LIMIT_BIAS,
          availableCapacityBias: env.RUN_ENGINE_AVAILABLE_CAPACITY_BIAS,
          queueAgeRandomization: env.RUN_ENGINE_QUEUE_AGE_RANDOMIZATION_BIAS,
        },
        reuseSnapshotCount: env.RUN_ENGINE_REUSE_SNAPSHOT_COUNT,
        maximumEnvCount: env.RUN_ENGINE_MAXIMUM_ENV_COUNT,
        tracer,
      },
    },
    runLock: {
      redis: {
        keyPrefix: "engine:",
        port: env.RUN_ENGINE_RUN_LOCK_REDIS_PORT ?? undefined,
        host: env.RUN_ENGINE_RUN_LOCK_REDIS_HOST ?? undefined,
        username: env.RUN_ENGINE_RUN_LOCK_REDIS_USERNAME ?? undefined,
        password: env.RUN_ENGINE_RUN_LOCK_REDIS_PASSWORD ?? undefined,
        enableAutoPipelining: true,
        ...(env.RUN_ENGINE_RUN_LOCK_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      },
    },
    tracer,
    heartbeatTimeoutsMs: {
      PENDING_EXECUTING: env.RUN_ENGINE_TIMEOUT_PENDING_EXECUTING,
      PENDING_CANCEL: env.RUN_ENGINE_TIMEOUT_PENDING_CANCEL,
      EXECUTING: env.RUN_ENGINE_TIMEOUT_EXECUTING,
      EXECUTING_WITH_WAITPOINTS: env.RUN_ENGINE_TIMEOUT_EXECUTING_WITH_WAITPOINTS,
    },
    releaseConcurrency: {
      disabled: env.RUN_ENGINE_RELEASE_CONCURRENCY_ENABLED === "0",
      maxTokensRatio: env.RUN_ENGINE_RELEASE_CONCURRENCY_MAX_TOKENS_RATIO,
      maxRetries: env.RUN_ENGINE_RELEASE_CONCURRENCY_MAX_RETRIES,
      consumersCount: env.RUN_ENGINE_RELEASE_CONCURRENCY_CONSUMERS_COUNT,
      pollInterval: env.RUN_ENGINE_RELEASE_CONCURRENCY_POLL_INTERVAL,
      batchSize: env.RUN_ENGINE_RELEASE_CONCURRENCY_BATCH_SIZE,
      redis: {
        keyPrefix: "engine:",
        port: env.RUN_ENGINE_RUN_QUEUE_REDIS_PORT ?? undefined,
        host: env.RUN_ENGINE_RUN_QUEUE_REDIS_HOST ?? undefined,
        username: env.RUN_ENGINE_RUN_QUEUE_REDIS_USERNAME ?? undefined,
        password: env.RUN_ENGINE_RUN_QUEUE_REDIS_PASSWORD ?? undefined,
        enableAutoPipelining: true,
        ...(env.RUN_ENGINE_RUN_QUEUE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      },
    },
  });

  return engine;
}
