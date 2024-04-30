import { Prisma, TaskRunStatus } from "@trigger.dev/database";
import { Direction } from "~/components/runs/RunStatuses";
import { FINISHED_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { sqlDatabaseSchema } from "~/db.server";
import { displayableEnvironments } from "~/models/runtimeEnvironment.server";
import { CANCELLABLE_STATUSES } from "~/v3/services/cancelTaskRun.server";
import { BasePresenter } from "./basePresenter.server";

type RunListOptions = {
  userId?: string;
  projectSlug: string;
  //filters
  tasks?: string[];
  versions?: string[];
  statuses?: TaskRunStatus[];
  environments?: string[];
  scheduleId?: string;
  from?: number;
  to?: number;
  //pagination
  direction?: Direction;
  cursor?: string;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 20;

export type RunList = Awaited<ReturnType<RunListPresenter["call"]>>;
export type RunListItem = RunList["runs"][0];
export type RunListAppliedFilters = RunList["filters"];

export class RunListPresenter extends BasePresenter {
  public async call({
    userId,
    projectSlug,
    tasks,
    versions,
    statuses,
    environments,
    scheduleId,
    from,
    to,
    direction = "forward",
    cursor,
    pageSize = DEFAULT_PAGE_SIZE,
  }: RunListOptions) {
    const hasStatusFilters = statuses && statuses.length > 0;

    const hasFilters =
      tasks !== undefined ||
      versions !== undefined ||
      hasStatusFilters ||
      environments !== undefined ||
      from !== undefined ||
      to !== undefined;

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
        slug: projectSlug,
      },
    });

    //get all possible tasks
    const possibleTasks = await this._replica.backgroundWorkerTask.findMany({
      distinct: ["slug"],
      where: {
        projectId: project.id,
      },
    });

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
    tr."spanId" AS "spanId"
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
          environment: displayableEnvironments(environment, userId),
        };
      }),
      pagination: {
        next,
        previous,
      },
      possibleTasks: possibleTasks.map((task) => task.slug),
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
