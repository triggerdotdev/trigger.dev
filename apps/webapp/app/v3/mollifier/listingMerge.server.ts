import type { BufferEntry } from "@trigger.dev/redis-worker";
import { parsePacket } from "@trigger.dev/core/v3";
import type { Project, RuntimeEnvironment } from "@trigger.dev/database";
import {
  ApiRunListPresenter,
  type ApiRunListSearchParamsType,
} from "~/presenters/v3/ApiRunListPresenter.server";
import { logger } from "~/services/logger.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";
import { deserialiseMollifierSnapshot } from "./mollifierSnapshot.server";
import type { API_VERSIONS } from "~/api/versions";

// Compound cursor encoded as base64-JSON. Wraps the existing PG/ClickHouse
// presenter cursor (`inner`) with a buffer watermark + an
// "we've exhausted the buffer source" flag. Legacy cursors (plain strings
// passed by older SDKs) are treated as `bufferExhausted: true` — those
// clients see PG-only listing, which is the same as today.
export type ListCursor = {
  inner?: string;
  watermark?: { createdAtMicros: number; runId: string };
  bufferExhausted: boolean;
};

export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64");
}

export function decodeListCursor(raw: string | undefined): ListCursor | undefined {
  if (!raw) return undefined;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Record<string, unknown> | null;
    if (
      parsed &&
      typeof parsed === "object" &&
      ("bufferExhausted" in parsed || "watermark" in parsed)
    ) {
      const wm = parsed.watermark as
        | { createdAtMicros: unknown; runId: unknown }
        | undefined;
      const watermark =
        wm && typeof wm.createdAtMicros === "number" && typeof wm.runId === "string"
          ? { createdAtMicros: wm.createdAtMicros, runId: wm.runId }
          : undefined;
      return {
        inner: typeof parsed.inner === "string" ? parsed.inner : undefined,
        watermark,
        bufferExhausted: parsed.bufferExhausted === true,
      };
    }
  } catch {
    // Legacy cursor — opaque to us. Treat the raw value as the inner PG
    // cursor and skip the buffer for this page chain.
  }
  return { inner: raw, bufferExhausted: true };
}

// Tightly-typed input to the buffer fetch. Filters we can honour at the
// snapshot level: `taskIdentifier`. Filters we can't (status not QUEUED,
// batch, schedule, version, region, machine, isTest=false) cause us to
// skip the buffer entirely for that request — those rows can't be in the
// buffer by construction.
export type BufferListingFilters = {
  taskIdentifiers?: string[];
  // The route applies the same status filter to the PG path. If the
  // filter excludes QUEUED-equivalent statuses, we skip the buffer.
  statuses?: string[];
};

export function bufferEligible(filters: BufferListingFilters): boolean {
  if (filters.statuses && filters.statuses.length > 0) {
    // Buffered runs surface as QUEUED externally (Q1). PG-side status
    // mapping converts "QUEUED" → "PENDING" — accept either label.
    const allowed = filters.statuses.some(
      (s) => s === "QUEUED" || s === "PENDING" || s === "DELAYED",
    );
    if (!allowed) return false;
  }
  return true;
}

export type ListDataItem = {
  id: string;
  status: string;
  taskIdentifier: string;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  delayedUntil?: Date;
  isTest: boolean;
  ttl?: string;
  expiredAt?: Date;
  env: { id: string; name: string; user?: string };
  tags: string[];
  costInCents: number;
  baseCostInCents: number;
  durationMs: number;
  depth: number;
  metadata: unknown;
  taskKind: string;
  region?: string;
  version?: string;
  // Booleans set by apiBooleanHelpersFromRunStatus on PG side; for a
  // buffered (always-QUEUED) run we hardcode the same shape.
  isQueued: boolean;
  isExecuting: boolean;
  isCompleted: boolean;
  isWaiting: boolean;
  isFailed: boolean;
  isCancelled: boolean;
  isSuccess: boolean;
};

