import { TaskAttemptStatus, TaskRunAttemptStatus } from "@trigger.dev/database";
import { Direction } from "~/components/runs/RunStatuses";
import { PrismaClient, prisma } from "~/db.server";
import { getUsername } from "~/utils/username";

type RunListOptions = {
  userId: string;
  projectSlug: string;
  //filters
  taskSlugs: string[] | undefined;
  versions: string[] | undefined;
  statuses: TaskAttemptStatus[] | undefined;
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

export class RunListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    taskSlugs,
    versions,
    statuses,
    environments,
    from,
    to,
    direction = "forward",
    cursor,
    pageSize = DEFAULT_PAGE_SIZE,
  }: RunListOptions) {
    const directionMultiplier = direction === "forward" ? 1 : -1;

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

    //events
    const runs = await this.#prismaClient.$queryRaw<
      {
        id: string;
        runFriendlyId: string;
        taskIdentifier: string;
        version: string | null;
        runtimeEnvironmentId: string;
        status: TaskRunAttemptStatus | null;
        createdAt: Date;
        startedAt: Date | null;
        completedAt: Date | null;
        attempts: BigInt;
      }[]
    >`
    SELECT
    tr.id,
    tr."friendlyId" AS "runFriendlyId",
    tr."taskIdentifier" AS "taskIdentifier",
    bw.version AS version,
    tr."runtimeEnvironmentId" AS "runtimeEnvironmentId",
    tra.status AS status,
    tr."createdAt" AS "createdAt",
    tra."startedAt" AS "startedAt",
    tra."completedAt" AS "completedAt",
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
      -- AND tr.id > 'clskddbac00337chuo60ollaq'
      -- filters
      AND tr."taskIdentifier" = 'child-task'
      AND bw."version" IN ('20240213.1')
      AND tra.status IN ('COMPLETED', 'FAILED')
      AND tr."runtimeEnvironmentId" IN ('clsk5dfbf000h7cn1quldxv6t')
      AND tr."createdAt" > '2024-02-13 12:58:40'
      AND tr."createdAt" < '2024-02-14 12:58:40'
  GROUP BY
    tr."friendlyId", tr."taskIdentifier", tr."runtimeEnvironmentId", tr.id, bw.version, tra.status, tr."createdAt", tra."startedAt", tra."completedAt"
  ORDER BY
    -- direction
    tr.id ASC
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
          number: 1,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          isTest: false,
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
    };
  }
}
