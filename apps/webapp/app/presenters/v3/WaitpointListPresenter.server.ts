import parse from "parse-duration";
import {
  type RunEngineVersion,
  type RuntimeEnvironmentType,
  type WaitpointStatus,
} from "@trigger.dev/database";
import { type Direction } from "~/components/ListPagination";
import { type PrismaClientOrTransaction } from "~/db.server";
import { BasePresenter } from "./basePresenter.server";
import { type WaitpointSearchParams } from "~/components/runs/v3/WaitpointTokenFilters";
import { determineEngineVersion } from "~/v3/engineVersion.server";
import { type WaitpointTokenStatus, type WaitpointTokenItem } from "@trigger.dev/core/v3";
import { generateHttpCallbackUrl } from "~/services/httpCallback.server";

const DEFAULT_PAGE_SIZE = 25;

// Row shape returned by the raw MANUAL-waitpoint keyset scan. Named so both the
// scan closure and the #scanWaitpoints store-selection helper reference one type.
type WaitpointRow = {
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
};

export type WaitpointListOptions = {
  environment: {
    id: string;
    type: RuntimeEnvironmentType;
    project: {
      id: string;
      engine: RunEngineVersion;
    };
    apiKey: string;
  };
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
  // Optional run-ops read-routing. Omitted (single-DB / self-host) => every read
  // goes through `_replica` exactly as today (passthrough). There is NO legacy
  // writer/primary handle by construction — the legacy field is the read replica only.
  constructor(
    prismaClient?: PrismaClientOrTransaction,
    replicaClient?: PrismaClientOrTransaction,
    private readonly readRoute?: {
      runOpsNew?: PrismaClientOrTransaction; // new run-ops client
      runOpsLegacyReplica?: PrismaClientOrTransaction; // legacy run-ops READ REPLICA only — never the legacy primary
      splitEnabled?: boolean; // resolved boot constant
    }
  ) {
    super(prismaClient, replicaClient);
  }

  public async call({
    environment,
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

    let createdAtGte: Date | undefined;
    if (periodMs != null) {
      createdAtGte = new Date(Date.now() - periodMs);
    }
    if (from !== undefined) {
      const fromDate = new Date(from);
      createdAtGte =
        createdAtGte === undefined ? fromDate : fromDate > createdAtGte ? fromDate : createdAtGte;
    }
    const createdAtLte: Date | undefined = to !== undefined ? new Date(to) : undefined;

    const tokens = await this.#scanWaitpoints(
      (client) =>
        client.waitpoint.findMany({
          where: {
            environmentId: environment.id,
            type: "MANUAL",
            ...(cursor ? { id: direction === "forward" ? { lt: cursor } : { gt: cursor } } : {}),
            ...(id ? { friendlyId: id } : {}),
            ...(statusesToFilter.length ? { status: { in: statusesToFilter } } : {}),
            ...(filterOutputIsError !== undefined ? { outputIsError: filterOutputIsError } : {}),
            ...(idempotencyKey
              ? { OR: [{ idempotencyKey }, { inactiveIdempotencyKey: idempotencyKey }] }
              : {}),
            ...(createdAtGte !== undefined || createdAtLte !== undefined
              ? {
                  createdAt: {
                    ...(createdAtGte !== undefined ? { gte: createdAtGte } : {}),
                    ...(createdAtLte !== undefined ? { lte: createdAtLte } : {}),
                  },
                }
              : {}),
            ...(tags && tags.length > 0 ? { tags: { hasSome: tags } } : {}),
          },
          orderBy: { id: direction === "forward" ? "desc" : "asc" },
          take: pageSize + 1,
          select: {
            id: true,
            friendlyId: true,
            status: true,
            completedAt: true,
            completedAfter: true,
            outputIsError: true,
            idempotencyKey: true,
            idempotencyKeyExpiresAt: true,
            inactiveIdempotencyKey: true,
            userProvidedIdempotencyKey: true,
            tags: true,
            createdAt: true,
          },
        }),
      pageSize,
      direction
    );

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
      hasAnyTokens = await this.#probeAnyToken(environment.id);
    }

    return {
      success: true,
      tokens: tokensToReturn.map((token) => ({
        id: token.friendlyId,
        url: generateHttpCallbackUrl(token.id, environment.apiKey),
        status: waitpointStatusToApiStatus(token.status, token.outputIsError),
        completedAt: token.completedAt ?? undefined,
        timeoutAt: token.completedAfter ?? undefined,
        completedAfter: token.completedAfter ?? undefined,
        idempotencyKey: token.userProvidedIdempotencyKey
          ? (token.inactiveIdempotencyKey ?? token.idempotencyKey)
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

  // Run-ops reads for the Waitpoint-token dashboard. Split on: new DB first, then
  // the LEGACY READ REPLICA ONLY for the not-yet-migrated remainder — never the
  // legacy primary. Split off: one plain `_replica` read.
  async #scanWaitpoints(
    scan: (client: PrismaClientOrTransaction) => Promise<WaitpointRow[]>,
    pageSize: number,
    direction: Direction
  ): Promise<WaitpointRow[]> {
    if (!this.readRoute?.splitEnabled) {
      return scan(this._replica);
    }

    const overfetch = pageSize + 1;
    const newRows = await scan(this.readRoute.runOpsNew ?? this._replica);

    // New DB filled the page => any older tokens fall on a later page; keep the
    // legacy read off the hot path. Presence on the new DB is the migrated signal.
    if (newRows.length >= overfetch) {
      return newRows;
    }

    // READ REPLICA handle only (there is no writer/primary field on readRoute).
    const legacyRows = await scan(this.readRoute.runOpsLegacyReplica ?? this._replica);

    // Merge under keyset order: de-dupe by id keeping the new-DB copy as
    // authoritative, re-sort in the page's direction, re-apply the over-fetch
    // window so the result matches a single union scan.
    const byId = new Map<string, WaitpointRow>();
    for (const row of newRows) {
      byId.set(row.id, row);
    }
    for (const row of legacyRows) {
      if (!byId.has(row.id)) {
        byId.set(row.id, row);
      }
    }

    const merged = Array.from(byId.values());
    merged.sort((a, b) =>
      direction === "forward" ? compareIdDesc(a.id, b.id) : compareIdAsc(a.id, b.id)
    );

    return merged.slice(0, overfetch);
  }

  // Empty-state probe: two-handle existence check (no single runId, so not
  // readThroughRun). New DB first, then the LEGACY read replica in split mode so
  // the empty-state never reports false-empty during migration.
  async #probeAnyToken(environmentId: string): Promise<boolean> {
    const onNew = await (this.readRoute?.runOpsNew ?? this._replica).waitpoint.findFirst({
      where: { environmentId, type: "MANUAL" },
    });
    if (onNew) return true;
    if (!this.readRoute?.splitEnabled) return false;
    const onLegacy = await (
      this.readRoute.runOpsLegacyReplica ?? this._replica
    ).waitpoint.findFirst({
      where: { environmentId, type: "MANUAL" },
    });
    return Boolean(onLegacy);
  }
}

function compareIdAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIdDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
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
