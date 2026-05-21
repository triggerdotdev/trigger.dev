import type { TaskRunStatus } from "@trigger.dev/database";
import parseDuration from "parse-duration";
import { deserialiseSnapshot, type MollifierBuffer } from "@trigger.dev/redis-worker";
import type { NextRunList, NextRunListItem } from "~/presenters/v3/NextRunListPresenter.server";
import { logger } from "~/services/logger.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";

// Subset of the dashboard's runs-list filters that we can evaluate
// against a buffer snapshot. Filters that depend on PG-only fields
// (versions, batchId, bulkId, scheduleId, etc.) are silently ignored —
// a buffered run can't match those anyway.
export type DashboardBufferedFilters = {
  tasks?: string[];
  tags?: string[];
  statuses?: TaskRunStatus[];
  period?: string;
  from?: number;
  to?: number;
  isTest?: boolean;
  runId?: string[];
};

type BufferEntryLike = { runId: string; createdAt: Date };

function matchesFilter(
  snapshot: Record<string, unknown>,
  entry: BufferEntryLike,
  filters: DashboardBufferedFilters,
): boolean {
  if (filters.tasks?.length) {
    const taskId = snapshot.taskIdentifier;
    if (typeof taskId !== "string" || !filters.tasks.includes(taskId)) return false;
  }

  // A buffered run is functionally QUEUED / PENDING — when the filter
  // restricts statuses we only match if those are wanted.
  if (filters.statuses?.length) {
    const bufferedStatuses: TaskRunStatus[] = ["PENDING", "QUEUED" as TaskRunStatus];
    if (!filters.statuses.some((s) => bufferedStatuses.includes(s))) return false;
  }

  if (filters.tags?.length) {
    const snapshotTags = Array.isArray(snapshot.tags) ? snapshot.tags : [];
    const overlap = filters.tags.some((t) => snapshotTags.includes(t));
    if (!overlap) return false;
  }

  if (filters.period) {
    const ms = parseDuration(filters.period);
    if (typeof ms === "number" && ms > 0) {
      const earliest = Date.now() - ms;
      if (entry.createdAt.getTime() < earliest) return false;
    }
  } else if (typeof filters.from === "number" || typeof filters.to === "number") {
    const t = entry.createdAt.getTime();
    if (typeof filters.from === "number" && t < filters.from) return false;
    if (typeof filters.to === "number" && t > filters.to) return false;
  }

  if (typeof filters.isTest === "boolean") {
    if (snapshot.isTest !== filters.isTest) return false;
  }

  if (filters.runId?.length) {
    if (!filters.runId.includes(entry.runId)) return false;
  }

  return true;
}

function snapshotToNextRunListItem(
  entry: BufferEntryLike,
  snapshot: Record<string, unknown>,
  environment: NextRunListItem["environment"],
): NextRunListItem {
  const cancelledAtRaw = typeof snapshot.cancelledAt === "string" ? snapshot.cancelledAt : undefined;
  const cancelled = !!cancelledAtRaw;
  const queueRaw = typeof snapshot.queue === "string" ? snapshot.queue : "task/";
  const tags = Array.isArray(snapshot.tags)
    ? (snapshot.tags as unknown[]).filter((t): t is string => typeof t === "string").sort((a, b) => a.localeCompare(b))
    : [];
  return {
    id: entry.runId,
    number: 1,
    friendlyId: entry.runId,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: cancelledAtRaw ?? entry.createdAt.toISOString(),
    startedAt: undefined,
    delayUntil: undefined,
    hasFinished: cancelled,
    finishedAt: cancelledAtRaw,
    isTest: snapshot.isTest === true,
    status: cancelled ? ("CANCELED" as TaskRunStatus) : ("PENDING" as TaskRunStatus),
    version: undefined,
    taskIdentifier: typeof snapshot.taskIdentifier === "string" ? snapshot.taskIdentifier : "",
    spanId: typeof snapshot.spanId === "string" ? snapshot.spanId : "",
    isReplayable: true,
    isCancellable: !cancelled,
    isPending: !cancelled,
    environment,
    idempotencyKey: typeof snapshot.idempotencyKey === "string" ? snapshot.idempotencyKey : undefined,
    ttl: typeof snapshot.ttl === "string" ? snapshot.ttl : undefined,
    expiredAt: undefined,
    costInCents: 0,
    baseCostInCents: 0,
    usageDurationMs: 0,
    tags,
    depth: typeof snapshot.depth === "number" ? snapshot.depth : 0,
    rootTaskRunId: null,
    metadata: typeof snapshot.metadata === "string" ? snapshot.metadata : null,
    metadataType: typeof snapshot.metadataType === "string" ? snapshot.metadataType : null,
    machinePreset: typeof snapshot.machine === "string" ? snapshot.machine : undefined,
    queue: {
      name: queueRaw.replace("task/", ""),
      type: queueRaw.startsWith("task/") ? "task" : "custom",
    },
    region: typeof snapshot.workerQueue === "string" ? snapshot.workerQueue : undefined,
    taskKind: "STANDARD",
  };
}

export type MergeBufferedIntoDashboardListInput = {
  baseList: NextRunList;
  envId: string;
  filters: DashboardBufferedFilters;
  pageSize: number;
  // Opaque incoming cursor from the URL. Decoded as the compound shape
  // below when present; otherwise treated as a legacy PG-only cursor.
  cursor?: string;
  maxBufferedRuns?: number;
};

