import { Prisma, type TaskRunStatus } from "@trigger.dev/database";
import parse from "parse-duration";
import { sqlDatabaseSchema } from "~/db.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { isCancellableRunStatus, isFinalRunStatus, isPendingRunStatus } from "~/v3/taskStatus";
import { BasePresenter } from "./basePresenter.server";
import { getAllTaskIdentifiers } from "~/models/task.server";
import { type Direction } from "~/components/ListPagination";
import { timeFilters } from "~/components/runs/v3/SharedFilters";

export type RunListOptions = {
  userId?: string;
  projectId: string;
  //filters
  tasks?: string[];
  versions?: string[];
  statuses?: TaskRunStatus[];
  environments?: string[];
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

export type RunList = Awaited<ReturnType<RunListPresenter["call"]>>;
export type RunListItem = RunList["runs"][0];
export type RunListAppliedFilters = RunList["filters"];

export class RunListPresenter extends BasePresenter {
  public async call({
    userId,
    projectId,
    tasks,
    versions,
    statuses,
    environments,
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
  }: RunListOptions) {
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
      (runIds !== undefined && runIds.length > 0) ||
      typeof isTest === "boolean" ||
      rootOnly === true ||
      !time.isDefault;

    // Find the project scoped to the organization
    const project = await this._replica.project.findFirstOrThrow({
      select: {
        id: true,
        environments: {
          select: {
            id: true,
            type: true,
            slug: true,
            orgMember: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    displayName: true,
                  },
                },
              },
            },
          },
        },
      },
      where: {
        id: projectId,
      },
    });

    //get all possible tasks
    const possibleTasksAsync = getAllTaskIdentifiers(this._replica, project.id);

    //get possible bulk actions
    const bulkActionsAsync = this._replica.bulkActionGroup.findMany({
      select: {
        friendlyId: true,
        type: true,
        createdAt: true,
      },
      where: {
        projectId: project.id,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    });

    const [possibleTasks, bulkActions] = await Promise.all([possibleTasksAsync, bulkActionsAsync]);

    //we can restrict to specific runs using bulkId, or batchId
    let restrictToRunIds: undefined | string[] = undefined;

    //bulk id
    if (bulkId) {
      const bulkAction = await this._replica.bulkActionGroup.findFirst({
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
      const batch = await this._replica.batchTaskRun.findFirst({
        select: {
          id: true,
        },
        where: {
          friendlyId: batchId,
        },
      });

      if (batch) {
        batchId = batch.id;
      }
    }

    //scheduleId can be a friendlyId
    if (scheduleId && scheduleId.startsWith("sched_")) {
      const schedule = await this._replica.taskSchedule.findFirst({
        select: {
          id: true,
        },
        where: {
          friendlyId: scheduleId,
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

    const periodMs = time.period ? parse(time.period) : undefined;

    //get the runs
    const runs = await this._replica.$queryRaw<
      {
        id: string;
        number: BigInt;
        runFriendlyId: string;
        taskIdentifier: string;
        version: string | null;
        runtimeEnvironmentId: string;
        status: TaskRunStatus;
        createdAt: Date;
        startedAt: Date | null;
        lockedAt: Date | null;
        delayUntil: Date | null;
        updatedAt: Date;
        isTest: boolean;
        spanId: string;
        idempotencyKey: string | null;
        ttl: string | null;
        expiredAt: Date | null;
        costInCents: number;
        baseCostInCents: number;
        usageDurationMs: BigInt;
        tags: null | string[];
        depth: number;
        rootTaskRunId: string | null;
        batchId: string | null;
        metadata: string | null;
        metadataType: string;
      }[]
    >`
    SELECT
    tr.id,
    tr.number,
    tr."friendlyId" AS "runFriendlyId",
    tr."taskIdentifier" AS "taskIdentifier",
    bw.version AS version,
    tr."runtimeEnvironmentId" AS "runtimeEnvironmentId",
    tr.status AS status,
    tr."createdAt" AS "createdAt",
    tr."startedAt" AS "startedAt",
    tr."delayUntil" AS "delayUntil",
    tr."lockedAt" AS "lockedAt",
    tr."updatedAt" AS "updatedAt",
    tr."isTest" AS "isTest",
    tr."spanId" AS "spanId",
    tr."idempotencyKey" AS "idempotencyKey",
    tr."ttl" AS "ttl",
    tr."expiredAt" AS "expiredAt",
    tr."baseCostInCents" AS "baseCostInCents",
    tr."costInCents" AS "costInCents",
    tr."usageDurationMs" AS "usageDurationMs",
    tr."depth" AS "depth",
    tr."rootTaskRunId" AS "rootTaskRunId",
    tr."runTags" AS "tags",
    tr."metadata" AS "metadata",
    tr."metadataType" AS "metadataType"
FROM
    ${sqlDatabaseSchema}."TaskRun" tr
LEFT JOIN
    ${sqlDatabaseSchema}."BackgroundWorker" bw ON tr."lockedToVersionId" = bw.id
WHERE
    -- project
    tr."projectId" = ${project.id}
    -- cursor
    ${
      cursor
        ? direction === "forward"
          ? Prisma.sql`AND tr.id < ${cursor}`
          : Prisma.sql`AND tr.id > ${cursor}`
        : Prisma.empty
    }
    -- filters
    ${runIds ? Prisma.sql`AND tr."friendlyId" IN (${Prisma.join(runIds)})` : Prisma.empty}
    ${batchId ? Prisma.sql`AND tr."batchId" = ${batchId}` : Prisma.empty}
    ${
      restrictToRunIds
        ? restrictToRunIds.length === 0
          ? Prisma.sql`AND tr.id = ''`
          : Prisma.sql`AND tr.id IN (${Prisma.join(restrictToRunIds)})`
        : Prisma.empty
    }
    ${
      tasks && tasks.length > 0
        ? Prisma.sql`AND tr."taskIdentifier" IN (${Prisma.join(tasks)})`
        : Prisma.empty
    }
    ${
      statuses && statuses.length > 0
        ? Prisma.sql`AND tr.status = ANY(ARRAY[${Prisma.join(statuses)}]::"TaskRunStatus"[])`
        : Prisma.empty
    }
    ${
      environments && environments.length > 0
        ? Prisma.sql`AND tr."runtimeEnvironmentId" IN (${Prisma.join(environments)})`
        : Prisma.empty
    }
    ${scheduleId ? Prisma.sql`AND tr."scheduleId" = ${scheduleId}` : Prisma.empty}
    ${typeof isTest === "boolean" ? Prisma.sql`AND tr."isTest" = ${isTest}` : Prisma.empty}
    ${
      periodMs
        ? Prisma.sql`AND tr."createdAt" >= NOW() - INTERVAL '1 millisecond' * ${periodMs}`
        : Prisma.empty
    }
    ${
      time.from
        ? Prisma.sql`AND tr."createdAt" >= ${time.from.toISOString()}::timestamp`
        : Prisma.empty
    }
    ${
      time.to ? Prisma.sql`AND tr."createdAt" <= ${time.to.toISOString()}::timestamp` : Prisma.empty
    }
    ${
      tags && tags.length > 0
        ? Prisma.sql`AND tr."runTags" && ARRAY[${Prisma.join(tags)}]::text[]`
        : Prisma.empty
    }
    ${rootOnly === true ? Prisma.sql`AND tr."rootTaskRunId" IS NULL` : Prisma.empty}
    GROUP BY
      tr.id, bw.version
    ORDER BY
        ${direction === "forward" ? Prisma.sql`tr.id DESC` : Prisma.sql`tr.id ASC`}
    LIMIT ${pageSize + 1}`;

    const hasMore = runs.length > pageSize;

    //get cursors for next and previous pages
    let next: string | undefined;
    let previous: string | undefined;
    switch (direction) {
      case "forward":
        previous = cursor ? runs.at(0)?.id : undefined;
        if (hasMore) {
          next = runs[pageSize - 1]?.id;
        }
        break;
      case "backward":
        runs.reverse();
        if (hasMore) {
          previous = runs[1]?.id;
          next = runs[pageSize]?.id;
        } else {
          next = runs[pageSize - 1]?.id;
        }
        break;
    }

    const runsToReturn =
      direction === "backward" && hasMore ? runs.slice(1, pageSize + 1) : runs.slice(0, pageSize);

    let hasAnyRuns = runsToReturn.length > 0;
    if (!hasAnyRuns) {
      const firstRun = await this._replica.taskRun.findFirst({
        where: {
          projectId: project.id,
          runtimeEnvironmentId: environments
            ? {
                in: environments,
              }
            : undefined,
        },
      });

      if (firstRun) {
        hasAnyRuns = true;
      }
    }

    return {
      runs: runsToReturn.map((run) => {
        const environment = project.environments.find((env) => env.id === run.runtimeEnvironmentId);

        if (!environment) {
          throw new Error(`Environment not found for TaskRun ${run.id}`);
        }

        const hasFinished = isFinalRunStatus(run.status);

        const startedAt = run.startedAt ?? run.lockedAt;

        return {
          id: run.id,
          friendlyId: run.runFriendlyId,
          number: Number(run.number),
          createdAt: run.createdAt.toISOString(),
          updatedAt: run.updatedAt.toISOString(),
          startedAt: startedAt ? startedAt.toISOString() : undefined,
          delayUntil: run.delayUntil ? run.delayUntil.toISOString() : undefined,
          hasFinished,
          finishedAt: hasFinished ? run.updatedAt.toISOString() : undefined,
          isTest: run.isTest,
          status: run.status,
          version: run.version,
          taskIdentifier: run.taskIdentifier,
          spanId: run.spanId,
          isReplayable: true,
          isCancellable: isCancellableRunStatus(run.status),
          isPending: isPendingRunStatus(run.status),
          environment: displayableEnvironment(environment, userId),
          idempotencyKey: run.idempotencyKey ? run.idempotencyKey : undefined,
          ttl: run.ttl ? run.ttl : undefined,
          expiredAt: run.expiredAt ? run.expiredAt.toISOString() : undefined,
          costInCents: run.costInCents,
          baseCostInCents: run.baseCostInCents,
          usageDurationMs: Number(run.usageDurationMs),
          tags: run.tags ? run.tags.sort((a, b) => a.localeCompare(b)) : [],
          depth: run.depth,
          rootTaskRunId: run.rootTaskRunId,
          metadata: run.metadata,
          metadataType: run.metadataType,
        };
      }),
      pagination: {
        next,
        previous,
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
        environments: environments || [],
        from: time.from,
        to: time.to,
      },
      hasFilters,
      hasAnyRuns,
    };
  }
}
