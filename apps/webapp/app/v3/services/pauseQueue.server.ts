import { type QueueItem, type RetrieveQueueParam } from "@trigger.dev/core/v3";
import { type TaskQueueRole } from "@trigger.dev/database";
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
  /**
   * Pause applies to named concurrency limits as well as queues, and the engine
   * writes below are identical for both roles, but LIMIT rows resolve only for
   * callers that opt in via `opts.roles` (the dashboard's limit rows submit the
   * shared actions). The public queues pause endpoint passes no roles and keeps
   * its queue-only contract.
   */
  public async call(
    environment: AuthenticatedEnvironment,
    queueInput: RetrieveQueueParam,
    action: PauseStatus,
    opts?: { roles?: TaskQueueRole[] }
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

      const queue = await getQueue(this._prisma, environment, queueInput, {
        roles: opts?.roles ?? ["QUEUE"],
      });

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

      /**
       * Resume syncs from the row the update returned, never the pre-update
       * snapshot, so a limit changed by a concurrent deploy is not resurrected.
       * A declared limit of zero is a real limit and must be written, not removed.
       * On failure the pause state is already persisted, so the engine is
       * converged from the fresh row best-effort BEFORE the failure surfaces,
       * mirroring the limits system's failure compensation; otherwise an error
       * response would strand a persisted pause unenforced.
       */
      try {
        if (action === "paused") {
          await updateQueueConcurrencyLimits(environment, queue.name, 0);
        } else {
          if (typeof updatedQueue.concurrencyLimit === "number") {
            await updateQueueConcurrencyLimits(
              environment,
              queue.name,
              updatedQueue.concurrencyLimit
            );
          } else {
            await removeQueueConcurrencyLimits(environment, queue.name);
          }
        }
      } catch (error) {
        try {
          await this.resyncPerKeyFromFreshRow(environment, queue.id);
        } catch (resyncError) {
          logger.error("PauseQueueService: re-sync after a failed engine write failed", {
            queueId: queue.id,
            environmentId: environment.id,
            error: resyncError,
          });
        }
        throw error;
      }

      /**
       * Freshness re-check, mirroring the concurrency systems' fresh-row heals:
       * a concurrent mutation (the opposite pause action, an override or reset,
       * a deploy) can commit between this action's persist and the landing of
       * its engine write, leaving the engine holding this action's value while
       * the row says otherwise. Re-syncing pause-aware from fresh reads until
       * the row holds still converges; failures are only logged, because this
       * action's own writes succeeded and the next sync or deploy retries.
       */
      try {
        await this.resyncPerKeyFromFreshRow(environment, queue.id, {
          perKey: updatedQueue.concurrencyLimit,
          paused: updatedQueue.paused,
        });
      } catch (error) {
        logger.error("PauseQueueService: freshness re-check failed", {
          queueId: queue.id,
          environmentId: environment.id,
          error,
        });
      }

      logger.debug("PauseQueueService: queue state updated", {
        queueId: queue.id,
        action,
        environmentId: environment.id,
      });

      /**
       * A LIMIT row is a gate, so its per-queue length and concurrency keys are
       * always empty; its live counts come from the gate machinery (holders
       * across every key + per-gate queued), the same sources the
       * concurrency-limits surfaces read.
       */
      const [queuedByName, runningByName] =
        queue.role === "LIMIT"
          ? await Promise.all([
              engine.gateQueuedCountOfQueues(environment, [queue.name]),
              engine.totalConcurrencyOfQueues(environment, [queue.name]),
            ])
          : await Promise.all([
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
          version: updatedQueue.concurrencyVersion,
          running: runningByName?.[updatedQueue.name] ?? 0,
          queued: queuedByName?.[updatedQueue.name] ?? 0,
          concurrencyLimit: updatedQueue.concurrencyLimit ?? null,
          concurrencyLimitBase: updatedQueue.concurrencyLimitBase ?? null,
          concurrencyLimitOverriddenAt: updatedQueue.concurrencyLimitOverriddenAt ?? null,
          concurrencyLimitOverriddenBy: queue.concurrencyLimitOverriddenBy ?? null,
          paused: updatedQueue.paused,
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

  /**
   * Bounded pause-aware re-sync of the per-key engine key from fresh reads of
   * the row, until the persisted values hold still. With `alreadySynced` set to
   * the values this action just wrote, an unmoved row costs one read and no
   * engine writes; without it (after a failed write) the fresh row is always
   * re-synced at least once. Pause never touches the total key, so only the
   * per-key key is healed here.
   */
  private async resyncPerKeyFromFreshRow(
    environment: AuthenticatedEnvironment,
    queueId: string,
    alreadySynced?: { perKey: number | null; paused: boolean }
  ): Promise<void> {
    let lastSynced = alreadySynced ?? null;
    for (let i = 0; i < 3; i++) {
      const fresh = await this._prisma.taskQueue.findFirst({ where: { id: queueId } });
      if (
        !fresh ||
        (lastSynced !== null &&
          fresh.paused === lastSynced.paused &&
          fresh.concurrencyLimit === lastSynced.perKey)
      ) {
        return;
      }
      if (fresh.paused) {
        await updateQueueConcurrencyLimits(environment, fresh.name, 0);
      } else if (typeof fresh.concurrencyLimit === "number") {
        await updateQueueConcurrencyLimits(environment, fresh.name, fresh.concurrencyLimit);
      } else {
        await removeQueueConcurrencyLimits(environment, fresh.name);
      }
      lastSynced = { perKey: fresh.concurrencyLimit, paused: fresh.paused };
    }
  }
}
