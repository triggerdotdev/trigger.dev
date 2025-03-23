import { Prisma, type WaitpointStatus } from "@trigger.dev/database";
import { type Direction } from "~/components/ListPagination";
import { sqlDatabaseSchema } from "~/db.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BasePresenter } from "./basePresenter.server";
import { isWaitpointOutputTimeout } from "@trigger.dev/core/v3/schemas";
import { type WaitpointFilterStatus } from "~/components/runs/v3/WaitpointTokenFilters";

const DEFAULT_PAGE_SIZE = 25;

export type WaitpointTokenListOptions = {
  environment: AuthenticatedEnvironment;
  // filters
  friendlyId?: string;
  statuses?: WaitpointFilterStatus[];
  idempotencyKey?: string;
  tags?: string[];
  from?: number;
  to?: number;
  // pagination
  direction?: Direction;
  cursor?: string;
  pageSize?: number;
};

export class WaitpointTokenListPresenter extends BasePresenter {
  public async call({
    environment,
    friendlyId,
    statuses,
    idempotencyKey,
    tags,
    from,
    to,
    direction = "forward",
    cursor,
    pageSize = DEFAULT_PAGE_SIZE,
  }: WaitpointTokenListOptions) {
    const hasStatusFilters = statuses && statuses.length > 0;

    const hasFilters =
      friendlyId !== undefined ||
      hasStatusFilters ||
      idempotencyKey !== undefined ||
      (tags !== undefined && tags.length > 0) ||
      from !== undefined ||
      to !== undefined;

    let filterOutputIsError: boolean | undefined;
    //if the only status is completed: true
    //if the only status is failed: false
    //otherwise undefined
    if (statuses?.length === 1) {
      if (statuses[0] === "COMPLETED") {
        filterOutputIsError = false;
      } else if (statuses[0] === "FAILED") {
        filterOutputIsError = true;
      }
    }

    const statusesToFilter: WaitpointStatus[] =
      statuses?.map((status) => {
        switch (status) {
          case "PENDING":
            return "PENDING";
          case "COMPLETED":
            return "COMPLETED";
          case "FAILED":
            return "COMPLETED";
        }
      }) ?? [];

    // Get the waitpoint tokens using raw SQL for better performance
    const tokens = await this._replica.$queryRaw<
      {
        id: string;
        friendlyId: string;
        status: WaitpointStatus;
        completedAt: Date | null;
        completedAfter: Date | null;
        outputIsError: boolean;
        idempotencyKey: string;
        idempotencyKeyExpiresAt: Date | null;
        inactiveIdempotencyKey: string | null;
        userProvidedIdempotencyKey: boolean;
        createdAt: Date;
        tags: null | string[];
      }[]
    >`
    SELECT
      w.id,
      w."friendlyId",
      w.status,
      w."completedAt",
      w."completedAfter",
      w."outputIsError",
      w."idempotencyKey",
      w."idempotencyKeyExpiresAt",
      w."inactiveIdempotencyKey",
      w."userProvidedIdempotencyKey",
      w."tags",
      w."createdAt"
    FROM
      ${sqlDatabaseSchema}."Waitpoint" w
    WHERE
      w."environmentId" = ${environment.id}
      AND w.type = 'MANUAL'
      -- cursor
      ${
        cursor
          ? direction === "forward"
            ? Prisma.sql`AND w.id < ${cursor}`
            : Prisma.sql`AND w.id > ${cursor}`
          : Prisma.empty
      }
      -- filters
      ${friendlyId ? Prisma.sql`AND w."friendlyId" = ${friendlyId}` : Prisma.empty}
      ${
        statusesToFilter && statusesToFilter.length > 0
          ? Prisma.sql`AND w.status = ANY(ARRAY[${Prisma.join(
              statusesToFilter
            )}]::"WaitpointStatus"[])`
          : Prisma.empty
      }
      ${
        filterOutputIsError !== undefined
          ? Prisma.sql`AND w."outputIsError" = ${filterOutputIsError}`
          : Prisma.empty
      }
      ${idempotencyKey ? Prisma.sql`AND w."idempotencyKey" = ${idempotencyKey}` : Prisma.empty}
      ${
        from
          ? Prisma.sql`AND w."createdAt" >= ${new Date(from).toISOString()}::timestamp`
          : Prisma.empty
      }
      ${
        to
          ? Prisma.sql`AND w."createdAt" <= ${new Date(to).toISOString()}::timestamp`
          : Prisma.empty
      }
      ${
        tags && tags.length > 0
          ? Prisma.sql`AND w."tags" && ARRAY[${Prisma.join(tags)}]::text[]`
          : Prisma.empty
      }
    ORDER BY
      ${direction === "forward" ? Prisma.sql`w.id DESC` : Prisma.sql`w.id ASC`}
    LIMIT ${pageSize + 1}`;

    const hasMore = tokens.length > pageSize;

    //get cursors for next and previous pages
    let next: string | undefined;
    let previous: string | undefined;
    switch (direction) {
      case "forward":
        previous = cursor ? tokens.at(0)?.id : undefined;
        if (hasMore) {
          next = tokens[pageSize - 1]?.id;
        }
        break;
      case "backward":
        tokens.reverse();
        if (hasMore) {
          previous = tokens[1]?.id;
          next = tokens[pageSize]?.id;
        } else {
          next = tokens[pageSize - 1]?.id;
        }
        break;
    }

    const tokensToReturn =
      direction === "backward" && hasMore
        ? tokens.slice(1, pageSize + 1)
        : tokens.slice(0, pageSize);

    return {
      tokens: tokensToReturn.map((token) => ({
        friendlyId: token.friendlyId,
        status: token.status,
        completedAt: token.completedAt,
        completedAfter: token.completedAfter,
        idempotencyKey: token.userProvidedIdempotencyKey
          ? token.inactiveIdempotencyKey ?? token.idempotencyKey
          : null,
        idempotencyKeyExpiresAt: token.idempotencyKeyExpiresAt,
        tags: token.tags ? token.tags.sort((a, b) => a.localeCompare(b)) : [],
        //we can assume that all errors for tokens are timeouts
        isTimeout: token.outputIsError,
        createdAt: token.createdAt,
      })),
      pagination: {
        next,
        previous,
      },
      filters: {
        friendlyId: friendlyId || undefined,
        statuses: statuses || [],
        idempotencyKey: idempotencyKey || undefined,
        from,
        to,
      },
      hasFilters,
    };
  }
}
