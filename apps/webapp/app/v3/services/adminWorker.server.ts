import { Logger } from "@trigger.dev/core/logger";
import { Worker as RedisWorker } from "@trigger.dev/redis-worker";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { runsReplicationInstance } from "~/services/runsReplicationInstance.server";
import { singleton } from "~/utils/singleton";
import { tracer } from "../tracer.server";
import { $replica } from "~/db.server";
import { RunsBackfillerService } from "../../services/runsBackfiller.server";

function initializeWorker() {
  const redisOptions = {
    keyPrefix: "admin:worker:",
    host: env.ADMIN_WORKER_REDIS_HOST,
    port: env.ADMIN_WORKER_REDIS_PORT,
    username: env.ADMIN_WORKER_REDIS_USERNAME,
    password: env.ADMIN_WORKER_REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.ADMIN_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  };

  logger.debug(`👨‍🏭 Initializing admin worker at host ${env.ADMIN_WORKER_REDIS_HOST}`);

  const worker = new RedisWorker({
    name: "admin-worker",
    redisOptions,
    catalog: {
      "admin.backfillRunsToReplication": {
        schema: z.object({
          from: z.coerce.date(),
          to: z.coerce.date(),
          cursor: z.string().optional(),
          batchSize: z.coerce.number().int().default(500),
          delayIntervalMs: z.coerce.number().int().default(1000),
        }),
        visibilityTimeoutMs: 60_000 * 15, // 15 minutes
        retry: {
          maxAttempts: 5,
        },
      },
    },
    concurrency: {
      workers: env.ADMIN_WORKER_CONCURRENCY_WORKERS,
      tasksPerWorker: env.ADMIN_WORKER_CONCURRENCY_TASKS_PER_WORKER,
      limit: env.ADMIN_WORKER_CONCURRENCY_LIMIT,
    },
    pollIntervalMs: env.ADMIN_WORKER_POLL_INTERVAL,
    immediatePollIntervalMs: env.ADMIN_WORKER_IMMEDIATE_POLL_INTERVAL,
    shutdownTimeoutMs: env.ADMIN_WORKER_SHUTDOWN_TIMEOUT_MS,
    logger: new Logger("AdminWorker", env.ADMIN_WORKER_LOG_LEVEL),
    jobs: {
      "admin.backfillRunsToReplication": async ({ payload, id }) => {
        if (!runsReplicationInstance) {
          logger.error("Runs replication instance not found");
          return;
        }

        const service = new RunsBackfillerService({
          prisma: $replica,
          runsReplicationInstance: runsReplicationInstance,
          tracer: tracer,
        });

        const cursor = await service.call({
          from: payload.from,
          to: payload.to,
          cursor: payload.cursor,
          batchSize: payload.batchSize,
        });

        if (cursor) {
          await worker.enqueue({
            job: "admin.backfillRunsToReplication",
            payload: {
              from: payload.from,
              to: payload.to,
              cursor,
              batchSize: payload.batchSize,
              delayIntervalMs: payload.delayIntervalMs,
            },
            id,
            availableAt: new Date(Date.now() + payload.delayIntervalMs),
            cancellationKey: id,
          });
        }
      },
    },
  });

  if (env.ADMIN_WORKER_ENABLED === "true") {
    logger.debug(
      `👨‍🏭 Starting admin worker at host ${env.ADMIN_WORKER_REDIS_HOST}, pollInterval = ${env.ADMIN_WORKER_POLL_INTERVAL}, immediatePollInterval = ${env.ADMIN_WORKER_IMMEDIATE_POLL_INTERVAL}, workers = ${env.ADMIN_WORKER_CONCURRENCY_WORKERS}, tasksPerWorker = ${env.ADMIN_WORKER_CONCURRENCY_TASKS_PER_WORKER}, concurrencyLimit = ${env.ADMIN_WORKER_CONCURRENCY_LIMIT}`
    );

    worker.start();
  }

  return worker;
}

export const adminWorker = singleton("adminWorker", initializeWorker);
