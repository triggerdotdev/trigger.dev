import { singleton } from "~/utils/singleton";
import { env } from "~/env.server";
import { UpdateMetadataService } from "./updateMetadata.server";
import { prisma } from "~/db.server";

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
    })
);
