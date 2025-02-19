import { RunEngine } from "@internal/run-engine";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { tracer } from "./tracer.server";
import { singleton } from "~/utils/singleton";
import { defaultMachine, machines } from "@trigger.dev/platform/v3";
import { allMachines } from "./machinePresets.server";

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
  });

  return engine;
}
