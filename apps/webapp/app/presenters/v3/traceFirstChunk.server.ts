import { stripAdminOnlyEventRows } from "~/utils/timelineSpanEvents";
import type {
  IEventRepository,
  TraceChunk,
  TraceChunkCursor,
  TraceChunkEvent,
} from "~/v3/eventRepository/eventRepository.types";
import { TraceChunkAssembler } from "~/v3/eventRepository/traceChunkAssembler";
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
}: {
  repository: Pick<IEventRepository, "getTraceSpanWithAncestors">;
  scope: TraceReadScope;
  firstChunk: TraceChunk;
  anchorSpanId: string;
  selectedSpanId: string | undefined;
  showDebug: boolean;
  isAdmin: boolean;
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
      { includeDebugLogs: showDebug }
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
