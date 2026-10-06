import { useEffect, useMemo, useRef, useState } from "react";
import type { SpanOverride, TraceChunkCursor } from "~/v3/eventRepository/eventRepository.types";
import { TraceChunkAssembler } from "~/v3/eventRepository/traceChunkAssembler";
import {
  applyAncestorOverrides,
  buildTraceView,
  type BuildTraceViewOptions,
  type TraceViewEvent,
} from "~/v3/eventRepository/traceViewBuilder";

const MAX_CHUNK_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 400;
const MAX_PROGRESSIVE_SPANS = 250_000;
const BACKGROUND_CHUNK_SIZE = 10_000;
const REBUILD_COALESCE_MS = 100;

type WireChunkEvent = {
  spanId: string;
  parentSpanId: string;
  runId: string;
  startTime: string;
  startTimeNano: string;
  duration: number;
  status: string;
  kind: string;
  message: string;
  metadata: string;
};

type WireChunkResponse = {
  events: WireChunkEvent[];
  nextCursor: TraceChunkCursor | null;
  hasMore: boolean;
};

type ProgressiveMeta = {
  firstEvents: WireChunkEvent[];
  supplementaryFirstEvents?: WireChunkEvent[];
  nextCursor: TraceChunkCursor | null;
  hasMore: boolean;
  buildOptions: BuildTraceViewOptions;
  showDebug: boolean;
  totalSpans?: number;
  maxSpans?: number;
};

export type ProgressiveTraceInput = {
  events: TraceViewEvent[];
  duration: number;
  rootStartedAt: Date | string | undefined;
  rootSpanStatus: "executing" | "completed" | "failed";
  overridesBySpanId?: Record<string, SpanOverride>;
  linkedRunIdBySpanId?: Record<string, string>;
  progressive?: ProgressiveMeta | null;
};

export type ProgressiveTraceState = {
  events: TraceViewEvent[];
  duration: number;
  rootStartedAt: Date | string | undefined;
  rootSpanStatus: "executing" | "completed" | "failed";
  overridesBySpanId: Record<string, SpanOverride>;
  linkedRunIdBySpanId: Record<string, string>;
  isComplete: boolean;
  isTruncated: boolean;
};

function toChunkEvent(event: WireChunkEvent) {
  return { ...event, startTime: new Date(event.startTime) };
}

function initialState(trace: ProgressiveTraceInput): ProgressiveTraceState {
  return {
    events: trace.events,
    duration: trace.duration,
    rootStartedAt: trace.rootStartedAt,
    rootSpanStatus: trace.rootSpanStatus,
    overridesBySpanId: trace.overridesBySpanId ?? {},
    linkedRunIdBySpanId: trace.linkedRunIdBySpanId ?? {},
    isComplete: !trace.progressive?.hasMore,
    isTruncated: false,
  };
}

