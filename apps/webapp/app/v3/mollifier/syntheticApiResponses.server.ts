import type { SyntheticRun } from "./readFallback.server";

// Buffered runs have no execution data — the drainer hasn't materialised
// the PG row and the worker hasn't started. The SDK-facing read routes
// still need to return a span/trace shape that satisfies their response
// schemas; these helpers build that minimal shape from the buffered
// SyntheticRun.
//
// CANCELED and FAILED are terminal states: a FAILED buffered run is
// errored (drainer exhausted retries or the gate rejected it) and must
// not signal "still in progress." The flags below mirror
// syntheticTrace.server.ts so the SDK contract stays consistent across
// the three read paths (spans, trace, dashboard trace presenter).

function deriveTerminalFlags(status: SyntheticRun["status"]): {
  isError: boolean;
  isPartial: boolean;
  isCancelled: boolean;
} {
  const isCancelled = status === "CANCELED";
  const isFailed = status === "FAILED";
  return {
    isError: isFailed,
    isPartial: !isCancelled && !isFailed,
    isCancelled,
  };
}

// Body for GET /api/v1/runs/:runId/spans/:spanId when the run is buffered
// and `:spanId` has already been verified against `buffered.spanId` by the
// route. Pure function so the route layer just authenticates, resolves
// the run, validates the spanId, and forwards the buffered run here.
export function buildSyntheticSpanDetailBody(buffered: SyntheticRun) {
  const flags = deriveTerminalFlags(buffered.status);
  return {
    spanId: buffered.spanId,
    parentId: buffered.parentSpanId ?? null,
    runId: buffered.friendlyId,
    message: buffered.taskIdentifier ?? "",
    ...flags,
    level: "TRACE" as const,
    startTime: buffered.createdAt,
    durationMs: 0,
  };
}

// Body for GET /api/v1/runs/:runId/trace when the run is buffered.
// Returns the `{ trace: { traceId, rootSpan } }` envelope expected by the
// SDK's RetrieveRunTraceResponseBody schema.
export function buildSyntheticTraceBody(buffered: SyntheticRun) {
  const flags = deriveTerminalFlags(buffered.status);
  return {
    trace: {
      traceId: buffered.traceId ?? "",
      rootSpan: {
        id: buffered.spanId ?? "",
        runId: buffered.friendlyId,
        data: {
          message: buffered.taskIdentifier ?? "",
          taskSlug: buffered.taskIdentifier ?? undefined,
          events: [] as unknown[],
          startTime: buffered.createdAt,
          duration: 0,
          ...flags,
          level: "TRACE" as const,
          queueName: buffered.queue ?? undefined,
          machinePreset: buffered.machinePreset ?? undefined,
        },
        children: [] as unknown[],
      },
    },
  };
}
