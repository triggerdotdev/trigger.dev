import { millisecondsToNanoseconds, RunAnnotations } from "@trigger.dev/core/v3";
import type { TaskRunStatus } from "@trigger.dev/database";
import { getTraceStartTimeEnd } from "~/v3/eventRepository/traceInsertedAtBound";
import type { BuildTraceViewOptions } from "~/v3/eventRepository/traceViewBuilder";
import { runTriggeredAt } from "~/v3/runTimestamps";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";
import { canLiveTail } from "./liveTailGate";
import type { TraceReadScope } from "./traceFirstChunk.server";

export function runTraceReadScope(
  run: {
    taskEventStore: string;
    traceId: string;
    createdAt: Date;
    status: TaskRunStatus;
    completedAt: Date | null;
    updatedAt: Date;
  },
  environmentId: string
): TraceReadScope {
  return {
    storeTable: getTaskEventStoreTableForRun(run),
    environmentId,
    traceId: run.traceId,
    // A child view only reads its own lifetime, not the root's.
    startCreatedAt: run.createdAt,
    endCreatedAt: getTraceStartTimeEnd(run),
  };
}

export function runTraceBuildOptions(
  run: { spanId: string; friendlyId: string; annotations: unknown },
  isAdmin: boolean
): BuildTraceViewOptions {
  return {
    rootSpanId: run.spanId,
    runFriendlyId: run.friendlyId,
    // Agent runs get their own icon and colour in the tree.
    isAgentRun: RunAnnotations.safeParse(run.annotations).data?.taskKind === "AGENT",
    isAdmin,
  };
}

export function runQueuedDuration(run: {
  startedAt: Date | null;
  createdAt: Date;
  queueTimestamp?: Date | null;
  scheduleId?: string | null;
}): number | undefined {
  return run.startedAt
    ? millisecondsToNanoseconds(run.startedAt.getTime() - runTriggeredAt(run).getTime())
    : undefined;
}

type RunTraceUnavailableReason = "logsDeleted" | "legacyStore" | "emergencyCap";

/** Why a run's trace can't load progressively, decided before any read. Uses the run page's gate. */
export function runTraceUnavailableBeforeRead(
  run: { taskEventStore: string; logsDeletedAt: Date | null },
  {
    showDeletedLogs,
    emergencySpanCap,
    v1RerouteEnabled,
  }: { showDeletedLogs: boolean; emergencySpanCap: number | undefined; v1RerouteEnabled: boolean }
): RunTraceUnavailableReason | undefined {
  if (run.logsDeletedAt && !showDeletedLogs) {
    return "logsDeleted";
  }
  if (canLiveTail(run.taskEventStore, emergencySpanCap, v1RerouteEnabled)) {
    return undefined;
  }
  return emergencySpanCap !== undefined ? "emergencyCap" : "legacyStore";
}
