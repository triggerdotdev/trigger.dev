import parse from "parse-duration";
import {
  Prisma,
  type WaitpointResolver,
  type RunEngineVersion,
  type RuntimeEnvironmentType,
  type WaitpointStatus,
} from "@trigger.dev/database";
import { type Direction } from "~/components/ListPagination";
import { sqlDatabaseSchema } from "~/db.server";
import { BasePresenter } from "./basePresenter.server";
import { type WaitpointSearchParams } from "~/components/runs/v3/WaitpointTokenFilters";
import { determineEngineVersion } from "~/v3/engineVersion.server";
import { type WaitpointTokenStatus, type WaitpointTokenItem } from "@trigger.dev/core/v3";

const DEFAULT_PAGE_SIZE = 25;

export type WaitpointListOptions = {
  environment: {
    id: string;
    type: RuntimeEnvironmentType;
    project: {
      id: string;
      engine: RunEngineVersion;
    };
  };
  resolver: WaitpointResolver;
  // filters
  id?: string;
  statuses?: WaitpointTokenStatus[];
  idempotencyKey?: string;
  tags?: string[];
  period?: string;
  from?: number;
  to?: number;
  // pagination
  direction?: Direction;
  cursor?: string;
  pageSize?: number;
};

type Result =
  | {
      success: true;
      tokens: WaitpointTokenItem[];
      pagination: {
        next: string | undefined;
        previous: string | undefined;
      };
      hasFilters: boolean;
      hasAnyTokens: boolean;
      filters: WaitpointSearchParams;
    }
  | {
      success: false;
      code: "ENGINE_VERSION_MISMATCH" | "UNKNOWN";
      error: string;
      tokens: [];
      pagination: {
        next: undefined;
        previous: undefined;
      };
      hasFilters: false;
      hasAnyTokens: false;
      filters: undefined;
    };

export class WaitpointListPresenter extends BasePresenter {
  public async call({
    environment,
    resolver,
    id,
    statuses,
    idempotencyKey,
    tags,
    period,
    from,
    to,
    direction = "forward",
    cursor,
    pageSize = DEFAULT_PAGE_SIZE,
  }: WaitpointListOptions): Promise<Result> {
    const engineVersion = await determineEngineVersion({ environment });
    if (engineVersion === "V1") {
      return {
        success: false,
        code: "ENGINE_VERSION_MISMATCH",
        error: "Upgrade to SDK version 4+ to use Waitpoint tokens.",
        tokens: [],
        pagination: {
          next: undefined,
          previous: undefined,
        },
        hasFilters: false,
        hasAnyTokens: false,
        filters: undefined,
      };
    }

    const hasStatusFilters = statuses && statuses.length > 0;

    const hasFilters =
      id !== undefined ||
      hasStatusFilters ||
      idempotencyKey !== undefined ||
      (tags !== undefined && tags.length > 0) ||
      (period !== undefined && period !== "all") ||
      from !== undefined ||
      to !== undefined;

    let filterOutputIsError: boolean | undefined;
    //if the only status is completed: true
    //if the only status is failed: false
    //otherwise undefined
    if (statuses?.length === 1) {
      if (statuses[0] === "COMPLETED") {
        filterOutputIsError = false;
      } else if (statuses[0] === "TIMED_OUT") {
        filterOutputIsError = true;
      }
    }

    const statusesToFilter: WaitpointStatus[] =
      statuses?.map((status) => {
        switch (status) {
          case "WAITING":
            return "PENDING";
          case "COMPLETED":
            return "COMPLETED";
          case "TIMED_OUT":
            return "COMPLETED";
        }
      }) ?? [];

    const periodMs = period ? parse(period) : undefined;

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
      AND w.resolver = ${resolver}::"WaitpointResolver"
      -- cursor
      ${
        cursor
          ? direction === "forward"
            ? Prisma.sql`AND w.id < ${cursor}`
            : Prisma.sql`AND w.id > ${cursor}`
          : Prisma.empty
      }
      -- filters
      ${id ? Prisma.sql`AND w."friendlyId" = ${id}` : Prisma.empty}
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
      ${
        idempotencyKey
          ? Prisma.sql`AND (w."idempotencyKey" = ${idempotencyKey} OR w."inactiveIdempotencyKey" = ${idempotencyKey})`
          : Prisma.empty
      }
      ${
        periodMs
          ? Prisma.sql`AND w."createdAt" >= NOW() - INTERVAL '1 millisecond' * ${periodMs}`
          : Prisma.empty
      }
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

    let hasAnyTokens = tokensToReturn.length > 0;
    if (!hasAnyTokens) {
      const firstToken = await this._replica.waitpoint.findFirst({
        where: {
          environmentId: environment.id,
          resolver,
        },
      });

      if (firstToken) {
        hasAnyTokens = true;
      }
    }

    return {
      success: true,
      tokens: tokensToReturn.map((token) => ({
        id: token.friendlyId,
        status: waitpointStatusToApiStatus(token.status, token.outputIsError),
        completedAt: token.completedAt ?? undefined,
        timeoutAt: token.completedAfter ?? undefined,
        completedAfter: token.completedAfter ?? undefined,
        idempotencyKey: token.userProvidedIdempotencyKey
          ? token.inactiveIdempotencyKey ?? token.idempotencyKey
          : undefined,
        idempotencyKeyExpiresAt: token.idempotencyKeyExpiresAt ?? undefined,
        tags: token.tags ? token.tags.sort((a, b) => a.localeCompare(b)) : [],
        createdAt: token.createdAt,
      })),
      pagination: {
        next,
        previous,
      },
      hasFilters,
      hasAnyTokens,
      filters: {
        id,
        statuses: statuses?.length ? statuses : undefined,
        tags: tags?.length ? tags : undefined,
        idempotencyKey,
        period,
        from,
        to,
        cursor,
        direction,
      },
    };
  }
}

export function waitpointStatusToApiStatus(
  status: WaitpointStatus,
  outputIsError: boolean
): WaitpointTokenStatus {
  switch (status) {
    case "PENDING":
      return "WAITING";
    case "COMPLETED":
      return outputIsError ? "TIMED_OUT" : "COMPLETED";
  }
}
