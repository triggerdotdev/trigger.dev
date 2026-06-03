import type { Run, RunEvent } from "~/presenters/v3/RunPresenter.server";
import type { RunSummary, SpanSummary, TraceSummary } from "../types";

const MAX_ERROR_LENGTH = 500;
const MAX_SPANS = 20;
const MAX_LOG_LINES = 50;

export function summarizeRun(run: Run): RunSummary {
  const duration =
    run.completedAt && run.startedAt
      ? `${Math.round((run.completedAt.getTime() - run.startedAt.getTime()) / 1000)}s`
      : undefined;

  return {
    id: run.friendlyId,
    status: run.status,
    isFinished: run.isFinished,
    startedAt: run.startedAt?.toISOString(),
    completedAt: run.completedAt?.toISOString(),
    duration,
    parentRunId: run.parentTaskRun?.friendlyId ?? undefined,
    rootRunId: run.rootTaskRun?.friendlyId ?? undefined,
  };
}

export function summarizeSpan(span: RunEvent): SpanSummary {
  return {
    id: span.id ?? "",
    message: span.data?.message ?? "",
    isError: span.data?.isError ?? false,
    isPartial: span.data?.isPartial ?? false,
    duration: span.data?.duration ?? undefined,
    level: span.data?.level ?? "info",
    runId: span.runId ?? undefined,
  };
}

export function summarizeTrace(trace: {
  rootSpanStatus: string;
  events: RunEvent[];
}): TraceSummary {
  return {
    rootStatus: trace.rootSpanStatus,
    totalSpans: trace.events.length,
    spans: trace.events.slice(0, MAX_SPANS).map(summarizeSpan),
    truncated: trace.events.length > MAX_SPANS,
  };
}

export function truncateError(error: string): string {
  if (error.length <= MAX_ERROR_LENGTH) return error;
  return error.slice(0, MAX_ERROR_LENGTH) + "...";
}

export function formatLogLines(
  logs: Array<{ timestamp?: Date; message: string }>
): string[] {
  return logs.slice(0, MAX_LOG_LINES).map((log) => {
    const time = log.timestamp?.toISOString() ?? new Date().toISOString();
    return `${time}: ${log.message}`;
  });
}
