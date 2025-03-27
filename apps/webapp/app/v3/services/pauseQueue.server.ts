import { QueueItem, type RetrieveQueueParam } from "@trigger.dev/core/v3";
import { getQueue, toQueueItem } from "~/presenters/v3/QueueRetrievePresenter.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { BaseService } from "./baseService.server";
import { determineEngineVersion } from "../engineVersion.server";
import { removeQueueConcurrencyLimits, updateQueueConcurrencyLimits } from "../runQueue.server";
import { engine } from "../runEngine.server";

export type PauseStatus = "paused" | "resumed";

export type PauseQueueResult =
  | {
      success: true;
      state: PauseStatus;
      queue: QueueItem;
    }
  | {
      success: false;
      code: "queue-not-found" | "unknown-error" | "engine-version";
      error?: string;
    };

export class PauseQueueService extends BaseService {
  public async call(
    environment: AuthenticatedEnvironment,
    queueInput: RetrieveQueueParam,
    action: PauseStatus
  ): Promise<PauseQueueResult> {
    try {
      //check the engine is the correct version
      const engineVersion = await determineEngineVersion({ environment });

      if (engineVersion === "V1") {
        return {
          success: false as const,
          code: "engine-version",
          error: "Upgrade to v4+ to pause/resume queues",
        };
      }

      const queue = await getQueue(this._prisma, environment, queueInput);

      if (!queue) {
        return {
          success: false,
          code: "queue-not-found",
        };
      }

      const updatedQueue = await this._prisma.taskQueue.update({
        where: {
          id: queue.id,
        },
        data: {
          paused: action === "paused",
        },
      });

      if (action === "paused") {
        await updateQueueConcurrencyLimits(environment, queue.name, 0);
      } else {
        if (queue.concurrencyLimit) {
          await updateQueueConcurrencyLimits(environment, queue.name, queue.concurrencyLimit);
        } else {
          await removeQueueConcurrencyLimits(environment, queue.name);
        }
      }

      logger.debug("PauseQueueService: queue state updated", {
        queueId: queue.id,
        action,
        environmentId: environment.id,
      });

      const results = await Promise.all([
        engine.lengthOfQueues(environment, [queue.name]),
        engine.currentConcurrencyOfQueues(environment, [queue.name]),
      ]);

      return {
        success: true,
        state: action,
        queue: toQueueItem({
          friendlyId: updatedQueue.friendlyId,
          name: updatedQueue.name,
          type: updatedQueue.type,
          running: results[1]?.[updatedQueue.name] ?? 0,
          queued: results[0]?.[updatedQueue.name] ?? 0,
          concurrencyLimit: updatedQueue.concurrencyLimit ?? null,
          paused: updatedQueue.paused,
          releaseConcurrencyOnWaitpoint: updatedQueue.releaseConcurrencyOnWaitpoint,
        }),
      };
    } catch (error) {
      logger.error("PauseQueueService: error updating queue state", {
        error,
        environmentId: environment.id,
      });

      return {
        success: false,
        code: "unknown-error",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
