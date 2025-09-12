import { RunEngine } from "@internal/run-engine";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { defaultMachine, getCurrentPlan } from "~/services/platform.v3.server";
import { singleton } from "~/utils/singleton";
import { allMachines } from "./machinePresets.server";
import { meter, tracer } from "./tracer.server";

export const engine = singleton("RunEngine", createRunEngine);

export type { RunEngine };

function createRunEngine() {
  const engine = new RunEngine({
    prisma,
    readOnlyPrisma: $replica,
    logLevel: env.RUN_ENGINE_WORKER_LOG_LEVEL,
    treatProductionExecutionStallsAsOOM:
      env.RUN_ENGINE_TREAT_PRODUCTION_EXECUTION_STALLS_AS_OOM === "1",
    worker: {
      disabled: env.RUN_ENGINE_WORKER_ENABLED === "0",
      workers: env.RUN_ENGINE_WORKER_COUNT,
      tasksPerWorker: env.RUN_ENGINE_TASKS_PER_WORKER,
      pollIntervalMs: env.RUN_ENGINE_WORKER_POLL_INTERVAL,
      immediatePollIntervalMs: env.RUN_ENGINE_WORKER_IMMEDIATE_POLL_INTERVAL,
      limit: env.RUN_ENGINE_WORKER_CONCURRENCY_LIMIT,
      shutdownTimeoutMs: env.RUN_ENGINE_WORKER_SHUTDOWN_TIMEOUT_MS,
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
      defaultEnvConcurrencyBurstFactor: env.DEFAULT_ENV_EXECUTION_CONCURRENCY_BURST_FACTOR,
      logLevel: env.RUN_ENGINE_RUN_QUEUE_LOG_LEVEL,
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
      shardCount: env.RUN_ENGINE_RUN_QUEUE_SHARD_COUNT,
      processWorkerQueueDebounceMs: env.RUN_ENGINE_PROCESS_WORKER_QUEUE_DEBOUNCE_MS,
      dequeueBlockingTimeoutSeconds: env.RUN_ENGINE_DEQUEUE_BLOCKING_TIMEOUT_SECONDS,
      masterQueueConsumersIntervalMs: env.RUN_ENGINE_MASTER_QUEUE_CONSUMERS_INTERVAL_MS,
      masterQueueConsumersDisabled: env.RUN_ENGINE_WORKER_ENABLED === "0",
      masterQueueCooloffPeriodMs: env.RUN_ENGINE_MASTER_QUEUE_COOLOFF_PERIOD_MS,
      masterQueueCooloffCountThreshold: env.RUN_ENGINE_MASTER_QUEUE_COOLOFF_COUNT_THRESHOLD,
      masterQueueConsumerDequeueCount: env.RUN_ENGINE_MASTER_QUEUE_CONSUMER_DEQUEUE_COUNT,
      concurrencySweeper: {
        scanSchedule: env.RUN_ENGINE_CONCURRENCY_SWEEPER_SCAN_SCHEDULE,
        processMarkedSchedule: env.RUN_ENGINE_CONCURRENCY_SWEEPER_PROCESS_MARKED_SCHEDULE,
        scanJitterInMs: env.RUN_ENGINE_CONCURRENCY_SWEEPER_SCAN_JITTER_IN_MS,
        processMarkedJitterInMs: env.RUN_ENGINE_CONCURRENCY_SWEEPER_PROCESS_MARKED_JITTER_IN_MS,
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
      duration: env.RUN_ENGINE_RUN_LOCK_DURATION,
      automaticExtensionThreshold: env.RUN_ENGINE_RUN_LOCK_AUTOMATIC_EXTENSION_THRESHOLD,
      retryConfig: {
        maxAttempts: env.RUN_ENGINE_RUN_LOCK_MAX_RETRIES,
        baseDelay: env.RUN_ENGINE_RUN_LOCK_BASE_DELAY,
        maxDelay: env.RUN_ENGINE_RUN_LOCK_MAX_DELAY,
        backoffMultiplier: env.RUN_ENGINE_RUN_LOCK_BACKOFF_MULTIPLIER,
        jitterFactor: env.RUN_ENGINE_RUN_LOCK_JITTER_FACTOR,
        maxTotalWaitTime: env.RUN_ENGINE_RUN_LOCK_MAX_TOTAL_WAIT_TIME,
      },
    },
    tracer,
    meter,
    heartbeatTimeoutsMs: {
      PENDING_EXECUTING: env.RUN_ENGINE_TIMEOUT_PENDING_EXECUTING,
      PENDING_CANCEL: env.RUN_ENGINE_TIMEOUT_PENDING_CANCEL,
      EXECUTING: env.RUN_ENGINE_TIMEOUT_EXECUTING,
      EXECUTING_WITH_WAITPOINTS: env.RUN_ENGINE_TIMEOUT_EXECUTING_WITH_WAITPOINTS,
      SUSPENDED: env.RUN_ENGINE_TIMEOUT_SUSPENDED,
    },
    suspendedHeartbeatRetriesConfig: {
      maxCount: env.RUN_ENGINE_SUSPENDED_HEARTBEAT_RETRIES_MAX_COUNT,
      maxDelayMs: env.RUN_ENGINE_SUSPENDED_HEARTBEAT_RETRIES_MAX_DELAY_MS,
      initialDelayMs: env.RUN_ENGINE_SUSPENDED_HEARTBEAT_RETRIES_INITIAL_DELAY_MS,
      factor: env.RUN_ENGINE_SUSPENDED_HEARTBEAT_RETRIES_FACTOR,
    },
    retryWarmStartThresholdMs: env.RUN_ENGINE_RETRY_WARM_START_THRESHOLD_MS,
    billing: {
      getCurrentPlan: async (orgId: string) => {
        const plan = await getCurrentPlan(orgId);

        if (!plan) {
          return {
            isPaying: false,
            type: "free",
          };
        }

        if (!plan.v3Subscription) {
          return {
            isPaying: false,
            type: "free",
          };
        }

        return {
          isPaying: plan.v3Subscription.isPaying,
          type: plan.v3Subscription.plan?.type ?? "free",
        };
      },
    },
  });

  return engine;
}
