import parse from "parse-duration";
import { engine as defaultEngine } from "~/v3/runEngine.server";
import type { RunEngine } from "@internal/run-engine";
import { parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import {
  type RunEngineVersion,
  type RuntimeEnvironmentType,
  type WaitpointStatus,
  boundedIn,
} from "@trigger.dev/database";
import { type Direction } from "~/components/ListPagination";
import { type PrismaClientOrTransaction } from "~/db.server";
import { BasePresenter } from "./basePresenter.server";
import { type WaitpointSearchParams } from "~/components/runs/v3/WaitpointTokenFilters";
import { determineEngineVersion } from "~/v3/engineVersion.server";
import { type WaitpointTokenStatus, type WaitpointTokenItem } from "@trigger.dev/core/v3";
import { generateHttpCallbackUrl } from "~/services/httpCallback.server";
import { runStore as defaultRunStore } from "~/v3/runStore.server";

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
  idempotencyKey: string | null;
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
    organizationId?: string;
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
  // `readRoute` is retained only for caller-signature compatibility (see
  // ApiWaitpointListPresenter and the waitpoints-tokens route). Run-graph reads now go
  // through the shared `runStore`, which resolves residency (new vs legacy) itself and
  // reads the single DB when the split is off — so this hint is no longer consulted here.
  constructor(
    prismaClient?: PrismaClientOrTransaction,
    replicaClient?: PrismaClientOrTransaction,
    private readonly readRoute?: {
      runOpsNew?: PrismaClientOrTransaction;
      runOpsLegacyReplica?: PrismaClientOrTransaction;
      splitEnabled?: boolean;
    },
    private readonly runStore = defaultRunStore,
    private readonly waitpointEngine: Pick<
      RunEngine,
      "listStoreManualWaitpoints" | "canReadStoreManualWaitpoints"
    > = defaultEngine
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

    const nativeEligibility = environment.organizationId
      ? this.waitpointEngine.canReadStoreManualWaitpoints(environment.organizationId)
      : false;
    const nativeScope =
      environment.organizationId && nativeEligibility !== false && (await nativeEligibility)
        ? {
            organizationId: environment.organizationId,
            environmentId: environment.id,
            projectId: environment.project.id,
          }
        : undefined;
    // With the store enabled the cursor holds a separate position in each source.
    const cut = nativeScope ? decodeMergedCursor(cursor) : undefined;
    const legacyCursor = cut ? cut.legacy : cursor;
    const native = nativeScope
      ? await this.waitpointEngine.listStoreManualWaitpoints({
          ...nativeScope,
          ...(id ? { id: id.startsWith("waitpoint_") ? id.slice("waitpoint_".length) : id } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(tags?.length ? { tags } : {}),
          ...(statusesToFilter.length ? { statuses: statusesToFilter } : {}),
          outputIsError: filterOutputIsError,
          createdAtGte: createdAtGte?.toISOString(),
          createdAtLte: createdAtLte?.toISOString(),
          cursor: cut?.store,
          direction,
          limit: pageSize + 1,
        })
      : undefined;
    const tokens = await this.#scanWaitpoints(
      () =>
        this.runStore.findManyWaitpoints({
          where: {
            environmentId: environment.id,
            type: "MANUAL",
            ...(legacyCursor
              ? { id: direction === "forward" ? { lt: legacyCursor } : { gt: legacyCursor } }
              : {}),
            ...(id ? { friendlyId: id } : {}),
            ...(statusesToFilter.length ? { status: { in: boundedIn(statusesToFilter) } } : {}),
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

    let next: string | undefined;
    let previous: string | undefined;
    let tokensToReturn: WaitpointRow[];
    if (native && cut) {
      ({
        tokens: tokensToReturn,
        next,
        previous,
      } = mergeStorePage(tokens, native, pageSize, direction, cut, cursor));
    } else {
      const hasMore = tokens.length > pageSize;

      //get cursors for next and previous pages
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

      tokensToReturn =
        direction === "backward" && hasMore
          ? tokens.slice(1, pageSize + 1)
          : tokens.slice(0, pageSize);
    }

    let hasAnyTokens = tokensToReturn.length > 0;
    if (!hasAnyTokens) {
      hasAnyTokens = await this.#probeAnyToken(environment.id);
      if (!hasAnyTokens && nativeScope)
        hasAnyTokens =
          (
            await this.waitpointEngine.listStoreManualWaitpoints({
              ...nativeScope,
              direction: "forward",
              limit: 1,
            })
          ).length > 0;
    }

    return {
      success: true,
      tokens: tokensToReturn.map((token) => ({
        id: token.friendlyId,
        url:
          nativeScope && parseWaitpointId(token.id).format === "b32hexW"
            ? generateHttpCallbackUrl(token.id, environment.apiKey, {
                environmentId: environment.id,
              })
            : generateHttpCallbackUrl(token.id, environment.apiKey),
        status: waitpointStatusToApiStatus(token.status, token.outputIsError),
        completedAt: token.completedAt ?? undefined,
        timeoutAt: token.completedAfter ?? undefined,
        completedAfter: token.completedAfter ?? undefined,
        idempotencyKey: token.userProvidedIdempotencyKey
          ? (token.inactiveIdempotencyKey ?? token.idempotencyKey ?? undefined)
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

  // `runStore` returns the new+legacy union deduped by id but unsorted/unwindowed, so
  // re-apply the page's keyset order + over-fetch window to match a single union scan.
  async #scanWaitpoints(
    scan: () => Promise<WaitpointRow[]>,
    pageSize: number,
    direction: Direction
  ): Promise<WaitpointRow[]> {
    const overfetch = pageSize + 1;
    const rows = await scan();
    rows.sort((a, b) =>
      direction === "forward" ? compareIdDesc(a.id, b.id) : compareIdAsc(a.id, b.id)
    );
    return rows.slice(0, overfetch);
  }

  // Empty-state probe across both residencies (runStore fans out); no single runId.
  async #probeAnyToken(environmentId: string): Promise<boolean> {
    const found = await this.runStore.findWaitpoint({
      where: { environmentId, type: "MANUAL" },
    });
    return Boolean(found);
  }
}

type MergedCut = { legacy?: string; store?: string };

const MERGED_CURSOR_PREFIX = "m.";

// Opaque and URL-safe: "m." + base64url of [legacy id | null, store id | null]. Raw ids contain no ".".
function encodeMergedCursor(legacy: string | undefined, store: string | undefined): string {
  const json = JSON.stringify([legacy ?? null, store ?? null]);
  return MERGED_CURSOR_PREFIX + Buffer.from(json).toString("base64url");
}

function decodeMergedCursor(cursor: string | undefined): MergedCut {
  if (!cursor) return {};
  if (cursor.startsWith(MERGED_CURSOR_PREFIX)) {
    try {
      const raw = cursor.slice(MERGED_CURSOR_PREFIX.length);
      const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString());
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        value.every((part) => part === null || typeof part === "string")
      )
        return { legacy: value[0] ?? undefined, store: value[1] ?? undefined };
    } catch {}
  }
  // A bare id (an old URL, or a client mid-page across a deploy) cuts both sources at it, as before.
  return { legacy: cursor, store: cursor };
}

// Two-way merge of the Postgres and store pages, each in its own id order for `direction` and
// over-fetched by one. Each step takes the newer head (forward) or the older one (backward) by
// createdAt, ties broken by id, so each source is consumed in order and the cut it leaves never
// skips or repeats a token. A missing cut means the start of a source going forward, the end backward.
function mergeStorePage(
  legacy: WaitpointRow[],
  store: WaitpointRow[],
  pageSize: number,
  direction: Direction,
  cut: MergedCut,
  cursor: string | undefined
) {
  const forward = direction === "forward";
  const picked: WaitpointRow[] = [];
  let l = 0;
  let s = 0;
  while (picked.length < pageSize && (l < legacy.length || s < store.length)) {
    const a = legacy[l];
    const b = store[s];
    if (a && (!b || isNewer(a, b) === forward)) picked.push(legacy[l++]);
    else picked.push(store[s++]);
  }
  const hasMore = l < legacy.length || s < store.length;
  // Cut after the last row taken from each source, else the incoming cut.
  const far = encodeMergedCursor(legacy[l - 1]?.id ?? cut.legacy, store[s - 1]?.id ?? cut.store);
  // Cut at the incoming side of each source: its first fetched row, else nothing on that side.
  const near = encodeMergedCursor(legacy[0]?.id, store[0]?.id);
  // shortcut: where one source's id order disagrees with createdAt (cuid and gen-2 ids in one environment, or clock skew), the list follows that source's id order and backward pages can group those tokens differently from forward, each still listed once; carry page-start cuts in the cursor if customers notice.
  return forward
    ? {
        tokens: picked,
        next: hasMore ? far : undefined,
        previous: cursor && picked.length ? near : undefined,
      }
    : {
        tokens: picked.reverse(),
        next: picked.length ? near : undefined,
        previous: hasMore ? far : undefined,
      };
}

function isNewer(a: WaitpointRow, b: WaitpointRow): boolean {
  const diff = a.createdAt.getTime() - b.createdAt.getTime();
  return diff !== 0 ? diff > 0 : a.id > b.id;
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
