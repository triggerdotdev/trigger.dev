import type {
  RetrieveRunTraceAttemptFailure,
  RetrieveRunTracePageSpan,
} from "@trigger.dev/core/v3";
import { parseMetadata, TraceChunkAssembler } from "./traceChunkAssembler";
import type { TraceChunkEvent } from "./eventRepository.types";

type SpanLike = {
  id: string;
  parentId?: string;
  runId: string;
  data: {
    message: string;
    startTime: Date;
    duration: number;
    isError: boolean;
    isPartial: boolean;
    isCancelled: boolean;
    level: string;
    attemptNumber?: number;
  };
};

export function toPageSpan(span: SpanLike): RetrieveRunTracePageSpan {
  return {
    id: span.id,
    parentId: span.parentId,
    runId: span.runId,
    message: span.data.message,
    startTime: span.data.startTime,
    duration: span.data.duration,
    isError: span.data.isError,
    isPartial: span.data.isPartial,
    isCancelled: span.data.isCancelled,
    level: span.data.level,
    attemptNumber: span.data.attemptNumber,
  };
}

export type TracePage = {
  spans: RetrieveRunTracePageSpan[];
  attemptFailures: RetrieveRunTraceAttemptFailure[];
};

// These rows carry their own timestamp, so they can sit on a later page than their span.
function isAnnotationRow(event: TraceChunkEvent): boolean {
  return event.kind === "SPAN_EVENT" || event.kind === "ANCESTOR_OVERRIDE";
}

function toAttemptFailure(event: TraceChunkEvent): RetrieveRunTraceAttemptFailure | undefined {
  if (event.kind !== "ANCESTOR_OVERRIDE" || event.message !== "attempt_failed") {
    return undefined;
  }

  const metadata = parseMetadata(event.metadata);
  if (typeof metadata?.attemptNumber !== "number" || typeof metadata.runId !== "string") {
    return undefined;
  }

  return { spanId: event.spanId, attemptNumber: metadata.attemptNumber, runId: metadata.runId };
}

export function buildTracePage(events: TraceChunkEvent[]): TracePage {
  const assembler = new TraceChunkAssembler();
  assembler.mergeChunk(events.filter((event) => !isAnnotationRow(event)));

  const spans = assembler.spans.map(toPageSpan);

  const attemptFailures = events.flatMap((event) => toAttemptFailure(event) ?? []);

  return { spans, attemptFailures };
}
