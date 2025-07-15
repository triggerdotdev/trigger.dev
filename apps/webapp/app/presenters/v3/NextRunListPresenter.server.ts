import { type ClickHouse } from "@internal/clickhouse";
import {
  type PrismaClient,
  type PrismaClientOrTransaction,
  type TaskRunStatus,
} from "@trigger.dev/database";
import { type Direction } from "~/components/ListPagination";
import { timeFilters } from "~/components/runs/v3/SharedFilters";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import { getAllTaskIdentifiers } from "~/models/task.server";
import { RunsRepository } from "~/services/runsRepository.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { isCancellableRunStatus, isFinalRunStatus, isPendingRunStatus } from "~/v3/taskStatus";

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
  runId?: string[];
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
    organizationId: string,
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
      runId,
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

    const hasStatusFilters = statuses && statuses.length > 0;

    const hasFilters =
      (tasks !== undefined && tasks.length > 0) ||
      (versions !== undefined && versions.length > 0) ||
      hasStatusFilters ||
      (bulkId !== undefined && bulkId !== "") ||
      (scheduleId !== undefined && scheduleId !== "") ||
      (tags !== undefined && tags.length > 0) ||
      batchId !== undefined ||
      (runId !== undefined && runId.length > 0) ||
      typeof isTest === "boolean" ||
      rootOnly === true ||
      !time.isDefault;

    //get all possible tasks
    const possibleTasksAsync = getAllTaskIdentifiers(this.replica, environmentId);

    //get possible bulk actions
    const bulkActionsAsync = this.replica.bulkActionGroup.findMany({
      select: {
        friendlyId: true,
        type: true,
        createdAt: true,
        name: true,
      },
      where: {
        projectId: projectId,
        environmentId,
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

    // If the bulk action isn't in the most recent ones, add it separately
    if (bulkId && !bulkActions.some((bulkAction) => bulkAction.friendlyId === bulkId)) {
      const selectedBulkAction = await this.replica.bulkActionGroup.findFirst({
        select: {
          friendlyId: true,
          type: true,
          createdAt: true,
          name: true,
        },
        where: {
          friendlyId: bulkId,
          projectId,
          environmentId,
        },
      });

      if (selectedBulkAction) {
        bulkActions.push(selectedBulkAction);
      }
    }

    if (!displayableEnvironment) {
      throw new ServiceValidationError("No environment found");
    }

    const runsRepository = new RunsRepository({
      clickhouse: this.clickhouse,
      prisma: this.replica as PrismaClient,
    });

    function clampToNow(date: Date): Date {
      const now = new Date();
      return date > now ? now : date;
    }

    const { runs, pagination } = await runsRepository.listRuns({
      organizationId,
      environmentId,
      projectId,
      tasks,
      versions,
      statuses,
      tags,
      scheduleId,
      period,
      from: time.from ? time.from.getTime() : undefined,
      to: time.to ? clampToNow(time.to).getTime() : undefined,
      isTest,
      rootOnly,
      batchId,
      runId,
      bulkId,
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
        name: bulkAction.name || bulkAction.friendlyId,
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
