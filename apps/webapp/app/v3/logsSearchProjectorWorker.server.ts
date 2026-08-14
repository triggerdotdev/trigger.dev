import { Logger } from "@trigger.dev/core/logger";
import { CronSchema, Worker as RedisWorker } from "@trigger.dev/redis-worker";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { getLogsSearchProjector } from "~/services/logsSearchProjectorInstance.server";
import { singleton } from "~/utils/singleton";

function initializeWorker() {
  const worker = new RedisWorker({
    name: "logs-search-projector-worker",
    redisOptions: {
      keyPrefix: "logs-search-projector:worker:",
      host: env.COMMON_WORKER_REDIS_HOST,
      port: env.COMMON_WORKER_REDIS_PORT,
      username: env.COMMON_WORKER_REDIS_USERNAME,
      password: env.COMMON_WORKER_REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.COMMON_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    catalog: {
      "logsSearch.projectV2": {
        schema: CronSchema,
        cron: "* * * * *",
        jitterInMs: 5_000,
        visibilityTimeoutMs:
          env.LOGS_SEARCH_PROJECTOR_MAX_WINDOWS_PER_TICK *
            (env.LOGS_SEARCH_PROJECTOR_MAX_EXECUTION_TIME_SECONDS + 30) *
            1000 +
          60_000,
        retry: { maxAttempts: 1 },
      },
    },
    concurrency: { workers: 1, tasksPerWorker: 1, limit: 1 },
    pollIntervalMs: env.COMMON_WORKER_POLL_INTERVAL,
    immediatePollIntervalMs: env.COMMON_WORKER_IMMEDIATE_POLL_INTERVAL,
    shutdownTimeoutMs: env.COMMON_WORKER_SHUTDOWN_TIMEOUT_MS,
    logger: new Logger("LogsSearchProjectorWorker", env.COMMON_WORKER_LOG_LEVEL),
    jobs: {
      "logsSearch.projectV2": async () => {
        await getLogsSearchProjector().processTick();
      },
    },
  });

  return worker;
}

export const logsSearchProjectorWorker = singleton("logsSearchProjectorWorker", initializeWorker);

declare global {
  // eslint-disable-next-line no-var
  var __logsSearchProjectorWorkerStarted__: boolean | undefined;
}

export function initLogsSearchProjectorWorker(): void {
  if (
    !env.LOGS_SEARCH_PROJECTOR_ENABLED ||
    env.COMMON_WORKER_ENABLED !== "true" ||
    global.__logsSearchProjectorWorkerStarted__
  ) {
    return;
  }

  logger.info("Starting logs search projector worker");
  logsSearchProjectorWorker.start();
  global.__logsSearchProjectorWorkerStarted__ = true;
}
