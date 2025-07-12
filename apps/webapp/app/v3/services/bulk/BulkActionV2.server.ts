import { BulkActionId } from "@trigger.dev/core/v3/isomorphic";
import {
  BulkActionNotificationType,
  BulkActionStatus,
  BulkActionType,
  type PrismaClient,
} from "@trigger.dev/database";
import { getRunFiltersFromRequest } from "~/presenters/RunFilters.server";
import { type CreateBulkActionPayload } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.bulkaction";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { parseRunListInputOptions, RunsRepository } from "~/services/runsRepository.server";
import { BaseService } from "../baseService.server";
import { commonWorker } from "~/v3/commonWorker.server";
import { env } from "~/env.server";
import { logger } from "@trigger.dev/sdk";
import { CancelTaskRunService } from "../cancelTaskRun.server";
import { tryCatch } from "@trigger.dev/core";
import { ReplayTaskRunService } from "../replayTaskRun.server";
import { timeFilters } from "~/components/runs/v3/SharedFilters";
import parseDuration from "parse-duration";
import { v3BulkActionPath } from "~/utils/pathBuilder";
import { formatDateTime } from "~/components/primitives/DateTime";

export class BulkActionService extends BaseService {
  public async create(
    organizationId: string,
    projectId: string,
    environmentId: string,
    userId: string,
    payload: CreateBulkActionPayload,
    request: Request
  ) {
    const filters = await getFilters(payload, request);

    if (!clickhouseClient) {
      throw new Error("Clickhouse client not found");
    }

    // Count the runs that will be affected by the bulk action
    const runsRepository = new RunsRepository({
      clickhouse: clickhouseClient,
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
        name: payload.title,
        type: payload.action === "cancel" ? BulkActionType.CANCEL : BulkActionType.REPLAY,
        params: filters,
        queryName: "bulk_action_v1",
        totalCount: count,
        completionNotification:
          payload.emailNotification === true
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

  public async process(bulkActionId: string) {
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

    // 2. Parse the params
    const filters = parseRunListInputOptions({
      organizationId: group.project.organizationId,
      projectId: group.projectId,
      environmentId: group.environmentId,
      ...(group.params && typeof group.params === "object" ? group.params : {}),
    });

    if (!clickhouseClient) {
      throw new Error("Clickhouse client not found");
    }

    const runsRepository = new RunsRepository({
      clickhouse: clickhouseClient,
      prisma: this._replica as PrismaClient,
    });

    // In the future we can support multiple query names, when we make changes
    if (group.queryName !== "bulk_action_v1") {
      throw new Error(`Bulk action group has invalid query name: ${group.queryName}`);
    }

    // 2. Get the runs to process in this batch
    const runIds = await runsRepository.listRunIds({
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
    // Slice because we fetch an extra for the cursor
    const runIdsToProcess = runIds.slice(0, env.BULK_ACTION_BATCH_SIZE);

    switch (group.type) {
      case BulkActionType.CANCEL: {
        const cancelService = new CancelTaskRunService(this._prisma);

        const runs = await this._replica.taskRun.findMany({
          where: {
            id: {
              in: runIdsToProcess,
            },
          },
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

        for (const run of runs) {
          const [error, result] = await tryCatch(
            cancelService.call(run, {
              reason: `Bulk action ${group.friendlyId} cancelled run`,
              bulkActionId: bulkActionId,
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
        }

        break;
      }
      case BulkActionType.REPLAY: {
        const replayService = new ReplayTaskRunService(this._prisma);

        const runs = await this._replica.taskRun.findMany({
          where: {
            id: {
              in: runIdsToProcess,
            },
          },
        });

        for (const run of runs) {
          const [error, result] = await tryCatch(
            replayService.call(run, {
              bulkActionId: bulkActionId,
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
        }
        break;
      }
    }

    const isFinished = runIdsToProcess.length === 0;

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
    await this._prisma.bulkActionGroup.update({
      where: { id: bulkActionId },
      data: {
        cursor: runIdsToProcess.at(runIdsToProcess.length - 1),
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
              totalCount: successCount + failureCount,
              successCount,
              failureCount,
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
      throw new Error(`Bulk action not found: ${friendlyId}`);
    }

    if (group.status === BulkActionStatus.COMPLETED) {
      throw new Error(`Bulk action group already completed: ${friendlyId}`);
    }

    if (group.status === BulkActionStatus.ABORTED) {
      throw new Error(`Bulk action group already aborted: ${friendlyId}`);
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

async function getFilters(payload: CreateBulkActionPayload, request: Request) {
  if (payload.mode === "selected") {
    return {
      runIds: payload.selectedRunIds,
      cursor: undefined,
      direction: undefined,
    };
  }

  const filters = await getRunFiltersFromRequest(request);
  filters.cursor = undefined;
  filters.direction = undefined;

  const { period, from, to } = timeFilters({
    period: filters.period,
    from: filters.from,
    to: filters.to,
  });

  // We fix the time period to a from/to date
  if (period) {
    const periodMs = parseDuration(period);
    if (!periodMs) {
      throw new Error(`Invalid period: ${period}`);
    }

    const to = new Date();
    const from = new Date(to.getTime() - periodMs);
    filters.from = from.getTime();
    filters.to = to.getTime();
    filters.period = undefined;
    return filters;
  }

  // If no to date is set, we lock it to now
  if (!filters.to) {
    filters.to = Date.now();
  }

  filters.period = undefined;

  return filters;
}
