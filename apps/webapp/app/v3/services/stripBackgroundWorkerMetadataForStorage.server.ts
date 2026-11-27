import type { BackgroundWorkerMetadata } from "@trigger.dev/core/v3";
import type { Prisma } from "@trigger.dev/database";

/**
 * Strip BackgroundWorkerMetadata down to the slice that's actually read after
 * storage. Everything else is duplicated to dedicated columns/tables
 * (BackgroundWorker.{contentHash,cliVersion,sdkVersion,runtime,runtimeVersion},
 * BackgroundWorkerTask, BackgroundWorkerFile, TaskQueue, Prompt). Today the
 * only post-write reader is changeCurrentDeployment.server.ts, which feeds
 * tasks[].schedule into syncDeclarativeSchedules and webhookEndpoints +
 * webhookSubscribers into syncDeclarativeWebhooks. packageVersion, contentHash,
 * and tasks[].filePath are kept solely to satisfy BackgroundWorkerMetadata's
 * required fields when the column is parsed back. warmupCommand is read by the
 * template prebuild (templatePrebuild.server.ts). machines is read by the CLI,
 * which builds their images (api.v1.deployments.$deploymentId.ts).
 */
export function stripBackgroundWorkerMetadataForStorage(
  metadata: BackgroundWorkerMetadata
): Prisma.InputJsonValue {
  return {
    packageVersion: metadata.packageVersion,
    contentHash: metadata.contentHash,
    tasks: metadata.tasks
      .filter((t) => t.schedule)
      .map((t) => ({
        id: t.id,
        filePath: t.filePath,
        schedule: t.schedule,
      })),
    webhookEndpoints: metadata.webhookEndpoints as unknown as Prisma.InputJsonValue[] | undefined,
    webhookSubscribers: metadata.webhookSubscribers as unknown as
      | Prisma.InputJsonValue[]
      | undefined,
    warmupCommand: metadata.warmupCommand,
    machines: metadata.machines,
  };
}
