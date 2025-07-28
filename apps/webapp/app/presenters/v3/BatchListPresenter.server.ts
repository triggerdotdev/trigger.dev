import { type BatchTaskRunStatus, Prisma } from "@trigger.dev/database";
import parse from "parse-duration";
import { sqlDatabaseSchema } from "~/db.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { BasePresenter } from "./basePresenter.server";
import { type Direction } from "~/components/ListPagination";
import { timeFilters } from "~/components/runs/v3/SharedFilters";

export type BatchListOptions = {
  userId?: string;
  projectId: string;
  environmentId: string;
  //filters
  friendlyId?: string;
  statuses?: BatchTaskRunStatus[];
  period?: string;
  from?: number;
  to?: number;
  //pagination
  direction?: Direction;
  cursor?: string;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 25;

export type BatchList = Awaited<ReturnType<BatchListPresenter["call"]>>;
export type BatchListItem = BatchList["batches"][0];
export type BatchListAppliedFilters = BatchList["filters"];

export class BatchListPresenter extends BasePresenter {
  public async call({
    userId,
    projectId,
    friendlyId,
    statuses,
    environmentId,
    period,
    from,
    to,
    direction = "forward",
    cursor,
    pageSize = DEFAULT_PAGE_SIZE,
  }: BatchListOptions) {
    //get the time values from the raw values (including a default period)
    const time = timeFilters({
      period,
      from,
      to,
    });

    const hasStatusFilters = statuses && statuses.length > 0;

    const hasFilters = hasStatusFilters || friendlyId !== undefined || !time.isDefault;

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

    const periodMs = time.period ? parse(time.period) : undefined;

    //get the batches
    const batches = await this._replica.$queryRaw<
      {
        id: string;
        friendlyId: string;
        runtimeEnvironmentId: string;
        status: BatchTaskRunStatus;
        createdAt: Date;
        updatedAt: Date;
        completedAt: Date | null;
        runCount: BigInt;
        batchVersion: string;
      }[]
    >`
    SELECT
    b.id,
    b."friendlyId",
    b."runtimeEnvironmentId",
    b.status,
    b."createdAt",
    b."updatedAt",
    b."completedAt",
    b."runCount",
    b."batchVersion"
FROM
    ${sqlDatabaseSchema}."BatchTaskRun" b
WHERE
    -- environment
    b."runtimeEnvironmentId" = ${environmentId}
    -- cursor
    ${
      cursor
        ? direction === "forward"
          ? Prisma.sql`AND b.id < ${cursor}`
          : Prisma.sql`AND b.id > ${cursor}`
        : Prisma.empty
    }
    -- filters
    ${friendlyId ? Prisma.sql`AND b."friendlyId" = ${friendlyId}` : Prisma.empty}
    ${
      statuses && statuses.length > 0
        ? Prisma.sql`AND b.status = ANY(ARRAY[${Prisma.join(
            statuses
          )}]::"BatchTaskRunStatus"[]) AND b."batchVersion" <> 'v1'`
        : Prisma.empty
    }
    ${
      periodMs
        ? Prisma.sql`AND b."createdAt" >= NOW() - INTERVAL '1 millisecond' * ${periodMs}`
        : Prisma.empty
    }
    ${
      time.from
        ? Prisma.sql`AND b."createdAt" >= ${time.from.toISOString()}::timestamp`
        : Prisma.empty
    }
    ${time.to ? Prisma.sql`AND b."createdAt" <= ${time.to.toISOString()}::timestamp` : Prisma.empty}
    ORDER BY
        ${direction === "forward" ? Prisma.sql`b.id DESC` : Prisma.sql`b.id ASC`}
    LIMIT ${pageSize + 1}`;

    const hasMore = batches.length > pageSize;

    //get cursors for next and previous pages
    let next: string | undefined;
    let previous: string | undefined;
    switch (direction) {
      case "forward":
        previous = cursor ? batches.at(0)?.id : undefined;
        if (hasMore) {
          next = batches[pageSize - 1]?.id;
        }
        break;
      case "backward":
        batches.reverse();
        if (hasMore) {
          previous = batches[1]?.id;
          next = batches[pageSize]?.id;
        } else {
          next = batches[pageSize - 1]?.id;
        }
        break;
    }

    const batchesToReturn =
      direction === "backward" && hasMore
        ? batches.slice(1, pageSize + 1)
        : batches.slice(0, pageSize);

    let hasAnyBatches = batchesToReturn.length > 0;
    if (!hasAnyBatches) {
      const firstBatch = await this._replica.batchTaskRun.findFirst({
        where: {
          runtimeEnvironmentId: environmentId,
        },
      });

      if (firstBatch) {
        hasAnyBatches = true;
      }
    }

    return {
      batches: batchesToReturn.map((batch) => {
        const environment = project.environments.find(
          (env) => env.id === batch.runtimeEnvironmentId
        );

        if (!environment) {
          throw new Error(`Environment not found for Batch ${batch.id}`);
        }

        const hasFinished = batch.status !== "PENDING";

        return {
          id: batch.id,
          friendlyId: batch.friendlyId,
          createdAt: batch.createdAt.toISOString(),
          updatedAt: batch.updatedAt.toISOString(),
          hasFinished,
          finishedAt: batch.completedAt
            ? batch.completedAt.toISOString()
            : hasFinished
            ? batch.updatedAt.toISOString()
            : undefined,
          status: batch.status,
          environment: displayableEnvironment(environment, userId),
          runCount: Number(batch.runCount),
          batchVersion: batch.batchVersion,
        };
      }),
      pagination: {
        next,
        previous,
      },
      filters: {
        friendlyId,
        statuses: statuses || [],
      },
      hasFilters,
      hasAnyBatches,
    };
  }
}
