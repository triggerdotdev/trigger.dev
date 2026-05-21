import type { TaskRunStatus, PrismaClientOrTransaction, TaskRun } from "@trigger.dev/database";
import parseDuration from "parse-duration";
import { deserialiseSnapshot, type MollifierBuffer } from "@trigger.dev/redis-worker";
import { logger } from "~/services/logger.server";
import { findRunByIdWithMollifierFallback } from "./readFallback.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";
import { mutateWithFallback } from "./mutateWithFallback.server";
import { ReplayTaskRunService } from "~/v3/services/replayTaskRun.server";

// Subset of `RunListInputFilters` that we can evaluate against a buffer
// snapshot. Filters that depend on PG-only fields (versions, batchId,
// bulkId, scheduleId, etc.) are silently ignored — a buffered run cannot
// match those anyway because it has no PG row yet.
export type BufferedBulkActionFilters = {
  tasks?: string[];
  tags?: string[];
  statuses?: TaskRunStatus[];
  period?: string;
  from?: number;
  to?: number;
  isTest?: boolean;
  runId?: string[];
};

export type BufferedBulkActionContext = {
  envId: string;
  organizationId: string;
  filters: BufferedBulkActionFilters;
  // Cap on buffered runs to scan per env. The ZSET is bounded by the
  // mollifier hold window × trigger rate; this cap protects against an
  // operator running a wide-open bulk-cancel against an env mid-burst.
  maxBufferedRuns?: number;
};

const DEFAULT_MAX_BUFFERED_RUNS = 1000;

