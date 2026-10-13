import { singleton } from "~/utils/singleton";
import { env } from "~/env.server";
import { UpdateMetadataService } from "./updateMetadata.server";
import {
  FallbackMetadataOperationBuffer,
  InMemoryMetadataOperationBuffer,
  RedisMetadataOperationBuffer,
  type MetadataOperationBuffer,
} from "./operationBuffer.server";
import { prisma } from "~/db.server";
import { runStore } from "~/v3/runStore.server";
import { createRedisClient } from "~/redis.server";
import { logger } from "~/services/logger.server";
import { publishChangeRecord } from "~/services/realtime/runChangeNotifierInstance.server";

function createMetadataOperationBuffer(): MetadataOperationBuffer {
  const maxPendingOperationsPerRun = env.BATCH_METADATA_OPERATIONS_MAX_PENDING_PER_RUN;

  if (env.BATCH_METADATA_OPERATIONS_BUFFER_BACKEND !== "redis") {
    return new InMemoryMetadataOperationBuffer({ maxPendingOperationsPerRun });
  }

  logger.info("UpdateMetadataService: using the redis metadata operation buffer", {
    host: env.METADATA_BUFFER_REDIS_HOST,
    clusterMode: env.METADATA_BUFFER_REDIS_CLUSTER_MODE_ENABLED === "1",
  });

  const redis = createRedisClient("metadata-buffer", {
    host: env.METADATA_BUFFER_REDIS_HOST,
    port: env.METADATA_BUFFER_REDIS_PORT,
    username: env.METADATA_BUFFER_REDIS_USERNAME,
    password: env.METADATA_BUFFER_REDIS_PASSWORD,
    tlsDisabled: env.METADATA_BUFFER_REDIS_TLS_DISABLED === "true",
    clusterMode: env.METADATA_BUFFER_REDIS_CLUSTER_MODE_ENABLED === "1",
    maxRetriesPerRequest: 1,
  });

  return new FallbackMetadataOperationBuffer({
    primary: new RedisMetadataOperationBuffer({
      redis,
      flushDelayMs: env.BATCH_METADATA_OPERATIONS_FLUSH_INTERVAL_MS,
      lockTtlMs: env.METADATA_BUFFER_REDIS_LOCK_TTL_MS,
      maxPendingOperationsPerRun,
    }),
    fallback: new InMemoryMetadataOperationBuffer({ maxPendingOperationsPerRun }),
    onFallback: (action, error) => {
      logger.warn("UpdateMetadataService: redis metadata buffer unavailable, using memory", {
        action,
        error,
      });
    },
  });
}

export const updateMetadataService = singleton(
  "update-metadata-service",
  () =>
    new UpdateMetadataService({
      prisma,
      runStore,
      buffer: createMetadataOperationBuffer(),
      drainBatchSize: env.BATCH_METADATA_OPERATIONS_DRAIN_BATCH_SIZE,
      flushIntervalMs: env.BATCH_METADATA_OPERATIONS_FLUSH_INTERVAL_MS,
      flushEnabled: env.BATCH_METADATA_OPERATIONS_FLUSH_ENABLED === "1",
      flushLoggingEnabled: env.BATCH_METADATA_OPERATIONS_FLUSH_LOGGING_ENABLED === "1",
      maximumSize: env.TASK_RUN_METADATA_MAXIMUM_SIZE,
      logLevel: env.BATCH_METADATA_OPERATIONS_FLUSH_LOGGING_ENABLED === "1" ? "debug" : "info",
      // Buffered (parent/root) operations land via the flusher, not the caller's request —
      // publish here so those changes wake live feeds too (no-op when the backend is off).
      onRunFlushed: (run) => {
        publishChangeRecord({
          runId: run.runId,
          envId: run.environmentId,
          tags: run.tags,
          batchId: run.batchId,
          updatedAtMs: run.updatedAtMs,
        });
      },
    })
);
