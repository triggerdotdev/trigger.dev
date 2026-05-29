import invariant from "tiny-invariant";
import { env } from "~/env.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { singleton } from "~/utils/singleton";
import { meter, provider } from "~/v3/tracer.server";
import { SessionsReplicationService } from "./sessionsReplicationService.server";
import { signalsEmitter } from "./signals.server";

export const sessionsReplicationInstance = singleton(
  "sessionsReplicationInstance",
  initializeSessionsReplicationInstance
);

function initializeSessionsReplicationInstance() {
  const { DATABASE_URL } = process.env;
  invariant(typeof DATABASE_URL === "string", "DATABASE_URL env var not set");

  if (!env.SESSION_REPLICATION_CLICKHOUSE_URL) {
    console.log("🗃️  Sessions replication service not enabled");
    return;
  }

  console.log("🗃️  Sessions replication service enabled");

  const service = new SessionsReplicationService({
    clickhouseFactory,
    pgConnectionUrl: DATABASE_URL,
    serviceName: "sessions-replication",
    slotName: env.SESSION_REPLICATION_SLOT_NAME,
    publicationName: env.SESSION_REPLICATION_PUBLICATION_NAME,
    redisOptions: {
      keyPrefix: "sessions-replication:",
      port: env.RUN_REPLICATION_REDIS_PORT ?? undefined,
      host: env.RUN_REPLICATION_REDIS_HOST ?? undefined,
      username: env.RUN_REPLICATION_REDIS_USERNAME ?? undefined,
      password: env.RUN_REPLICATION_REDIS_PASSWORD ?? undefined,
      enableAutoPipelining: true,
      ...(env.RUN_REPLICATION_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    maxFlushConcurrency: env.SESSION_REPLICATION_MAX_FLUSH_CONCURRENCY,
    flushIntervalMs: env.SESSION_REPLICATION_FLUSH_INTERVAL_MS,
    flushBatchSize: env.SESSION_REPLICATION_FLUSH_BATCH_SIZE,
    leaderLockTimeoutMs: env.SESSION_REPLICATION_LEADER_LOCK_TIMEOUT_MS,
    leaderLockExtendIntervalMs: env.SESSION_REPLICATION_LEADER_LOCK_EXTEND_INTERVAL_MS,
    leaderLockAcquireAdditionalTimeMs: env.SESSION_REPLICATION_LEADER_LOCK_ADDITIONAL_TIME_MS,
    leaderLockRetryIntervalMs: env.SESSION_REPLICATION_LEADER_LOCK_RETRY_INTERVAL_MS,
    ackIntervalSeconds: env.SESSION_REPLICATION_ACK_INTERVAL_SECONDS,
    logLevel: env.SESSION_REPLICATION_LOG_LEVEL,
    waitForAsyncInsert: env.SESSION_REPLICATION_WAIT_FOR_ASYNC_INSERT === "1",
    tracer: provider.getTracer("sessions-replication-service"),
    meter,
    insertMaxRetries: env.SESSION_REPLICATION_INSERT_MAX_RETRIES,
    insertBaseDelayMs: env.SESSION_REPLICATION_INSERT_BASE_DELAY_MS,
    insertMaxDelayMs: env.SESSION_REPLICATION_INSERT_MAX_DELAY_MS,
    insertStrategy: env.SESSION_REPLICATION_INSERT_STRATEGY,
  });

  if (env.SESSION_REPLICATION_ENABLED === "1") {
    // Gate start() on the org data-stores registry being loaded. Starting earlier would
    // race the registry load — sync factory lookups would return `null` and route org-scoped
    // sessions to the default ClickHouse, writing them to the wrong cluster.
    clickhouseFactory
      .isReady()
      .then(() => service.start())
      .then(() => {
        console.log("🗃️ Sessions replication service started");
      })
      .catch((error) => {
        console.error("🗃️ Sessions replication service failed to start", {
          error,
        });
      });

    // SIGTERM/SIGINT fire during process teardown; wrap the async shutdown so an
    // unhandled rejection doesn't bubble past process exit.
    const shutdownSessionsReplication = () => {
      service.shutdown().catch((error) => {
        console.error("🗃️ Sessions replication service shutdown error", {
          error,
        });
      });
    };
    signalsEmitter.on("SIGTERM", shutdownSessionsReplication);
    signalsEmitter.on("SIGINT", shutdownSessionsReplication);
  }

  return service;
}
