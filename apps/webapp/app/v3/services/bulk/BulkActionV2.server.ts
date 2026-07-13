import { BulkActionId } from "@trigger.dev/core/v3/isomorphic";
import {
  BulkActionNotificationType,
  BulkActionStatus,
  BulkActionType,
  type PrismaClient,
} from "@trigger.dev/database";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import {
  parseRunListInputOptions,
  type RunListInputFilters,
  RunsRepository,
} from "~/services/runsRepository/runsRepository.server";
import { BaseService } from "../baseService.server";
import { ServiceValidationError } from "../common.server";
import { commonWorker } from "~/v3/commonWorker.server";
import { env } from "~/env.server";
import { logger } from "@trigger.dev/sdk";
import { CancelTaskRunService } from "../cancelTaskRun.server";
import { tryCatch } from "@trigger.dev/core";
import { ReplayTaskRunService } from "../replayTaskRun.server";
import { WorkerGroupService } from "../worker/workerGroupService.server";
import { timeFilters } from "~/components/runs/v3/SharedFilters";
import parseDuration from "parse-duration";
import { v3BulkActionPath } from "~/utils/pathBuilder";
import { formatDateTime } from "~/components/primitives/DateTime";
import pMap from "p-map";

export type CreateBulkActionInput = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId?: string | null;
  action: "cancel" | "replay";
  filters: RunListInputFilters;
  title?: string;
  region?: string;
  emailNotification?: boolean;
  triggerSource?: string;
};

export type ProcessToCompletionOptions = {
  /** Absolute timestamp (ms) after which processing stops and returns incomplete. */
  deadline?: number;
};

export type ProcessToCompletionResult = {
  completed: boolean;
};

// How recently a PENDING replay must have made progress to still count against
// the per-environment concurrency limit. Every processed batch bumps the
// group's `updatedAt`, so a live replay keeps a fresh heartbeat for its whole
// life no matter how long it runs, while a replay whose job has exhausted its
// retries (and stopped making progress) ages out and frees its slot. This is
// wide enough to cover the worst-case gap between batches for a healthy replay
// that is retrying.
const REPLAY_INFLIGHT_WINDOW_MS = 30 * 60 * 1000;

export class BulkActionService extends BaseService {
  public async create(input: CreateBulkActionInput) {
    const { organizationId, projectId, environmentId, userId } = input;
    const filters = freezeRunListFilters(input.filters);

    // Concurrency guard for replays.
    // The seek is backed by the (environmentId, status, type) index; the
    // `updatedAt` window is applied on top so we only count replays that are
    // actually still making progress. A replay whose job has died stops bumping
    // `updatedAt` and drops out of the count, so it can't permanently hold a
    // slot. Aborting a replay (dashboard or API) clears its slot immediately.
    if (input.action === "replay") {
      const maxConcurrentReplays = env.BULK_ACTION_MAX_CONCURRENT_REPLAYS;
      const inFlightReplays = await this._replica.bulkActionGroup.count({
        where: {
          environmentId,
          type: BulkActionType.REPLAY,
          status: BulkActionStatus.PENDING,
          updatedAt: { gte: new Date(Date.now() - REPLAY_INFLIGHT_WINDOW_MS) },
        },
      });

      if (inFlightReplays >= maxConcurrentReplays) {
        throw new ServiceValidationError(
          `You can only run ${maxConcurrentReplays} bulk replays at a time in this environment. Wait for an in-progress replay to finish before starting another.`,
          429
        );
      }
    }

    // Region is a replay-only override that re-routes the replayed runs. It's
    // stored alongside the run-list filters under a dedicated key so it isn't
    // mistaken for a `regions` selection filter when the params are parsed.
    const replayRegion = input.action === "replay" ? input.region : undefined;
    if (replayRegion) {
      // Validating the region override up-front so an invalid/unauthorized
      // region surfaces as a user-input (400) error rather than a 500.
      const [regionError] = await tryCatch(
        new WorkerGroupService({ prisma: this._prisma }).getDefaultWorkerGroupForProject({
          projectId,
          regionOverride: replayRegion,
        })
      );
      if (regionError) {
        throw new ServiceValidationError(regionError.message, 400);
      }
    }

    const params = {
      ...filters,
      ...(replayRegion ? { replayRegion } : {}),
      ...(input.triggerSource ? { triggerSource: input.triggerSource } : {}),
    };

    // Count the runs that will be affected by the bulk action
    const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
      organizationId,
      "standard"
    );
    const runsRepository = new RunsRepository({
      clickhouse,
      prisma: this._replica as PrismaClient,
    });
    const count = await runsRepository.countRuns({
      organizationId,
      projectId,
      environmentId,
      ...filters,
    });

