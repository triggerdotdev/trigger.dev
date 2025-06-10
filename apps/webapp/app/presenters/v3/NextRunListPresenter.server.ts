import { ClickHouse } from "@internal/clickhouse";
import { PrismaClient, PrismaClientOrTransaction, type TaskRunStatus } from "@trigger.dev/database";
import { type Direction } from "~/components/ListPagination";
import { timeFilters } from "~/components/runs/v3/SharedFilters";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import { getAllTaskIdentifiers } from "~/models/task.server";
import { RunsRepository } from "~/services/runsRepository.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { isCancellableRunStatus, isFinalRunStatus, isPendingRunStatus } from "~/v3/taskStatus";
import parseDuration from "parse-duration";

export type RunListOptions = {
  userId?: string;
  projectId: string;
  //filters
  tasks?: string[];
  versions?: string[];
  statuses?: TaskRunStatus[];
  tags?: string[];
  scheduleId?: string;
  period?: string;
  bulkId?: string;
  from?: number;
  to?: number;
  isTest?: boolean;
  rootOnly?: boolean;
  batchId?: string;
  runIds?: string[];
  //pagination
  direction?: Direction;
  cursor?: string;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 25;

export type NextRunList = Awaited<ReturnType<NextRunListPresenter["call"]>>;
export type NextRunListItem = NextRunList["runs"][0];
export type NextRunListAppliedFilters = NextRunList["filters"];

export class NextRunListPresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {}

  public async call(
    environmentId: string,
    {
      userId,
      projectId,
      tasks,
      versions,
      statuses,
      tags,
      scheduleId,
      period,
      bulkId,
      isTest,
      rootOnly,
      batchId,
      runIds,
      from,
      to,
      direction = "forward",
      cursor,
      pageSize = DEFAULT_PAGE_SIZE,
    }: RunListOptions
  ) {
    //get the time values from the raw values (including a default period)
    const time = timeFilters({
      period,
      from,
      to,
    });

    const periodMs = time.period ? parseDuration(time.period) : undefined;

    const hasStatusFilters = statuses && statuses.length > 0;

    const hasFilters =
      (tasks !== undefined && tasks.length > 0) ||
      (versions !== undefined && versions.length > 0) ||
      hasStatusFilters ||
      (bulkId !== undefined && bulkId !== "") ||
      (scheduleId !== undefined && scheduleId !== "") ||
      (tags !== undefined && tags.length > 0) ||
      batchId !== undefined ||
      (runIds !== undefined && runIds.length > 0) ||
      typeof isTest === "boolean" ||
      rootOnly === true ||
      !time.isDefault;

    //get all possible tasks
    const possibleTasksAsync = getAllTaskIdentifiers(this.replica, environmentId);

    //get possible bulk actions
    // TODO: we should replace this with the new bulk stuff and make it environment scoped
    const bulkActionsAsync = this.replica.bulkActionGroup.findMany({
      select: {
        friendlyId: true,
        type: true,
        createdAt: true,
      },
      where: {
        projectId: projectId,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    });

    const [possibleTasks, bulkActions, displayableEnvironment] = await Promise.all([
      possibleTasksAsync,
      bulkActionsAsync,
      findDisplayableEnvironment(environmentId, userId),
    ]);

    if (!displayableEnvironment) {
      throw new ServiceValidationError("No environment found");
    }

    //we can restrict to specific runs using bulkId, or batchId
    let restrictToRunIds: undefined | string[] = undefined;

    //bulk id
    if (bulkId) {
      const bulkAction = await this.replica.bulkActionGroup.findFirst({
        select: {
          items: {
            select: {
              destinationRunId: true,
            },
          },
        },
        where: {
          friendlyId: bulkId,
        },
      });

      if (bulkAction) {
        const runIds = bulkAction.items.map((item) => item.destinationRunId).filter(Boolean);
        restrictToRunIds = runIds;
      }
    }

    //batch id is a friendly id
    if (batchId) {
      const batch = await this.replica.batchTaskRun.findFirst({
        select: {
          id: true,
        },
        where: {
          friendlyId: batchId,
          runtimeEnvironmentId: environmentId,
        },
      });

      if (batch) {
        batchId = batch.id;
      }
    }

    //scheduleId can be a friendlyId
    if (scheduleId && scheduleId.startsWith("sched_")) {
      const schedule = await this.replica.taskSchedule.findFirst({
        select: {
          id: true,
        },
        where: {
          friendlyId: scheduleId,
          projectId: projectId,
        },
      });

      if (schedule) {
        scheduleId = schedule?.id;
      }
    }

    //show all runs if we are filtering by batchId or runId
    if (batchId || runIds?.length || scheduleId || tasks?.length) {
      rootOnly = false;
    }

    const runsRepository = new RunsRepository({
      clickhouse: this.clickhouse,
      prisma: this.replica as PrismaClient,
    });

    const { runs, pagination } = await runsRepository.listRuns({
      environmentId,
      projectId,
      tasks,
      versions,
      statuses,
      tags,
      scheduleId,
      period: periodMs ?? undefined,
      from,
      to,
      isTest,
      rootOnly,
      batchId,
      runFriendlyIds: runIds,
      runIds: restrictToRunIds,
      page: {
        size: pageSize,
        cursor,
        direction,
      },
    });

    let hasAnyRuns = runs.length > 0;

    if (!hasAnyRuns) {
      const firstRun = await this.replica.taskRun.findFirst({
        where: {
          runtimeEnvironmentId: environmentId,
        },
      });

      if (firstRun) {
        hasAnyRuns = true;
      }
    }

    return {
      runs: runs.map((run) => {
        const hasFinished = isFinalRunStatus(run.status);

        const startedAt = run.startedAt ?? run.lockedAt;

        return {
          id: run.id,
          number: 1,
          friendlyId: run.friendlyId,
          createdAt: run.createdAt.toISOString(),
          updatedAt: run.updatedAt.toISOString(),
          startedAt: startedAt ? startedAt.toISOString() : undefined,
          delayUntil: run.delayUntil ? run.delayUntil.toISOString() : undefined,
          hasFinished,
          finishedAt: hasFinished
            ? run.completedAt?.toISOString() ?? run.updatedAt.toISOString()
            : undefined,
          isTest: run.isTest,
          status: run.status,
          version: run.taskVersion,
          taskIdentifier: run.taskIdentifier,
          spanId: run.spanId,
          isReplayable: true,
          isCancellable: isCancellableRunStatus(run.status),
          isPending: isPendingRunStatus(run.status),
          environment: displayableEnvironment,
          idempotencyKey: run.idempotencyKey ? run.idempotencyKey : undefined,
          ttl: run.ttl ? run.ttl : undefined,
          expiredAt: run.expiredAt ? run.expiredAt.toISOString() : undefined,
          costInCents: run.costInCents,
          baseCostInCents: run.baseCostInCents,
          usageDurationMs: Number(run.usageDurationMs),
          tags: run.runTags ? run.runTags.sort((a, b) => a.localeCompare(b)) : [],
          depth: run.depth,
          rootTaskRunId: run.rootTaskRunId,
          metadata: run.metadata,
          metadataType: run.metadataType,
        };
      }),
      pagination: {
        next: pagination.nextCursor ?? undefined,
        previous: pagination.previousCursor ?? undefined,
      },
      possibleTasks: possibleTasks
        .map((task) => ({ slug: task.slug, triggerSource: task.triggerSource }))
        .sort((a, b) => {
          return a.slug.localeCompare(b.slug);
        }),
      bulkActions: bulkActions.map((bulkAction) => ({
        id: bulkAction.friendlyId,
        type: bulkAction.type,
        createdAt: bulkAction.createdAt,
      })),
      filters: {
        tasks: tasks || [],
        versions: versions || [],
        statuses: statuses || [],
        from: time.from,
        to: time.to,
      },
      hasFilters,
      hasAnyRuns,
    };
  }
}
