import { singleton } from "~/utils/singleton";
import { env } from "~/env.server";
import { UpdateMetadataService } from "./updateMetadata.server";
import { prisma } from "~/db.server";
import { publishChangeRecord } from "~/services/realtime/runChangeNotifierInstance.server";

export const updateMetadataService = singleton(
  "update-metadata-service",
  () =>
    new UpdateMetadataService({
      prisma,
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