    // Create the bulk action group
    const { id, friendlyId } = BulkActionId.generate();
    const group = await this._prisma.bulkActionGroup.create({
      data: {
        id,
        friendlyId,
        projectId,
        environmentId,
        userId,
        name: input.title,
        type: input.action === "cancel" ? BulkActionType.CANCEL : BulkActionType.REPLAY,
        params,
        queryName: "bulk_action_v1",
        totalCount: count,
        completionNotification:
          input.emailNotification === true
            ? BulkActionNotificationType.EMAIL
            : BulkActionNotificationType.NONE,
      },
    });

    // Queue the bulk action group for immediate processing
    await commonWorker.enqueue({
      id: `processBulkAction-${group.id}`,
      job: "processBulkAction",
      payload: {
        bulkActionId: group.id,
      },
    });

    return {
      bulkActionId: group.friendlyId,
    };
  }

  public async processToCompletion(
    bulkActionId: string,
    options?: ProcessToCompletionOptions
  ): Promise<ProcessToCompletionResult> {
    while (true) {
      const group = await this._prisma.bulkActionGroup.findFirst({
        where: { id: bulkActionId },
        select: { status: true },
      });

      if (!group) {
        throw new Error(`Bulk action group not found: ${bulkActionId}`);
      }

      if (group.status === BulkActionStatus.COMPLETED) {
        return { completed: true };
      }

      if (group.status === BulkActionStatus.ABORTED) {
        return { completed: false };
      }

      if (options?.deadline !== undefined && Date.now() >= options.deadline) {
        return { completed: false };
      }

      await this.process(bulkActionId, { continueInline: true });
    }
  }

  public async process(
    bulkActionId: string,
    options?: {
      continueInline?: boolean;
    }
  ) {
    // 1. Get the bulk action group
    const group = await this._prisma.bulkActionGroup.findFirst({
      where: { id: bulkActionId },
      select: {
        status: true,
        friendlyId: true,
        projectId: true,
        environmentId: true,
        project: {
          select: {
            organizationId: true,
            slug: true,
            organization: {
              select: {
                slug: true,
              },
            },
          },
        },
        environment: {
          select: {
            slug: true,
          },
        },
        type: true,
        queryName: true,
        params: true,
        cursor: true,
        completionNotification: true,
        user: {
          select: {
            email: true,
          },
        },
        createdAt: true,
        completedAt: true,
      },
    });

    if (!group) {
      throw new Error(`Bulk action group not found: ${bulkActionId}`);
    }

    if (!group.environmentId || !group.environment) {
      throw new Error(`Bulk action group has no environment: ${bulkActionId}`);
    }

    if (group.status === BulkActionStatus.ABORTED) {
      logger.log(`Bulk action group already aborted: ${bulkActionId}`);
      return;
    }

    if (group.status === BulkActionStatus.COMPLETED) {
      return;
    }

    // 2. Parse the params
    const rawParams = group.params && typeof group.params === "object" ? group.params : {};
    const finalizeRun = "finalizeRun" in rawParams && (rawParams as any).finalizeRun === true;
    const replayRegion =
      "replayRegion" in rawParams && typeof (rawParams as any).replayRegion === "string"
        ? (rawParams as any).replayRegion
        : undefined;
    const triggerSource =
      "triggerSource" in rawParams && typeof (rawParams as any).triggerSource === "string"
        ? (rawParams as any).triggerSource
        : "dashboard";
    const filters = parseRunListInputOptions({
      organizationId: group.project.organizationId,
      projectId: group.projectId,
      environmentId: group.environmentId,
      ...rawParams,
    });

    const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
      group.project.organizationId,
      "standard"
    );
    const runsRepository = new RunsRepository({
      clickhouse,
      prisma: this._replica as PrismaClient,
    });

    if (group.queryName !== "bulk_action_v1") {
      throw new Error(`Bulk action group has invalid query name: ${group.queryName}`);
    }

    // 2. Get the runs to process in this batch, plus the cursor for the next
    // batch. The cursor is a composite (created_at, run_id) keyset cursor so the
    // next batch can't re-include or skip runs.
    const {
      runIds: runIdsToProcess,
      pagination: { nextCursor },
    } = await runsRepository.listRunIds({
      ...filters,
      page: {
        size: env.BULK_ACTION_BATCH_SIZE,
        cursor:
          typeof group.cursor === "string" && group.cursor !== null ? group.cursor : undefined,
      },
    });

    // 3. Process the runs
    let successCount = 0;
    let failureCount = 0;

    switch (group.type) {
      case BulkActionType.CANCEL: {
        const cancelService = new CancelTaskRunService(this._prisma);

        // Route the member hydration through the run store: it reads NEW first for the whole
        // id set, then probes the legacy read replica only for the ids NEW missed that could
        // still be cuid-resident, and merges (disjoint by construction). In single-DB mode it
        // reads the collapsed store's replica, byte-identical to the pre-migration read.
        const runs = await this.runStore.findRuns({
          where: { id: { in: runIdsToProcess } },
          select: {
            id: true,
            engine: true,
            friendlyId: true,
            status: true,
            createdAt: true,
            completedAt: true,
            taskEventStore: true,
          },
        });

        await pMap(
          runs,
          async (run) => {
            const [error, result] = await tryCatch(
              cancelService.call(run, {
                reason: `Bulk action ${group.friendlyId} cancelled run`,
                bulkActionId: bulkActionId,
                finalizeRun,
              })
            );
            if (error) {
              logger.error("Failed to cancel run", {
                error,
                runId: run.id,
                status: run.status,
              });

              failureCount++;
            } else {
              if (!result || result.alreadyFinished) {
                failureCount++;
              } else {
                successCount++;
              }
            }
          },
          { concurrency: env.BULK_ACTION_SUBBATCH_CONCURRENCY }
        );

        break;
      }
      case BulkActionType.REPLAY: {
        const replayService = new ReplayTaskRunService(this._prisma);

        // Route the member hydration through the run store (NEW-first, legacy-replica probe for
        // the misses, disjoint merge). Full-row read: replay needs the whole TaskRun.
        const runs = await this.runStore.findRuns({
          where: { id: { in: runIdsToProcess } },
        });

        await pMap(
          runs,
          async (run) => {
            const [error, result] = await tryCatch(
              replayService.call(run, {
                bulkActionId: bulkActionId,
                triggerSource,
                region: replayRegion,
              })
            );
            if (error) {
              logger.error("Failed to replay run, error", {
                error,
                runId: run.id,
                status: run.status,
              });

              failureCount++;
            } else {
              if (!result) {
                logger.error("Failed to replay run, no result", {
                  runId: run.id,
                  status: run.status,
                });

                failureCount++;
              } else {
                successCount++;
              }
            }
          },
          { concurrency: env.BULK_ACTION_SUBBATCH_CONCURRENCY }
        );
        break;
      }
    }

    // A null nextCursor means there is no further page — this batch was the
    // last (or there were no runs at all), so the action is complete. (An empty
    // batch also yields a null cursor.)
    const isFinished = nextCursor === null;

    logger.debug("Bulk action group processed batch", {
      bulkActionId,
      organizationId: group.project.organizationId,
      projectId: group.projectId,
      environmentId: group.environmentId,
      batchSize: runIdsToProcess.length,
      cursor: group.cursor,
      successCount,
      failureCount,
      isFinished,
    });

    // 4. Update the bulk action group
    const updatedGroup = await this._prisma.bulkActionGroup.update({
      where: { id: bulkActionId },
      data: {
        // Json column: leave unchanged when there's no next cursor (finished).
        cursor: nextCursor ?? undefined,
        successCount: {
          increment: successCount,
        },
        failureCount: {
          increment: failureCount,
        },
        status: isFinished ? BulkActionStatus.COMPLETED : undefined,
        completedAt: isFinished ? new Date() : undefined,
      },
    });

    // 5. If finished, queue a notification and exit
    if (isFinished) {
      switch (group.completionNotification) {
        case BulkActionNotificationType.NONE:
          return;
        case BulkActionNotificationType.EMAIL: {
          if (!group.user) {
            logger.error("Bulk action group has no user, skipping email notification", {
              bulkActionId,
            });
            return;
          }

          await commonWorker.enqueue({
            id: `bulkActionCompletionNotification-${bulkActionId}`,
            job: "scheduleEmail",
            payload: {
              to: group.user.email,
              email: "bulk-action-completed",
              bulkActionId: group.friendlyId,
              url: `${env.LOGIN_ORIGIN}${v3BulkActionPath(
                {
                  slug: group.project.organization.slug,
                },
                {
                  slug: group.project.slug,
                },
                {
                  slug: group.environment.slug,
                },
                {
                  friendlyId: group.friendlyId,
                }
              )}`,
              totalCount: updatedGroup.totalCount,
              successCount: updatedGroup.successCount,
              failureCount: updatedGroup.failureCount,
              type: group.type,
              createdAt: formatDateTime(group.createdAt, "UTC", [], true, true),
              completedAt: formatDateTime(group.completedAt ?? new Date(), "UTC", [], true, true),
            },
          });
          break;
        }
      }

      return;
    }

    // 6. If there are more runs to process, queue the next batch
    if (options?.continueInline) {
      return;
    }

    await commonWorker.enqueue({
      id: `processBulkAction-${bulkActionId}`,
      job: "processBulkAction",
      payload: { bulkActionId },
      availableAt: new Date(Date.now() + env.BULK_ACTION_BATCH_DELAY_MS),
    });
  }

  public async abort(friendlyId: string, environmentId: string) {
    const group = await this._prisma.bulkActionGroup.findFirst({
      where: { friendlyId, environmentId },
      select: {
        id: true,
        status: true,
      },
    });

    if (!group) {
      throw new ServiceValidationError(`Bulk action not found: ${friendlyId}`, 404);
    }

    if (group.status === BulkActionStatus.COMPLETED) {
      throw new ServiceValidationError(`Bulk action group already completed: ${friendlyId}`, 409);
    }

    if (group.status === BulkActionStatus.ABORTED) {
      throw new ServiceValidationError(`Bulk action group already aborted: ${friendlyId}`, 409);
    }

    //ack the job (this doesn't guarantee it won't run again)
    await commonWorker.ack(`processBulkAction-${group.id}`);

    await this._prisma.bulkActionGroup.update({
      where: { id: group.id },
      data: { status: BulkActionStatus.ABORTED },
    });

    return {
      bulkActionId: friendlyId,
    };
  }
}

export function freezeRunListFilters(filters: RunListInputFilters): RunListInputFilters {
  const {
    cursor: _cursor,
    direction: _direction,
    ...frozenFilters
  } = filters as RunListInputFilters & {
    cursor?: string;
    direction?: "forward" | "backward";
  };

  // Explicit run-id selections target specific, already-existing runs, so we
  // don't apply a time bound (which could otherwise exclude a selected run).
  if (frozenFilters.runId?.length) {
    return frozenFilters;
  }

  const { period } = timeFilters({
    period: frozenFilters.period,
    from: frozenFilters.from,
    to: frozenFilters.to,
  });

  // We fix the time period to a from/to date
  if (period) {
    const periodMs = parseDuration(period);
    if (!periodMs) {
      throw new Error(`Invalid period: ${period}`);
    }

    const to = new Date();
    const from = new Date(to.getTime() - periodMs);
    frozenFilters.from = from.getTime();
    frozenFilters.to = to.getTime();
    frozenFilters.period = undefined;
    return frozenFilters;
  }

  // If no to date is set, we lock it to now
  if (!frozenFilters.to) {
    frozenFilters.to = Date.now();
  }

  frozenFilters.period = undefined;

  return frozenFilters;
}
