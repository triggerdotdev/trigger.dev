import { stripAdminOnlyEventRows } from "~/utils/timelineSpanEvents";
import type {
  IEventRepository,
  SpanSummary,
  TraceChunk,
  TraceChunkCursor,
  TraceChunkEvent,
} from "~/v3/eventRepository/eventRepository.types";
import { TraceChunkAssembler } from "~/v3/eventRepository/traceChunkAssembler";
import {
  applyAncestorOverrides,
  buildTraceView,
  type BuildTraceViewOptions,
} from "~/v3/eventRepository/traceViewBuilder";
import type { TaskEventStoreTable } from "~/v3/taskEventStore.server";
import { hasWriteTimes } from "./liveTailGate";

export type TraceReadScope = {
  storeTable: TaskEventStoreTable;
  environmentId: string;
  traceId: string;
  startCreatedAt: Date;
  endCreatedAt: Date | undefined;
};

export type FirstTraceChunk =
  | {
      kind: "progressive";
      assembler: TraceChunkAssembler;
      firstEvents: TraceChunkEvent[];
      supplementaryFirstEvents: TraceChunkEvent[] | undefined;
      nextCursor: TraceChunkCursor | null;
      hasMore: boolean;
    }
  | { kind: "empty" }
  | { kind: "fallback"; reason: "noWriteTimes" | "anchorMissing" };

export async function assembleFirstTraceChunk({
  repository,
  scope,
  firstChunk,
  anchorSpanId,
  selectedSpanId,
  showDebug,
  isAdmin,
  insertedAtEnd,
}: {
  repository: Pick<IEventRepository, "getTraceSpanWithAncestors">;
  scope: TraceReadScope;
  firstChunk: TraceChunk;
  anchorSpanId: string;
  selectedSpanId: string | undefined;
  showDebug: boolean;
  isAdmin: boolean;
  /** Same write-time bound as the first chunk, so the walks can't add rows the pages leave out. */
  insertedAtEnd?: Date;
}): Promise<FirstTraceChunk> {
  if (firstChunk.events.length === 0) {
    return { kind: "empty" };
  }

  if (!hasWriteTimes(firstChunk.events)) {
    return { kind: "fallback", reason: "noWriteTimes" };
  }

  const firstEvents = stripAdminOnlyEventRows(firstChunk.events, isAdmin);
  const assembler = new TraceChunkAssembler();
  assembler.mergeChunk(firstEvents);

  // Each walk returns every row of each span it visits, and both walks can visit the
  // same ancestors, so take a span's rows from the first walk that returns it.
  const supplementary: TraceChunkEvent[] = [];
  const supplementarySpanIds = new Set<string>();
  const hasSpan = (spanId: string) => assembler.hasSpan(spanId) || supplementarySpanIds.has(spanId);

  const fetchMissingSpan = async (spanId: string) => {
    const events = await repository.getTraceSpanWithAncestors(
      scope.storeTable,
      scope.environmentId,
      scope.traceId,
      scope.startCreatedAt,
      scope.endCreatedAt,
      spanId,
      { includeDebugLogs: showDebug, insertedAtEnd }
    );
    const visible = stripAdminOnlyEventRows(events ?? [], isAdmin).filter(
      (event) => !supplementarySpanIds.has(event.spanId)
    );
    supplementary.push(...visible);
    for (const event of visible) {
      supplementarySpanIds.add(event.spanId);
    }
  };

  // The selected span's walk usually reaches the viewed run's span too, so look it up
  // first. Earlier siblings can fill the first chunk before either span.
  if (selectedSpanId && selectedSpanId !== anchorSpanId && !hasSpan(selectedSpanId)) {
    await fetchMissingSpan(selectedSpanId);
  }
  if (!hasSpan(anchorSpanId)) {
    await fetchMissingSpan(anchorSpanId);
  }

  if (supplementary.length > 0) {
    assembler.mergeChunk(supplementary, { source: "deeplink" });
  }

  if (!assembler.hasSpan(anchorSpanId)) {
    return { kind: "fallback", reason: "anchorMissing" };
  }

  return {
    kind: "progressive",
    assembler,
    firstEvents,
    supplementaryFirstEvents: supplementary.length > 0 ? supplementary : undefined,
    nextCursor: firstChunk.nextCursor,
    hasMore: firstChunk.hasMore,
  };
}

