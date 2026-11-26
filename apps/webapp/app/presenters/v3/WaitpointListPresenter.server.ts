import parse from "parse-duration";
import { engine as defaultEngine } from "~/v3/runEngine.server";
import type { RunEngine } from "@internal/run-engine";
import { base32hexEncode, parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
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
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";
import { waitpointStoreStandaloneTokensEnabled } from "~/v3/utils/waitpointStoreEnabled.server";

const DEFAULT_PAGE_SIZE = 25;
// One list request issues at most 100 MemoryDB commands: the page list, then the empty-state probe.
// Connection upkeep (an eviction-policy check per primary, at most every 30 s) is not counted.
const STORE_LIST_COMMAND_CEILING = 90;
const STORE_PROBE_COMMAND_CEILING = 10;
// An unkeyed store token's createdAt is at most this long after its id time, and never before it.
const STORE_CREATION_WINDOW_MS = 300_000;

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
    organization?: { featureFlags: unknown };
  };
  // filters
  id?: string;
  statuses?: WaitpointTokenStatus[];
  /** Only tokens whose output is (or is not) an error; overrides the one a single status implies. */
  outputIsError?: boolean;
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
    outputIsError,
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

    let filterOutputIsError: boolean | undefined = outputIsError;
    //if the only status is completed: true
    //if the only status is failed: false
    //otherwise undefined
    if (filterOutputIsError === undefined && statuses?.length === 1) {
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
    // The command ceiling, and the short pages it can return, come with standalone store tokens.
    // Cursors keep one format either way, so a toggle between pages continues where it left off.
    const standaloneTokens =
      nativeScope !== undefined &&
      waitpointStoreStandaloneTokensEnabled(
        environment.organization?.featureFlags,
        globalFlagsRegistry.current()
      );
    // With the store enabled the cursor holds a separate position in each source.
    const cut = nativeScope ? decodeMergedCursor(cursor) : undefined;
    const legacyCursor = cut ? cut.legacy : cursor;
    const forward = direction === "forward";
    // Under the ceiling the store walks ids in order, so a date filter starts it at the window edge.
    const storeCursor =
      cut?.store ??
      (!standaloneTokens
        ? undefined
        : forward
          ? createdAtLte && storeIdCore(createdAtLte.getTime() + 1)
          : createdAtGte && storeIdCore(createdAtGte.getTime() - STORE_CREATION_WINDOW_MS));
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
          cursor: storeCursor,
          direction,
          limit: pageSize + 1,
          ...(standaloneTokens ? { commandCeiling: STORE_LIST_COMMAND_CEILING } : {}),
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

    // ...and ends the walk once its next id is past the other edge.
    let storeStop = native?.continueCursor;
    if (storeStop && standaloneTokens) {
      const idTime = storeIdTime(storeStop).getTime();
      if (
        forward
          ? createdAtGte && idTime < createdAtGte.getTime() - STORE_CREATION_WINDOW_MS
          : createdAtLte && idTime > createdAtLte.getTime()
      )
        storeStop = undefined;
    }

    let next: string | undefined;
    let previous: string | undefined;
    let tokensToReturn: WaitpointRow[];
    if (native && cut) {
      ({
        tokens: tokensToReturn,
        next,
        previous,
      } = mergeStorePage(
        tokens,
        native.waitpoints,
        pageSize,
        direction,
        cut,
        cursor,
        storeStop,
        standaloneTokens
      ));
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

    // A merged page that stopped short of the page size still has a cursor to the tokens it leads to.
    let hasAnyTokens = tokensToReturn.length > 0 || (standaloneTokens && (!!next || !!previous));
    if (!hasAnyTokens) {
      hasAnyTokens = await this.#probeAnyToken(environment.id);
      if (!hasAnyTokens && nativeScope) {
        const probe = await this.waitpointEngine.listStoreManualWaitpoints({
          ...nativeScope,
          direction: "forward",
          limit: 1,
          ...(standaloneTokens ? { commandCeiling: STORE_PROBE_COMMAND_CEILING } : {}),
        });
        hasAnyTokens = probe.waitpoints.length > 0 || probe.continueCursor !== undefined;
      }
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
  cursor: string | undefined,
  // Where the store list stopped at its command ceiling; store tokens past it are not yet known.
  storeStop: string | undefined,
  // A command ceiling is in force, so a page, or the page after it, can be short or empty.
  shortPages: boolean
) {
  const forward = direction === "forward";
  // The latest createdAt an unseen store token can have: going forward, one minted before the stop
  // can be created up to the creation window after it; going backward, none before its id time.
  const stop = storeStop
    ? {
        id: storeStop,
        createdAt: new Date(
          storeIdTime(storeStop).getTime() + (forward ? STORE_CREATION_WINDOW_MS : 0)
        ),
      }
    : undefined;
  const picked: WaitpointRow[] = [];
  let l = 0;
  let s = 0;
  while (picked.length < pageSize && (l < legacy.length || s < store.length)) {
    const a = legacy[l];
    const b = store[s] ?? stop;
    if (a && (!b || isNewer(a, b) === forward)) picked.push(legacy[l++]);
    else if (s < store.length) picked.push(store[s++]);
    else break;
  }
  const hasMore = l < legacy.length || s < store.length || stop !== undefined;
  // Cut after the last row taken from each source, else the incoming cut. A store list that stopped
  // resumes from its stop once every store row it returned is on the page.
  const far = encodeMergedCursor(
    legacy[l - 1]?.id ?? cut.legacy,
    stop && s === store.length ? stop.id : (store[s - 1]?.id ?? cut.store)
  );
  // Cut at the incoming side of each source: its first fetched row, else its stop, else nothing.
  const near = encodeMergedCursor(legacy[0]?.id, store[0]?.id ?? stop?.id);
  // shortcut: where one source's id order disagrees with createdAt (cuid and gen-2 ids in one environment, or clock skew), the list follows that source's id order and backward pages can group those tokens differently from forward, each still listed once; carry page-start cuts in the cursor if customers notice.
  return forward
    ? {
        tokens: picked,
        next: hasMore ? far : undefined,
        // Under a ceiling an empty page still links back.
        previous: cursor && (picked.length || shortPages) ? near : undefined,
      }
    : {
        tokens: picked.reverse(),
        next: picked.length || (cursor && shortPages) ? near : undefined,
        previous: hasMore ? far : undefined,
      };
}

function storeIdTime(id: string): Date {
  const parsed = parseWaitpointId(id);
  if (parsed.format !== "b32hexW")
    throw new Error("Waitpoint store list stopped at a non-store id");
  return parsed.timestamp;
}

// The 24-character id core for a millisecond time with zero random bytes: below every id minted after it.
function storeIdCore(ms: number): string {
  const core = new Uint8Array(15);
  let time = Math.min(Math.max(ms, 0), 2 ** 48 - 1);
  for (let i = 5; i >= 0; i--) {
    core[i] = time % 256;
    time = Math.floor(time / 256);
  }
  return base32hexEncode(core);
}

function isNewer(
  a: Pick<WaitpointRow, "id" | "createdAt">,
  b: Pick<WaitpointRow, "id" | "createdAt">
): boolean {
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
