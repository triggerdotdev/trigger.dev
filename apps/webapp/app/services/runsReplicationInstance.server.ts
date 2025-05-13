import { ClickHouse } from "@internal/clickhouse";
import { RunsReplicationService } from "./runsReplicationService.server";
import { singleton } from "~/utils/singleton";
import invariant from "tiny-invariant";
import { env } from "~/env.server";
import { metricsRegister } from "~/metrics.server";
import { logger } from "./logger.server";

export const runsReplicationInstance = singleton(
  "runsReplicationInstance",
  initializeRunsReplicationInstance
);

function initializeRunsReplicationInstance() {
  const { DATABASE_URL } = process.env;
  invariant(typeof DATABASE_URL === "string", "DATABASE_URL env var not set");

  if (!env.RUN_REPLICATION_CLICKHOUSE_URL) {
    logger.info("🗃️ Runs replication service not enabled");
    return;
  }

  const clickhouse = new ClickHouse({
    url: env.RUN_REPLICATION_CLICKHOUSE_URL,
    name: "runs-replication",
  });

  const service = new RunsReplicationService({
    clickhouse: clickhouse,
    pgConnectionUrl: DATABASE_URL,
    serviceName: "runs-replication",
    slotName: env.RUN_REPLICATION_SLOT_NAME,
    publicationName: env.RUN_REPLICATION_PUBLICATION_NAME,
    redisOptions: {
      keyPrefix: "runs-replication:",
      port: env.RUN_REPLICATION_REDIS_PORT ?? undefined,
      host: env.RUN_REPLICATION_REDIS_HOST ?? undefined,
      username: env.RUN_REPLICATION_REDIS_USERNAME ?? undefined,
      password: env.RUN_REPLICATION_REDIS_PASSWORD ?? undefined,
      enableAutoPipelining: true,
      ...(env.RUN_REPLICATION_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    maxFlushConcurrency: env.RUN_REPLICATION_MAX_FLUSH_CONCURRENCY,
    flushIntervalMs: env.RUN_REPLICATION_FLUSH_INTERVAL_MS,
    flushBatchSize: env.RUN_REPLICATION_FLUSH_BATCH_SIZE,
    leaderLockTimeoutMs: env.RUN_REPLICATION_LEADER_LOCK_TIMEOUT_MS,
    leaderLockExtendIntervalMs: env.RUN_REPLICATION_LEADER_LOCK_EXTEND_INTERVAL_MS,
    leaderLockRetryCount: env.RUN_REPLICATION_LEADER_LOCK_RETRY_COUNT,
    leaderLockRetryIntervalMs: env.RUN_REPLICATION_LEADER_LOCK_RETRY_INTERVAL_MS,
    ackIntervalSeconds: env.RUN_REPLICATION_ACK_INTERVAL_SECONDS,
    logLevel: env.RUN_REPLICATION_LOG_LEVEL,
  });

  if (env.RUN_REPLICATION_ENABLED === "1") {
    service
      .start()
      .then(() => {
        logger.info("🗃️ Runs replication service started");
      })
      .catch((error) => {
        logger.error("🗃️ Runs replication service failed to start", {
          error,
        });
      });

    process.on("SIGTERM", service.shutdown.bind(service));
    process.on("SIGINT", service.shutdown.bind(service));
  }

  return service;
}