export async function synthesiseBufferedListItem(input: {
  entry: BufferEntry;
  envSlug: string;
  envUser?: string;
}): Promise<ListDataItem> {
  const snapshot = deserialiseMollifierSnapshot(input.entry.payload);
  const taskIdentifier =
    typeof snapshot.taskIdentifier === "string" ? snapshot.taskIdentifier : "";
  const idempotencyKey =
    typeof snapshot.idempotencyKey === "string" ? snapshot.idempotencyKey : null;
  const tags =
    Array.isArray(snapshot.tags) && snapshot.tags.every((t) => typeof t === "string")
      ? (snapshot.tags as string[])
      : [];
  const metadataStr = typeof snapshot.metadata === "string" ? snapshot.metadata : undefined;
  const metadataType =
    typeof snapshot.metadataType === "string" ? snapshot.metadataType : "application/json";
  const metadata = metadataStr
    ? await parsePacket(
        { data: metadataStr, dataType: metadataType },
        { filteredKeys: ["$$streams", "$$streamsVersion", "$$streamsBaseUrl"] },
      ).catch(() => undefined)
    : undefined;
  const region = typeof snapshot.workerQueue === "string" ? snapshot.workerQueue : undefined;
  const ttl = typeof snapshot.ttl === "string" ? snapshot.ttl : undefined;
  const isTest = snapshot.isTest === true;
  const depth = typeof snapshot.depth === "number" ? snapshot.depth : 0;
  const status = input.entry.status === "FAILED" ? "SYSTEM_FAILURE" : "QUEUED";
  const createdAt = input.entry.createdAt;

  return {
    id: input.entry.runId,
    status,
    taskIdentifier,
    idempotencyKey,
    createdAt,
    updatedAt: createdAt,
    isTest,
    ttl,
    env: { id: input.entry.envId, name: input.envSlug, user: input.envUser },
    tags,
    costInCents: 0,
    baseCostInCents: 0,
    durationMs: 0,
    depth,
    metadata,
    taskKind: "STANDARD",
    region,
    isQueued: status === "QUEUED",
    isExecuting: false,
    isCompleted: status === "SYSTEM_FAILURE",
    isWaiting: false,
    isFailed: status === "SYSTEM_FAILURE",
    isCancelled: false,
    isSuccess: false,
  };
}