// Read-side filter applied to a deserialised buffer snapshot. Mirrors the
// equivalent predicates the ClickHouse query uses for PG-resident runs
// so the bulk action's intended scope is honoured for buffered runs too.
function matchesFilter(
  snapshot: Record<string, unknown>,
  entry: { runId: string; createdAt: Date; envId: string },
  filters: BufferedBulkActionFilters,
): boolean {
  // task identifier
  if (filters.tasks?.length) {
    const taskId = snapshot.taskIdentifier;
    if (typeof taskId !== "string" || !filters.tasks.includes(taskId)) return false;
  }

  // statuses — a buffered run is functionally QUEUED / PENDING. Include
  // the buffered run only if one of those is in the filter, or the filter
  // is omitted (all statuses).
  if (filters.statuses?.length) {
    const bufferedStatuses: TaskRunStatus[] = ["PENDING", "QUEUED" as TaskRunStatus];
    if (!filters.statuses.some((s) => bufferedStatuses.includes(s))) return false;
  }

  // tags — match if ANY of the requested tags is on the snapshot. The
  // PG-side filter uses the same OR semantics.
  if (filters.tags?.length) {
    const snapshotTags = Array.isArray(snapshot.tags) ? snapshot.tags : [];
    const overlap = filters.tags.some((t) => snapshotTags.includes(t));
    if (!overlap) return false;
  }

  // time range — period takes precedence over from/to per the parser.
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

export type BufferedBulkActionResult = { successCount: number; failureCount: number };

// Pluggable taskRun reader for the mutateWithFallback PG-first lookup.
// Match the shape mutateWithFallback's `TaskRunReader` expects without
// importing the type so tests can supply a tiny stub.
type TaskRunReader = { taskRun: { findFirst: (args: unknown) => Promise<unknown> } };

export type BufferedBulkActionDeps = {
  getBuffer?: () => MollifierBuffer | null;
  prismaClient?: PrismaClientOrTransaction;
  prismaReplica?: TaskRunReader;
  prismaWriter?: TaskRunReader;
};

// Apply a bulk CANCEL across all buffer entries in `envId` matching the
// filter. Writes `cancelledAt` into the snapshot via the same
// mutate-with-fallback path the single-run cancel API uses, so a run that
// drains mid-bulk-action is handled correctly: PG-first lookup picks up
// the materialised row and routes to `CancelTaskRunService`; buffer-first
// applies the snapshot patch.
export async function processBufferedCancelBulkAction(
  ctx: BufferedBulkActionContext & { cancelReason: string },
  deps: BufferedBulkActionDeps = {},
): Promise<BufferedBulkActionResult> {
  const buffer = (deps.getBuffer ?? getMollifierBuffer)();
  if (!buffer) return { successCount: 0, failureCount: 0 };

  const maxBuffered = ctx.maxBufferedRuns ?? DEFAULT_MAX_BUFFERED_RUNS;
  let entries;
  try {
    entries = await buffer.listEntriesForEnv(ctx.envId, maxBuffered);
  } catch (err) {
    logger.warn("buffered bulk-cancel: listEntriesForEnv failed", {
      envId: ctx.envId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { successCount: 0, failureCount: 0 };
  }

  const cancelledAt = new Date();
  let successCount = 0;
  let failureCount = 0;

  for (const entry of entries) {
    let snapshot: Record<string, unknown>;
    try {
      snapshot = deserialiseSnapshot(entry.payload) as Record<string, unknown>;
    } catch {
      // Malformed snapshot can't match any structured filter; skip.
      continue;
    }
    if (!matchesFilter(snapshot, entry, ctx.filters)) continue;

    const outcome = await mutateWithFallback({
      runId: entry.runId,
      environmentId: ctx.envId,
      organizationId: ctx.organizationId,
      bufferPatch: {
        type: "mark_cancelled",
        cancelledAt: cancelledAt.toISOString(),
        cancelReason: ctx.cancelReason,
      },
      pgMutation: async () => {
        // The single-run cancel API handles the PG-resident case by
        // calling CancelTaskRunService. For the bulk path the same work
        // is already happening in the BulkActionV2 PG batch — skipping
        // here avoids double-processing the same run.
        return { kind: "pg" as const };
      },
      synthesisedResponse: () => ({ kind: "snapshot" as const }),
      getBuffer: deps.getBuffer,
      prismaReplica: deps.prismaReplica,
      prismaWriter: deps.prismaWriter,
    });

    if (outcome.kind === "snapshot") {
      successCount++;
    } else if (outcome.kind === "pg") {
      // Already covered by the PG batch — neither success nor failure
      // from this helper's perspective.
    } else {
      failureCount++;
    }
  }

  return { successCount, failureCount };
}

// Apply a bulk REPLAY across all buffer entries in `envId` matching the
// filter. Each match is replayed by feeding a SyntheticRun (cast to
// TaskRun) to ReplayTaskRunService, which has been extended to accept the
// synthetic shape.
//
// Retry semantics: replay is not idempotent — a worker retry of this
// function would create duplicate replays. The caller (BulkActionV2) must
// gate this on the bulk action's first-batch cursor to avoid running it
// twice.
export async function processBufferedReplayBulkAction(
  ctx: BufferedBulkActionContext & { bulkActionId: string; prismaClient: PrismaClientOrTransaction },
  deps: BufferedBulkActionDeps = {},
): Promise<BufferedBulkActionResult> {
  const buffer = (deps.getBuffer ?? getMollifierBuffer)();
  if (!buffer) return { successCount: 0, failureCount: 0 };

  const maxBuffered = ctx.maxBufferedRuns ?? DEFAULT_MAX_BUFFERED_RUNS;
  let entries;
  try {
    entries = await buffer.listEntriesForEnv(ctx.envId, maxBuffered);
  } catch (err) {
    logger.warn("buffered bulk-replay: listEntriesForEnv failed", {
      envId: ctx.envId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { successCount: 0, failureCount: 0 };
  }

  let successCount = 0;
  let failureCount = 0;
  const replayService = new ReplayTaskRunService(ctx.prismaClient);

  for (const entry of entries) {
    let snapshot: Record<string, unknown>;
    try {
      snapshot = deserialiseSnapshot(entry.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!matchesFilter(snapshot, entry, ctx.filters)) continue;

    const synthetic = await findRunByIdWithMollifierFallback({
      runId: entry.runId,
      environmentId: ctx.envId,
      organizationId: ctx.organizationId,
    });
    if (!synthetic) {
      // Entry vanished between list and read (TTL/drain). Skip.
      continue;
    }

    try {
      const result = await replayService.call(synthetic as unknown as TaskRun, {
        bulkActionId: ctx.bulkActionId,
        triggerSource: "dashboard",
      });
      if (result) successCount++;
      else failureCount++;
    } catch (err) {
      logger.error("buffered bulk-replay: replay failed", {
        runId: entry.runId,
        err: err instanceof Error ? err.message : String(err),
      });
      failureCount++;
    }
  }

  return { successCount, failureCount };
}