export type MergeBufferedIntoDashboardListDeps = {
  getBuffer?: () => MollifierBuffer | null;
};

const DEFAULT_MAX_BUFFERED_RUNS = 500;

// Compound cursor written into the runs list URL. `bufferOffset` is the
// number of buffered entries already consumed by previous pages;
// `bufferExhausted` short-circuits the buffer scan on subsequent pages
// once we've handed out everything in the buffer. `inner` is the PG
// presenter's own cursor (opaque to this layer).
type DashboardListCursor = {
  inner?: string;
  bufferOffset: number;
  bufferExhausted: boolean;
};

function encodeCursor(c: DashboardListCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): DashboardListCursor | undefined {
  if (!raw) return undefined;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.bufferOffset === "number" &&
      typeof parsed.bufferExhausted === "boolean" &&
      (parsed.inner === undefined || typeof parsed.inner === "string")
    ) {
      return parsed as DashboardListCursor;
    }
  } catch {
    // Falls through to "legacy" — the caller should treat the raw value
    // as a PG-only cursor.
  }
  return undefined;
}

// Surface the encode/decode helpers so the loader can carry the
// compound cursor through to the presenter's `cursor` parameter.
export const dashboardListCursor = {
  encode: encodeCursor,
  decode: decodeCursor,
};

// Prepend buffered runs to the dashboard's runs list so customers see
// their freshly-triggered runs immediately, even while the gate is
// diverting traffic. Entries are scanned for env, filtered, shaped into
// NextRunListItem, and merged with the PG presenter result. The merged
// list is truncated to `pageSize` and a compound cursor is written for
// the next page so buffered entries that overflow page N show up on
// page N+1, transitioning into mixed PG content once the buffer is
// exhausted.
export async function mergeBufferedIntoDashboardList(
  input: MergeBufferedIntoDashboardListInput,
  deps: MergeBufferedIntoDashboardListDeps = {},
): Promise<NextRunList> {
  const buffer = (deps.getBuffer ?? getMollifierBuffer)();
  if (!buffer) return input.baseList;

  const cursor = decodeCursor(input.cursor);
  const bufferOffset = cursor?.bufferOffset ?? 0;
  const bufferExhausted = cursor?.bufferExhausted ?? false;

  if (bufferExhausted) {
    return input.baseList;
  }

  const maxBuffered = input.maxBufferedRuns ?? DEFAULT_MAX_BUFFERED_RUNS;
  let entries;
  try {
    entries = await buffer.listEntriesForEnv(input.envId, maxBuffered);
  } catch (err) {
    logger.warn("dashboard buffered list merge failed", {
      envId: input.envId,
      err: err instanceof Error ? err.message : String(err),
    });
    return input.baseList;
  }
  if (entries.length === 0) return input.baseList;

  const environment: NextRunListItem["environment"] = input.baseList.runs[0]?.environment ?? {
    id: input.envId,
    type: "DEVELOPMENT",
    slug: "dev",
    userId: undefined,
    userName: undefined,
  } as NextRunListItem["environment"];

  const matchedBuffered: NextRunListItem[] = [];
  for (const entry of entries) {
    let snapshot: Record<string, unknown>;
    try {
      snapshot = deserialiseSnapshot(entry.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!matchesFilter(snapshot, entry, input.filters)) continue;
    matchedBuffered.push(snapshotToNextRunListItem(entry, snapshot, environment));
  }

  // Sort buffered newest-first so they appear above PG rows in the merged page.
  matchedBuffered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Slice off entries already consumed by previous pages.
  const pageBuffered = matchedBuffered.slice(bufferOffset, bufferOffset + input.pageSize);
  const newBufferOffset = bufferOffset + pageBuffered.length;
  const newBufferExhausted = newBufferOffset >= matchedBuffered.length;

  // Determine how many PG rows to show on this page. The presenter was
  // already invoked with the inner cursor; we take its first
  // (pageSize - pageBuffered.length) rows.
  const remainingSlots = Math.max(0, input.pageSize - pageBuffered.length);
  const pgRows = input.baseList.runs.slice(0, remainingSlots);
  const pgPartiallyConsumed = pgRows.length < input.baseList.runs.length;

  // Cursor for the next page: if we've shown all PG rows the presenter
  // returned, propagate the presenter's next cursor; otherwise reuse
  // the *current* inner cursor so the presenter re-fetches from the
  // same anchor and the unread PG rows show up next page.
  const nextInner = pgPartiallyConsumed
    ? cursor?.inner
    : input.baseList.pagination.next;

  const merged = [...pageBuffered, ...pgRows];
  const hasMoreBuffered = !newBufferExhausted;
  const hasMorePg = !!nextInner;

  const next =
    hasMoreBuffered || hasMorePg
      ? encodeCursor({
          inner: nextInner,
          bufferOffset: newBufferOffset,
          bufferExhausted: newBufferExhausted,
        })
      : undefined;

  return {
    ...input.baseList,
    runs: merged,
    hasAnyRuns: input.baseList.hasAnyRuns || merged.length > 0,
    pagination: {
      next,
      previous: input.baseList.pagination.previous,
    },
  };
}
