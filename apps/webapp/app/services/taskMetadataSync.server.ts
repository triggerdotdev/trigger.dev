import { logger } from "./logger.server";
import { taskMetadataCacheInstance } from "./taskMetadataCacheInstance.server";
import type { TaskMetadataCache, TaskMetadataEntry } from "./taskMetadataCache.server";

export async function syncTaskMetadataCache(
  envId: string,
  workerId: string,
  isCurrent: boolean,
  entries: TaskMetadataEntry[],
  cache: TaskMetadataCache = taskMetadataCacheInstance
): Promise<void> {
  if (entries.length === 0) return;

  try {
    await cache.populateByWorker(workerId, entries);
    if (isCurrent) {
      await cache.populateCurrent(envId, entries);
    }
  } catch (error) {
    logger.error("Failed to sync task metadata cache", { envId, workerId, error });
  }
}
