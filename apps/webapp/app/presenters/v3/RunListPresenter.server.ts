import { Prisma, TaskRunAttemptStatus, TaskRunStatus } from "@trigger.dev/database";
import { Direction } from "~/components/runs/RunStatuses";
import { PrismaClient, prisma } from "~/db.server";
import { getUsername } from "~/utils/username";

type RunListOptions = {
  userId: string;
  projectSlug: string;
  //filters
  tasks: string[] | undefined;
  versions: string[] | undefined;
  statuses: TaskRunStatus[] | undefined;
  environments: string[] | undefined;
  from: number | undefined;
  to: number | undefined;
  //pagination
  direction: Direction | undefined;
  cursor: string | undefined;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 20;

export type RunList = Awaited<ReturnType<RunListPresenter["call"]>>;
export type RunListItem = RunList["runs"][0];
export type RunListAppliedFilters = RunList["filters"];

export class RunListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    tasks,
    versions,
    statuses,
    environments,
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
      environments !== undefined;

    // Find the project scoped to the organization
    const project = await this.#prismaClient.project.findFirstOrThrow({
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
    const possibleTasks = await this.#prismaClient.$queryRaw<{ slug: string }[]>`
    SELECT DISTINCT(slug)
    FROM "BackgroundWorkerTask"
    WHERE "projectId" = ${project.id};
    `;

    //get the runs
    let runs = await this.#prismaClient.$queryRaw<
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
        completedAt: Date | null;
        isTest: boolean;
        attempts: BigInt;
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
    tra."completedAt" AS "completedAt",
    tr."isTest" AS "isTest",
    COUNT(tra.id) AS attempts
  FROM
    "TaskRun" tr
  LEFT JOIN
    (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY "taskRunId" ORDER BY "createdAt" DESC) rn
      FROM "TaskRunAttempt"
    ) tra ON tr.id = tra."taskRunId" AND tra.rn = 1
  LEFT JOIN
    "BackgroundWorker" bw ON tra."backgroundWorkerId" = bw.id
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
      ${hasStatusFilters ? Prisma.sql`AND (` : Prisma.empty}
      ${
        statuses && statuses.length > 0
          ? Prisma.sql`tr.status = ANY(ARRAY[${Prisma.join(statuses)}]::"TaskRunStatus"[])`
          : Prisma.empty
      }
      ${statuses && statuses.length > 0 && hasStatusFilters ? Prisma.sql` OR ` : Prisma.empty}
      ${hasStatusFilters ? Prisma.sql`tr.status IS NULL` : Prisma.empty}
      ${hasStatusFilters ? Prisma.sql`) ` : Prisma.empty}
      ${
        environments && environments.length > 0
          ? Prisma.sql`AND tr."runtimeEnvironmentId" IN (${Prisma.join(environments)})`
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
  GROUP BY
    tr."friendlyId", tr."taskIdentifier", tr."runtimeEnvironmentId", tr.id, bw.version, tra.status, tr."createdAt", tra."startedAt", tra."completedAt"
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

        return {
          id: run.id,
          friendlyId: run.runFriendlyId,
          number: Number(run.number),
          createdAt: run.createdAt,
          startedAt: run.lockedAt,
          completedAt: run.completedAt,
          isTest: run.isTest,
          status: run.status,
          version: run.version,
          taskIdentifier: run.taskIdentifier,
          attempts: Number(run.attempts),
          environment: {
            type: environment.type,
            slug: environment.slug,
            userId: environment.orgMember?.user.id,
            userName: getUsername(environment.orgMember?.user),
          },
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
