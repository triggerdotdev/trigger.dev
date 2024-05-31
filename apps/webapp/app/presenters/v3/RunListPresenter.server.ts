import { Prisma, TaskRunStatus } from "@trigger.dev/database";
import parse from "parse-duration";
import { Direction } from "~/components/runs/RunStatuses";
import { FINISHED_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { sqlDatabaseSchema } from "~/db.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { CANCELLABLE_STATUSES } from "~/v3/services/cancelTaskRun.server";
import { BasePresenter } from "./basePresenter.server";

export type RunListOptions = {
  userId?: string;
  projectId: string;
  //filters
  tasks?: string[];
  versions?: string[];
  statuses?: TaskRunStatus[];
  environments?: string[];
  scheduleId?: string;
  period?: string;
  bulkId?: string;
  from?: number;
  to?: number;
  isTest?: boolean;
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
    scheduleId,
    period,
    bulkId,
    isTest,
    from,
    to,
    direction = "forward",
    cursor,
    pageSize = DEFAULT_PAGE_SIZE,
  }: RunListOptions) {
    const hasStatusFilters = statuses && statuses.length > 0;

    const hasFilters =
      (tasks !== undefined && tasks.length > 0) ||
      (versions !== undefined && versions.length > 0) ||
      hasStatusFilters ||
      (environments !== undefined && environments.length > 0) ||
      (period !== undefined && period !== "all") ||
      (bulkId !== undefined && bulkId !== "") ||
      from !== undefined ||
      to !== undefined ||
      (scheduleId !== undefined && scheduleId !== "") ||
      typeof isTest === "boolean";

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
    const possibleTasksAsync = this._replica.backgroundWorkerTask.findMany({
      distinct: ["slug"],
      where: {
        projectId: project.id,
      },
    });

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
      const bulkAction = await this._replica.bulkActionGroup.findUnique({
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

    const periodMs = period ? parse(period) : undefined;

    //get the runs
    let runs = await this._replica.$queryRaw<
      {
        id: string;
        number: BigInt;
        runFriendlyId: string;
        taskIdentifier: string;
        version: string | null;
        runtimeEnvironmentId: string;
        status: TaskRunStatus;
        createdAt: Date;
        lockedAt: Date | null;
        updatedAt: Date;
        isTest: boolean;
        spanId: string;
        idempotencyKey: string | null;
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
    tr."lockedAt" AS "lockedAt",
    tr."updatedAt" AS "updatedAt",
    tr."isTest" AS "isTest",
    tr."spanId" AS "spanId",
    tr."idempotencyKey" AS "idempotencyKey"
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
        from
          ? Prisma.sql`AND tr."createdAt" >= ${new Date(from).toISOString()}::timestamp`
          : Prisma.empty
      } 
      ${
        to
          ? Prisma.sql`AND tr."createdAt" <= ${new Date(to).toISOString()}::timestamp`
          : Prisma.empty
      } 
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

    return {
      runs: runsToReturn.map((run) => {
        const environment = project.environments.find((env) => env.id === run.runtimeEnvironmentId);

        if (!environment) {
          throw new Error(`Environment not found for TaskRun ${run.id}`);
        }

        const hasFinished = FINISHED_STATUSES.includes(run.status);

        return {
          id: run.id,
          friendlyId: run.runFriendlyId,
          number: Number(run.number),
          createdAt: run.createdAt.toISOString(),
          updatedAt: run.updatedAt.toISOString(),
          startedAt: run.lockedAt ? run.lockedAt.toISOString() : undefined,
          hasFinished,
          finishedAt: hasFinished ? run.updatedAt.toISOString() : undefined,
          isTest: run.isTest,
          status: run.status,
          version: run.version,
          taskIdentifier: run.taskIdentifier,
          spanId: run.spanId,
          isReplayable: true,
          isCancellable: CANCELLABLE_STATUSES.includes(run.status),
          environment: displayableEnvironment(environment, userId),
          idempotencyKey: run.idempotencyKey ? run.idempotencyKey : undefined,
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
        from,
        to,
      },
      hasFilters,
    };
  }
}
