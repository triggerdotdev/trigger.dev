import type { ErrorGroup } from "~/presenters/v3/ErrorsListPresenter.server";
import type { ErrorGroupSummary, ErrorDetailsSummary } from "../types";

const MAX_STACK_TRACE_LENGTH = 1000;
const MAX_AFFECTED_RUNS = 5;

export function summarizeErrorGroup(
  errorGroup: ErrorGroup
): ErrorGroupSummary {
  return {
    fingerprint: errorGroup.fingerprint,
    message: errorGroup.errorMessage,
    taskIdentifier: errorGroup.taskIdentifier,
    count: errorGroup.count,
    firstSeen: errorGroup.firstSeen?.toISOString() ?? new Date().toISOString(),
    lastSeen: errorGroup.lastSeen?.toISOString() ?? new Date().toISOString(),
    status: errorGroup.status ?? "UNRESOLVED",
  };
}

export function truncateStackTrace(stackTrace: string): string {
  if (stackTrace.length <= MAX_STACK_TRACE_LENGTH) return stackTrace;
  return stackTrace.slice(0, MAX_STACK_TRACE_LENGTH) + "...[truncated]";
}

export function summarizeErrorDetails(
  fingerprint: string,
  message: string,
  taskIdentifier: string,
  stackTrace: string | null,
  count: number,
  firstSeen: Date | null,
  lastSeen: Date | null,
  affectedRuns: Array<{ friendlyId: string; status: string; createdAt: Date }>
): ErrorDetailsSummary {
  return {
    fingerprint,
    message,
    taskIdentifier,
    stackTrace: stackTrace ? truncateStackTrace(stackTrace) : undefined,
    count,
    firstSeen: firstSeen?.toISOString() ?? new Date().toISOString(),
    lastSeen: lastSeen?.toISOString() ?? new Date().toISOString(),
    affectedRuns: affectedRuns.slice(0, MAX_AFFECTED_RUNS).map((run) => ({
      runFriendlyId: run.friendlyId,
      status: run.status,
      occurredAt: run.createdAt.toISOString(),
    })),
  };
}