export function useProgressiveTrace(
  trace: ProgressiveTraceInput,
  chunkPath: string,
  errorsOnly: boolean
): ProgressiveTraceState {
  const [state, setState] = useState<ProgressiveTraceState>(() => initialState(trace));
  const staticState = useMemo(() => (trace.progressive ? null : initialState(trace)), [trace]);

  const progressive = trace.progressive ?? null;
  const identity = progressive
    ? `${progressive.buildOptions.rootSpanId}:${progressive.firstEvents.length}:${
        progressive.nextCursor?.spanId ?? ""
      }:${progressive.hasMore}:${progressive.totalSpans ?? ""}`
    : `static:${trace.events.length}`;

  const latestTraceRef = useRef(trace);
  latestTraceRef.current = trace;
  const assemblerRef = useRef<TraceChunkAssembler | null>(null);
  const errorsFetchedRef = useRef(false);

  function rebuild(meta: ProgressiveMeta) {
    const assembler = assemblerRef.current;
    if (!assembler) return;
    const { spans, overridesBySpanId } = applyAncestorOverrides(assembler.spans);
    const view = buildTraceView(spans, meta.buildOptions);
    setState((prev) => ({
      events: view.events,
      duration: view.duration,
      rootStartedAt: view.rootStartedAt,
      rootSpanStatus: view.rootSpanStatus,
      overridesBySpanId,
      linkedRunIdBySpanId: view.linkedRunIdBySpanId,
      isComplete: prev.isComplete,
      isTruncated: prev.isTruncated,
    }));
  }

  useEffect(() => {
    const current = latestTraceRef.current;
    setState(initialState(current));
    errorsFetchedRef.current = false;

    const meta = current.progressive;
    if (!meta) {
      assemblerRef.current = null;
      return;
    }

    const assembler = new TraceChunkAssembler();
    assembler.mergeChunk(meta.firstEvents.map(toChunkEvent));
    if (meta.supplementaryFirstEvents?.length) {
      assembler.mergeChunk(meta.supplementaryFirstEvents.map(toChunkEvent), {
        source: "deeplink",
      });
    }
    assemblerRef.current = assembler;

    if (!meta.hasMore || !meta.nextCursor) {
      return;
    }

    let cancelled = false;
    let cursor: TraceChunkCursor | null = meta.nextCursor;
    const maxSpans = meta.maxSpans ?? MAX_PROGRESSIVE_SPANS;

    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    let rebuildPending = false;
    const requestRebuild = () => {
      rebuildPending = true;
      if (rebuildTimer === null) {
        rebuildTimer = setTimeout(() => {
          rebuildTimer = null;
          rebuildPending = false;
          rebuild(meta!);
        }, REBUILD_COALESCE_MS);
      }
    };
    const flushRebuild = () => {
      if (rebuildTimer !== null) {
        clearTimeout(rebuildTimer);
        rebuildTimer = null;
      }
      if (rebuildPending) {
        rebuildPending = false;
        rebuild(meta!);
      }
    };

    const markComplete = (truncated = false) => {
      flushRebuild();
      setState((prev) => ({
        ...prev,
        isComplete: true,
        isTruncated: prev.isTruncated || truncated,
      }));
    };

    async function loadRemaining() {
      while (!cancelled && cursor) {
        let data: WireChunkResponse | null = null;
        for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS && !cancelled; attempt++) {
          data = await fetchChunk(chunkPath, meta!.showDebug, {
            cursor,
            limit: BACKGROUND_CHUNK_SIZE,
          });
          if (data) break;
          if (attempt < MAX_CHUNK_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
          }
        }
        if (cancelled) {
          return;
        }
        if (!data) {
          markComplete();
          return;
        }

        assembler.mergeChunk(data.events.map(toChunkEvent));
        requestRebuild();
        cursor = data.hasMore ? data.nextCursor : null;

        if (assembler.size > maxSpans) {
          markComplete(true);
          return;
        }
        if (!cursor) {
          markComplete();
          return;
        }
      }
    }

    void loadRemaining();

    return () => {
      cancelled = true;
      if (rebuildTimer !== null) {
        clearTimeout(rebuildTimer);
        rebuildTimer = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only on a new loader payload
  }, [identity, chunkPath]);

  useEffect(() => {
    const meta = latestTraceRef.current.progressive;
    if (!errorsOnly || !meta || errorsFetchedRef.current) {
      return;
    }

    let cancelled = false;
    (async () => {
      const data = await fetchChunk(chunkPath, meta.showDebug, { filter: "errors" });
      if (cancelled || !data || !assemblerRef.current) return;
      errorsFetchedRef.current = true;
      assemblerRef.current.mergeChunk(data.events.map(toChunkEvent), { source: "errors" });
      rebuild(meta);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to errorsOnly + payload
  }, [errorsOnly, identity, chunkPath]);

  return staticState ?? state;
}

async function fetchChunk(
  chunkPath: string,
  showDebug: boolean,
  params: { cursor?: TraceChunkCursor; filter?: "errors"; limit?: number }
): Promise<WireChunkResponse | null> {
  const url = new URL(chunkPath, window.location.origin);
  if (params.cursor) {
    url.searchParams.set("cursorStartTime", params.cursor.startTime);
    url.searchParams.set("cursorSpanId", params.cursor.spanId);
  }
  if (params.limit) {
    url.searchParams.set("limit", String(params.limit));
  }
  if (params.filter) {
    url.searchParams.set("filter", params.filter);
  }
  if (showDebug) {
    url.searchParams.set("debug", "1");
  }

  try {
    const response = await fetch(url.toString(), { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    return (await response.json()) as WireChunkResponse;
  } catch {
    return null;
  }
}
