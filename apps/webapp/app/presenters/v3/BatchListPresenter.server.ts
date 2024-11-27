import { BatchTaskRunStatus, Prisma } from "@trigger.dev/database";
import parse from "parse-duration";
import { type Direction } from "~/components/runs/RunStatuses";
import { sqlDatabaseSchema } from "~/db.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { BasePresenter } from "./basePresenter.server";

export type BatchListOptions = {
  userId?: string;
  projectId: string;
  //filters
  friendlyId?: string;
  statuses?: BatchTaskRunStatus[];
  environments?: string[];
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
    environments,
    period,
    from,
    to,
    direction = "forward",
    cursor,
    pageSize = DEFAULT_PAGE_SIZE,
  }: BatchListOptions) {
    const hasStatusFilters = statuses && statuses.length > 0;

    const hasFilters =
      hasStatusFilters ||
      (environments !== undefined && environments.length > 0) ||
      (period !== undefined && period !== "all") ||
      friendlyId !== undefined ||
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
        id: projectId,
      },
    });

    let environmentIds = project.environments.map((e) => e.id);
    if (environments && environments.length > 0) {
      //if environments are passed in, we only include them if they're in the project
      environmentIds = environments.filter((e) => project.environments.some((pe) => pe.id === e));
    }

    if (environmentIds.length === 0) {
      throw new Error("No matching environments found for the project");
    }

    const periodMs = period ? parse(period) : undefined;

    //get the batches
    const batches = await this._replica.$queryRaw<
      {
        id: string;
        friendlyId: string;
        runtimeEnvironmentId: string;
        status: BatchTaskRunStatus;
        createdAt: Date;
        updatedAt: Date;
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
    b."runCount",
    b."batchVersion"
FROM
    ${sqlDatabaseSchema}."BatchTaskRun" b
WHERE
    -- environments
    b."runtimeEnvironmentId" IN (${Prisma.join(environmentIds)})
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
      from
        ? Prisma.sql`AND b."createdAt" >= ${new Date(from).toISOString()}::timestamp`
        : Prisma.empty
    }
    ${to ? Prisma.sql`AND b."createdAt" <= ${new Date(to).toISOString()}::timestamp` : Prisma.empty}
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

    return {
      batches: batchesToReturn.map((batch) => {
        const environment = project.environments.find(
          (env) => env.id === batch.runtimeEnvironmentId
        );

        if (!environment) {
          throw new Error(`Environment not found for Batch ${batch.id}`);
        }

        const hasFinished = batch.status === "COMPLETED";

        return {
          id: batch.id,
          friendlyId: batch.friendlyId,
          createdAt: batch.createdAt.toISOString(),
          updatedAt: batch.updatedAt.toISOString(),
          hasFinished,
          finishedAt: hasFinished ? batch.updatedAt.toISOString() : undefined,
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
        environments: environments || [],
        from,
        to,
      },
      hasFilters,
    };
  }
}
