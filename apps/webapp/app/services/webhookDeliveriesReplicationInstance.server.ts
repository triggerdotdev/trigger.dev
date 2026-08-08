import invariant from "tiny-invariant";
import { env } from "~/env.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { singleton } from "~/utils/singleton";
import { meter, provider } from "~/v3/tracer.server";
import { WebhookDeliveriesReplicationService } from "./webhookDeliveriesReplicationService.server";
import { signalsEmitter } from "./signals.server";

export const webhookDeliveriesReplicationInstance = singleton(
  "webhookDeliveriesReplicationInstance",
  initializeWebhookDeliveriesReplicationInstance
);

function initializeWebhookDeliveriesReplicationInstance() {
  const { DATABASE_URL } = process.env;
  invariant(typeof DATABASE_URL === "string", "DATABASE_URL env var not set");

  if (!env.WEBHOOK_DELIVERIES_REPLICATION_CLICKHOUSE_URL) {
    console.log("🗃️  Webhook deliveries replication service not enabled");
    return;
  }

  console.log("🗃️  Webhook deliveries replication service enabled");

  const service = new WebhookDeliveriesReplicationService({
    clickhouseFactory,
    // Follows the webhook writer DB (where WebhookDelivery physically lives once split).
    pgConnectionUrl: env.WEBHOOK_DATABASE_URL ?? DATABASE_URL,
    serviceName: "webhook-deliveries-replication",
    slotName: env.WEBHOOK_DELIVERIES_REPLICATION_SLOT_NAME,
    publicationName: env.WEBHOOK_DELIVERIES_REPLICATION_PUBLICATION_NAME,
    // The source WebhookDelivery is a partitioned parent; without this the slot stays silent.
    publishViaPartitionRoot: true,
    redisOptions: {
      keyPrefix: "webhook-deliveries-replication:",
      port: env.RUN_REPLICATION_REDIS_PORT ?? undefined,
      host: env.RUN_REPLICATION_REDIS_HOST ?? undefined,
      username: env.RUN_REPLICATION_REDIS_USERNAME ?? undefined,
      password: env.RUN_REPLICATION_REDIS_PASSWORD ?? undefined,
      enableAutoPipelining: true,
      ...(env.RUN_REPLICATION_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    maxFlushConcurrency: env.WEBHOOK_DELIVERIES_REPLICATION_MAX_FLUSH_CONCURRENCY,
    flushIntervalMs: env.WEBHOOK_DELIVERIES_REPLICATION_FLUSH_INTERVAL_MS,
    flushBatchSize: env.WEBHOOK_DELIVERIES_REPLICATION_FLUSH_BATCH_SIZE,
    leaderLockTimeoutMs: env.WEBHOOK_DELIVERIES_REPLICATION_LEADER_LOCK_TIMEOUT_MS,
    leaderLockExtendIntervalMs: env.WEBHOOK_DELIVERIES_REPLICATION_LEADER_LOCK_EXTEND_INTERVAL_MS,
    leaderLockAcquireAdditionalTimeMs:
      env.WEBHOOK_DELIVERIES_REPLICATION_LEADER_LOCK_ADDITIONAL_TIME_MS,
    leaderLockRetryIntervalMs: env.WEBHOOK_DELIVERIES_REPLICATION_LEADER_LOCK_RETRY_INTERVAL_MS,
    ackIntervalSeconds: env.WEBHOOK_DELIVERIES_REPLICATION_ACK_INTERVAL_SECONDS,
    logLevel: env.WEBHOOK_DELIVERIES_REPLICATION_LOG_LEVEL,
    waitForAsyncInsert: env.WEBHOOK_DELIVERIES_REPLICATION_WAIT_FOR_ASYNC_INSERT === "1",
    tracer: provider.getTracer("webhook-deliveries-replication-service"),
    meter,
    insertMaxRetries: env.WEBHOOK_DELIVERIES_REPLICATION_INSERT_MAX_RETRIES,
    insertBaseDelayMs: env.WEBHOOK_DELIVERIES_REPLICATION_INSERT_BASE_DELAY_MS,
    insertMaxDelayMs: env.WEBHOOK_DELIVERIES_REPLICATION_INSERT_MAX_DELAY_MS,
    insertStrategy: env.WEBHOOK_DELIVERIES_REPLICATION_INSERT_STRATEGY,
  });

  if (env.WEBHOOK_DELIVERIES_REPLICATION_ENABLED === "1") {
    // Gate start() on the org data-stores registry being loaded. Starting earlier would
    // race the registry load — sync factory lookups would return `null` and route org-scoped
    // deliveries to the default ClickHouse, writing them to the wrong cluster.
    clickhouseFactory
      .isReady()
      .then(() => service.start())
      .then(() => {
        console.log("🗃️ Webhook deliveries replication service started");
      })
      .catch((error) => {
        console.error("🗃️ Webhook deliveries replication service failed to start", {
          error,
        });
      });

    // SIGTERM/SIGINT fire during process teardown; wrap the async shutdown so an
    // unhandled rejection doesn't bubble past process exit.
    const shutdownWebhookDeliveriesReplication = () => {
      service.shutdown().catch((error) => {
        console.error("🗃️ Webhook deliveries replication service shutdown error", {
          error,
        });
      });
    };
    signalsEmitter.on("SIGTERM", shutdownWebhookDeliveriesReplication);
    signalsEmitter.on("SIGINT", shutdownWebhookDeliveriesReplication);
  }

  return service;
}