export async function readFirstTraceChunk({
  repository,
  scope,
  showDebug,
  insertedAtEnd,
}: {
  repository: Pick<IEventRepository, "getTraceChunk">;
  scope: TraceReadScope;
  showDebug: boolean;
  insertedAtEnd?: Date;
}): Promise<{ firstChunk: TraceChunk; firstChunkReadAt: number } | undefined> {
  // Read before the first chunk so the first tail covers the background load.
  const firstChunkReadAt = Date.now();
  const firstChunk = await repository.getTraceChunk(
    scope.storeTable,
    scope.environmentId,
    scope.traceId,
    scope.startCreatedAt,
    scope.endCreatedAt,
    undefined,
    { includeDebugLogs: showDebug, insertedAtEnd }
  );
  return firstChunk ? { firstChunk, firstChunkReadAt } : undefined;
}

// The trace payload the progressive trace hook starts from.
function buildProgressiveTrace({
  spans,
  firstEvents,
  supplementaryFirstEvents,
  nextCursor,
  hasMore,
  buildOptions,
  startedAt,
  queuedDuration,
  showDebug,
  maxSpans,
  firstChunkReadAt,
}: {
  spans: SpanSummary[];
  firstEvents: TraceChunkEvent[];
  supplementaryFirstEvents: TraceChunkEvent[] | undefined;
  nextCursor: TraceChunkCursor | null;
  hasMore: boolean;
  buildOptions: BuildTraceViewOptions;
  startedAt: Date | null;
  queuedDuration: number | undefined;
  showDebug: boolean;
  maxSpans: number;
  firstChunkReadAt: number;
}) {
  const { spans: overridden, overridesBySpanId } = applyAncestorOverrides(spans);
  const view = buildTraceView(overridden, buildOptions);

  return {
    events: view.events,
    duration: view.duration,
    rootStartedAt: view.rootStartedAt,
    rootSpanStatus: view.rootSpanStatus,
    startedAt,
    queuedDuration,
    overridesBySpanId,
    linkedRunIdBySpanId: view.linkedRunIdBySpanId,
    isTruncated: false,
    missingAnchor: false,
    progressive: {
      firstEvents,
      supplementaryFirstEvents,
      nextCursor,
      hasMore,
      buildOptions,
      showDebug,
      maxSpans,
      liveTailEnabled: true,
      firstChunkReadAt,
    },
  };
}

type ProgressiveTrace = ReturnType<typeof buildProgressiveTrace>;

export type FirstTrace =
  | { kind: "progressive"; trace: ProgressiveTrace }
  // No spans yet: the trace is empty but can still tail.
  | { kind: "empty"; trace: ProgressiveTrace }
  | { kind: "fallback"; reason: "noWriteTimes" | "anchorMissing" };

const NO_SPANS = {
  spans: [],
  firstEvents: [],
  supplementaryFirstEvents: undefined,
  nextCursor: null,
  hasMore: false,
};

// Assembles the first chunk and builds the payload the progressive trace hook starts from.
export async function buildFirstTrace({
  repository,
  scope,
  firstRead,
  anchorSpanId,
  selectedSpanId,
  insertedAtEnd,
  buildOptions,
  startedAt,
  queuedDuration,
  showDebug,
  maxSpans,
}: {
  repository: Pick<IEventRepository, "getTraceSpanWithAncestors">;
  scope: TraceReadScope;
  firstRead: { firstChunk: TraceChunk; firstChunkReadAt: number };
  anchorSpanId: string;
  selectedSpanId: string | undefined;
  insertedAtEnd?: Date;
  buildOptions: BuildTraceViewOptions;
  startedAt: Date | null;
  queuedDuration: number | undefined;
  showDebug: boolean;
  maxSpans: number;
}): Promise<FirstTrace> {
  const first = await assembleFirstTraceChunk({
    repository,
    scope,
    firstChunk: firstRead.firstChunk,
    anchorSpanId,
    selectedSpanId,
    showDebug,
    isAdmin: buildOptions.isAdmin,
    insertedAtEnd,
  });

  if (first.kind === "fallback") {
    return first;
  }

  const loaded =
    first.kind === "progressive"
      ? {
          spans: first.assembler.spans,
          firstEvents: first.firstEvents,
          supplementaryFirstEvents: first.supplementaryFirstEvents,
          nextCursor: first.nextCursor,
          hasMore: first.hasMore,
        }
      : NO_SPANS;

  return {
    kind: first.kind,
    trace: buildProgressiveTrace({
      ...loaded,
      buildOptions,
      startedAt,
      queuedDuration,
      showDebug,
      maxSpans,
      firstChunkReadAt: firstRead.firstChunkReadAt,
    }),
  };
}
