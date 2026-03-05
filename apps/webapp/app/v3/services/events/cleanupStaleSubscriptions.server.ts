import { logger } from "~/services/logger.server";
import { BaseService } from "../baseService.server";

/**
 * Cleans up stale EventSubscriptions — disabled subscriptions whose associated
 * task no longer exists in any active worker for that environment.
 */
export class CleanupStaleSubscriptionsService extends BaseService {

  async call(): Promise<{ deletedCount: number; scannedCount: number }> {
    // Find all disabled subscriptions
    const disabledSubscriptions = await this._prisma.eventSubscription.findMany({
      where: { enabled: false },
      select: {
        id: true,
        taskSlug: true,
        projectId: true,
        environmentId: true,
      },
    });

    if (disabledSubscriptions.length === 0) {
      return { deletedCount: 0, scannedCount: 0 };
    }

    // For each disabled subscription, check if ANY active worker still has that task
    const idsToDelete: string[] = [];

    for (const sub of disabledSubscriptions) {
      const taskExists = await this._prisma.backgroundWorkerTask.findFirst({
        where: {
          slug: sub.taskSlug,
          projectId: sub.projectId,
          runtimeEnvironmentId: sub.environmentId,
        },
        select: { id: true },
      });

      if (!taskExists) {
        idsToDelete.push(sub.id);
      }
    }

    if (idsToDelete.length > 0) {
      await this._prisma.eventSubscription.deleteMany({
        where: { id: { in: idsToDelete } },
      });
    }

    logger.info("Cleaned up stale event subscriptions", {
      deletedCount: idsToDelete.length,
      scannedCount: disabledSubscriptions.length,
    });

    return { deletedCount: idsToDelete.length, scannedCount: disabledSubscriptions.length };
  }
}