// Filter a fetched batch of buffered entries against the request's
// task-identifier filter, then synthesise list items.
export async function buildBufferedListPage(input: {
  envId: string;
  envSlug: string;
  envUser?: string;
  watermark?: { createdAtMicros: number; runId: string };
  pageSize: number;
  filters: BufferListingFilters;
}): Promise<{ items: ListDataItem[]; bufferExhausted: boolean }> {
  if (!bufferEligible(input.filters)) {
    return { items: [], bufferExhausted: true };
  }
  const buffer = getMollifierBuffer();
  if (!buffer) return { items: [], bufferExhausted: true };

  let entries: BufferEntry[];
  try {
    entries = await buffer.listForEnvWithWatermark({
      envId: input.envId,
      watermark: input.watermark,
      pageSize: input.pageSize,
    });
  } catch (err) {
    // Buffer outage shouldn't fail the listing endpoint. Fall back to
    // PG-only for this request.
    logger.warn("mollifier listing: buffer fetch failed; falling back to PG-only", {
      envId: input.envId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { items: [], bufferExhausted: true };
  }

  const taskIdFilter = input.filters.taskIdentifiers;
  const filtered = taskIdFilter
    ? entries.filter((e) => {
        const snapshot = deserialiseMollifierSnapshot(e.payload);
        const taskId = typeof snapshot.taskIdentifier === "string" ? snapshot.taskIdentifier : "";
        return taskIdFilter.includes(taskId);
      })
    : entries;

  const items = await Promise.all(
    filtered.map((entry) =>
      synthesiseBufferedListItem({
        entry,
        envSlug: input.envSlug,
        envUser: input.envUser,
      }),
    ),
  );
  // Buffer is exhausted-for-this-cursor-chain once we returned fewer
  // than pageSize entries. Q1 D4.
  return { items, bufferExhausted: entries.length < input.pageSize };
}

// Wraps `ApiRunListPresenter.call` with mollifier buffer merge.
// Returns the same `{ data, pagination }` shape as the presenter so
// route handlers can substitute this for the bare presenter call without
// any other change. The pagination cursor returned here is the compound
// cursor (base64-JSON of `ListCursor`); old SDKs that pass it back
// unchanged continue to work because we treat unrecognised cursor
// shapes as PG-only legacy and fall back to the inner cursor.
export async function callRunListWithBufferMerge(input: {
  project: Pick<Project, "id">;
  searchParams: ApiRunListSearchParamsType;
  apiVersion: API_VERSIONS;
  environment: Pick<RuntimeEnvironment, "id" | "organizationId" | "slug">;
}): Promise<{
  data: ListDataItem[];
  pagination: { next?: string; previous?: string };
}> {
  const pageSize = input.searchParams["page[size]"] ?? 25;

  // Decode incoming cursor (from page[after]; backward pagination
  // page[before] always skips the buffer because buffer's "newest first"
  // ordering doesn't have a meaningful backwards anchor).
  const rawCursor = input.searchParams["page[after]"];
  const decodedCursor = decodeListCursor(rawCursor);
  const bufferExhausted = decodedCursor?.bufferExhausted ?? false;

  const bufferPage = await buildBufferedListPage({
    envId: input.environment.id,
    envSlug: input.environment.slug,
    watermark: bufferExhausted ? undefined : decodedCursor?.watermark,
    pageSize,
    filters: {
      taskIdentifiers: input.searchParams["filter[taskIdentifier]"],
      statuses: input.searchParams["filter[status]"],
    },
  });

  // Forward to the existing presenter with the inner cursor. If we have
  // buffer items, the presenter will still return up to pageSize PG
  // items — the merge step truncates to pageSize total. This means we
  // over-fetch PG by up to `bufferItems.length`; the cursor we write
  // back accounts for that.
  const innerSearchParams: ApiRunListSearchParamsType = {
    ...input.searchParams,
    "page[after]": decodedCursor?.inner,
  };
  const presenterResult = await new ApiRunListPresenter().call(
    input.project,
    innerSearchParams,
    input.apiVersion,
    input.environment,
  );

  // PG items already match ListDataItem shape (the presenter constructs
  // it). Re-cast.
  const pgItems = presenterResult.data as unknown as ListDataItem[];

  const merged = mergeListings(bufferPage.items, pgItems, pageSize);

  // Build the next cursor. The buffer watermark for page N+1 anchors at
  // the oldest buffer item still in `merged`. The inner cursor is the
  // presenter's own next cursor — close enough; trailing PG items we
  // displaced get bumped by one page, not lost (they re-surface on the
  // page after this one).
  let nextWatermark: ListCursor["watermark"];
  const lastBufferShown = [...merged].reverse().find(
    (item) => bufferPage.items.some((bi) => bi.id === item.id),
  );
  if (lastBufferShown) {
    // We don't carry createdAtMicros through ListDataItem (we only
    // have createdAt: Date). Re-derive from the buffer entry list.
    const entry = bufferPage.items.find((b) => b.id === lastBufferShown.id);
    if (entry) {
      nextWatermark = {
        createdAtMicros: entry.createdAt.getTime() * 1000,
        runId: entry.id,
      };
    }
  }
  const nextCursor: ListCursor = {
    inner: presenterResult.pagination.next,
    watermark: nextWatermark,
    bufferExhausted: bufferPage.bufferExhausted,
  };
  const hasNext =
    !!presenterResult.pagination.next || !bufferPage.bufferExhausted;

  return {
    data: merged,
    pagination: {
      next: hasNext ? encodeListCursor(nextCursor) : undefined,
      previous: presenterResult.pagination.previous,
    },
  };
}

// Merge buffer + PG items by createdAt DESC, dedupe by id, truncate to
// pageSize. Stable on ties via runId DESC (matches the PG cursor
// comparator).
export function mergeListings<T extends { id: string; createdAt: Date }>(
  bufferItems: T[],
  pgItems: T[],
  pageSize: number,
): T[] {
  const seen = new Set<string>();
  const all = [...bufferItems, ...pgItems];
  all.sort((a, b) => {
    const t = b.createdAt.getTime() - a.createdAt.getTime();
    if (t !== 0) return t;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  const out: T[] = [];
  for (const item of all) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= pageSize) break;
  }
  return out;
}
