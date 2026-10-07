import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpanOverride, TraceChunkCursor } from "~/v3/eventRepository/eventRepository.types";
import {
  LIVE_TAIL_OVERLAP_MS,
  resolveLiveTailEnabled,
  tailMinIntervalMs,
  tailOverlapMs,
} from "./liveTail";
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
const TAIL_FETCH_TIMEOUT_MS = 15_000;
// A hung chunk request must fail so retries (and the Retry callout) can kick in.
const BACKGROUND_FETCH_TIMEOUT_MS = 60_000;

type WireChunkEvent = {
  spanId: string;
  parentSpanId: string;
  runId: string;
  startTime: string;
  startTimeNano: string;
  // Write time (ms since epoch); absent on the v1 store.
  insertedAt?: string;
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
  // The server capped the result: errors-only matches, or paging under the emergency cap.
  isTruncated?: boolean;
  // Server time (ms) taken before the page was read.
  readAt?: number;
};

type ProgressiveMeta = {
  firstEvents: WireChunkEvent[];
  supplementaryFirstEvents?: WireChunkEvent[];
  nextCursor: TraceChunkCursor | null;
  hasMore: boolean;
  buildOptions: BuildTraceViewOptions;
  showDebug: boolean;
  maxSpans?: number;
  liveTailEnabled?: boolean;
  // Server time (ms) before the first chunk was read; the first tail reads back to it.
  firstChunkReadAt?: number;
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
  loadFailed: boolean;
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
    loadFailed: false,
  };
}

// Injected so `runTailLoop` is testable without the network.
export type TailPageFetcher = (params: {
  cursor?: TraceChunkCursor;
  insertedAtSince?: number;
  limit?: number;
}) => Promise<WireChunkResponse | null>;

// Fetches every row written since the assembler's tail base (minus the overlap) and
// merges it. The base only advances once a tick reads all its pages; a failed page
// pins it so the next tick re-reads from the same point.
export async function runTailLoop(
  fetchPage: TailPageFetcher,
  assembler: TraceChunkAssembler,
  maxSpans: number,
  overlapMs: number
): Promise<{ merged: boolean; truncated: boolean; finished: boolean }> {
  let merged = false;
  let truncated = false;
  const base = assembler.tailBase();
  if (base === null) {
    return { merged, truncated, finished: true };
  }
  const since = Math.max(0, base - overlapMs);
  let finished = false;
  // Rows written mid-tick behind the cursor are missed, so the tick only vouches for
  // what existed when its first page was read.
  let readThrough: number | null = null;
  assembler.beginTailRead();
  try {
    let cursor: TraceChunkCursor | null = null;
    while (true) {
      const data: WireChunkResponse | null = await fetchPage({
        cursor: cursor ?? undefined,
        insertedAtSince: since,
        limit: BACKGROUND_CHUNK_SIZE,
      });
      if (!data) break;
      if (cursor === null && data.readAt !== undefined) {
        readThrough = data.readAt;
      }
      if (data.events.length > 0) {
        assembler.mergeChunk(data.events.map(toChunkEvent), { source: "tail" });
        merged = true;
      }
      if (assembler.size > maxSpans) {
        truncated = true;
        finished = true;
        break;
      }
      cursor = data.hasMore ? data.nextCursor : null;
      if (cursor === null) {
        finished = true;
        break;
      }
    }
  } catch (error) {
    console.error("Live trace tail merge failed", error);
  }
  if (finished) {
    assembler.completeTailRead(base, readThrough);
  } else {
    assembler.pinTailFloor(base);
  }
  return { merged, truncated, finished };
}

export function useProgressiveTrace(
  trace: ProgressiveTraceInput,
  chunkPath: string,
  errorsOnly: boolean
): ProgressiveTraceState & {
  tailLive: () => void;
  liveTailEnabled: boolean;
  retryLoad: () => void;
} {
  const [state, setState] = useState<ProgressiveTraceState>(() => initialState(trace));
  const staticState = useMemo(() => (trace.progressive ? null : initialState(trace)), [trace]);

  const progressive = trace.progressive ?? null;
  // A same-run revalidate keeps the loaded tree; the tail keeps it current.
  const identity = progressive
    ? `tail:${progressive.buildOptions.rootSpanId}:${progressive.showDebug}`
    : `static:${trace.events.length}`;

  const latestTraceRef = useRef(trace);
  useEffect(() => {
    latestTraceRef.current = trace;
  });
  const assemblerRef = useRef<TraceChunkAssembler | null>(null);
  const errorsFetchedRef = useRef(false);
  // The deep-link payload already merged, so a kept tree only merges new ones.
  const mergedSupplementaryRef = useRef<WireChunkEvent[] | null>(null);
  // The first chunk already merged; a same-run revalidate merges only a new one.
  const mergedFirstEventsRef = useRef<WireChunkEvent[] | null>(null);
  // Assembler the in-flight tail targets; a stale tail never touches the current one.
  const tailingRef = useRef<TraceChunkAssembler | null>(null);
  // Timestamp of the last tail read, for the size-aware cadence governor.
  const lastTailAtRef = useRef(0);
  const lastSweepAtRef = useRef(0);
  // A signal arrived while the tab was hidden; tail once when it's visible again.
  const hiddenTailRef = useRef(false);
  // A throttled signal schedules one tail for when the interval ends.
  const deferredTailRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A signal arrived mid-tail; run one trailing pass.
  const pendingTailRef = useRef(false);
  // Latest tail closure, behind the stable `tailLive`.
  const tailLiveRef = useRef<() => void>(() => {});

  const rebuild = useCallback((meta: ProgressiveMeta, assembler: TraceChunkAssembler) => {
    if (assemblerRef.current !== assembler) return;
    assembler.markRendered();
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
      loadFailed: prev.loadFailed,
    }));
  }, []);

  // Bumped by `retryLoad` to re-run the background load.
  const [retryGeneration, setRetryGeneration] = useState(0);
  const retryLoad = useCallback(() => setRetryGeneration((g) => g + 1), []);

  useEffect(() => {
    const current = latestTraceRef.current;
    setState(initialState(current));
    errorsFetchedRef.current = false;
    pendingTailRef.current = false;
    hiddenTailRef.current = false;
    lastTailAtRef.current = 0;
    lastSweepAtRef.current = 0;
    if (deferredTailRef.current !== null) {
      clearTimeout(deferredTailRef.current);
      deferredTailRef.current = null;
    }

    const meta = current.progressive;
    if (!meta) {
      assemblerRef.current = null;
      return;
    }

    const assembler = new TraceChunkAssembler();
    assembler.mergeChunk(meta.firstEvents.map(toChunkEvent));
    mergedFirstEventsRef.current = meta.firstEvents;
    if (meta.supplementaryFirstEvents?.length) {
      assembler.mergeChunk(meta.supplementaryFirstEvents.map(toChunkEvent), {
        source: "deeplink",
      });
    }
    mergedSupplementaryRef.current = meta.supplementaryFirstEvents ?? null;
    if (meta.firstChunkReadAt !== undefined) {
      assembler.pinTailFloor(meta.firstChunkReadAt);
    }
    assemblerRef.current = assembler;

    if (!meta.hasMore || !meta.nextCursor) {
      return;
    }
    assembler.holdTailFloor(true);

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
          rebuild(meta!, assembler);
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
        rebuild(meta!, assembler);
      }
    };

    const markComplete = (truncated = false) => {
      assembler.holdTailFloor(false);
      flushRebuild();
      // The tree now shows everything loaded, so the first live signal doesn't rebuild redundantly.
      assembler.markRendered();
      setState((prev) => ({
        ...prev,
        isComplete: true,
        isTruncated: prev.isTruncated || truncated,
      }));
    };

    // Persistent fetch failure: stop loading and offer a retry.
    const markFailed = () => {
      assembler.holdTailFloor(false);
      flushRebuild();
      setState((prev) => ({ ...prev, isComplete: true, loadFailed: true }));
    };

    async function loadRemaining() {
      while (!cancelled && cursor) {
        let data: WireChunkResponse | null = null;
        for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS && !cancelled; attempt++) {
          data = await fetchChunk(
            chunkPath,
            meta!.showDebug,
            { cursor, limit: BACKGROUND_CHUNK_SIZE },
            BACKGROUND_FETCH_TIMEOUT_MS
          );
          if (data) break;
          if (attempt < MAX_CHUNK_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
          }
        }
        if (cancelled) {
          return;
        }
        if (!data) {
          markFailed();
          return;
        }

        assembler.mergeChunk(data.events.map(toChunkEvent));
        requestRebuild();
        cursor = data.hasMore ? data.nextCursor : null;

        if (assembler.size > maxSpans || data.isTruncated) {
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
  }, [identity, chunkPath, retryGeneration, rebuild]);

  // Every chunk is loaded, so the client-side filter already sees every error.
  const fullyLoaded = state.isComplete && !state.loadFailed && !state.isTruncated;

  useEffect(() => {
    const meta = latestTraceRef.current.progressive;
    if (!errorsOnly || !meta || errorsFetchedRef.current || fullyLoaded) {
      return;
    }

    let cancelled = false;
    (async () => {
      const data = await fetchChunk(chunkPath, meta.showDebug, { filter: "errors" });
      const assembler = assemblerRef.current;
      if (cancelled || !data || !assembler) return;
      errorsFetchedRef.current = true;
      assembler.mergeChunk(data.events.map(toChunkEvent), { source: "errors" });
      rebuild(meta, assembler);
    })();

    return () => {
      cancelled = true;
    };
  }, [errorsOnly, fullyLoaded, identity, chunkPath, retryGeneration, rebuild]);

  const runTail = useCallback(() => {
    const meta = latestTraceRef.current.progressive;
    const assembler = assemblerRef.current;
    if (!meta || !assembler) return;
    if (document.visibilityState === "hidden") {
      hiddenTailRef.current = true;
      return;
    }
    // Tail in flight: queue one trailing pass so this signal isn't lost.
    if (tailingRef.current === assembler) {
      pendingTailRef.current = true;
      return;
    }

    const maxSpans = meta.maxSpans ?? MAX_PROGRESSIVE_SPANS;
    if (assembler.size > maxSpans) {
      // Grew past the view ceiling while live: stop tailing.
      setState((prev) => (prev.isTruncated ? prev : { ...prev, isTruncated: true }));
      return;
    }

    // Throttle large traces: defer to the end of the interval rather than drop.
    const nowMs = Date.now();
    const waitMs = lastTailAtRef.current + tailMinIntervalMs(assembler.size) - nowMs;
    if (waitMs > 0) {
      if (deferredTailRef.current === null) {
        deferredTailRef.current = setTimeout(() => {
          deferredTailRef.current = null;
          tailLiveRef.current();
        }, waitMs);
      }
      return;
    }
    lastTailAtRef.current = nowMs;
    const overlapMs = tailOverlapMs(nowMs, lastSweepAtRef.current);
    if (overlapMs !== LIVE_TAIL_OVERLAP_MS) {
      lastSweepAtRef.current = nowMs;
    }

    tailingRef.current = assembler;
    void runTailLoop(
      (params) => fetchChunk(chunkPath, meta.showDebug, params, TAIL_FETCH_TIMEOUT_MS),
      assembler,
      maxSpans,
      overlapMs
    )
      .then(({ merged, truncated, finished }) => {
        if (assemblerRef.current !== assembler) return;
        if (!finished && overlapMs !== LIVE_TAIL_OVERLAP_MS) {
          lastSweepAtRef.current = 0;
        }
        // Skip the rebuild when the overlap re-read changed nothing rendered.
        if (merged && assembler.changedSinceRender) {
          rebuild(meta, assembler);
        }
        if (truncated) {
          setState((prev) => (prev.isTruncated ? prev : { ...prev, isTruncated: true }));
        }
      })
      .finally(() => {
        if (tailingRef.current !== assembler) return;
        tailingRef.current = null;
        // A signal arrived mid-flight: run one trailing pass.
        if (pendingTailRef.current) {
          pendingTailRef.current = false;
          tailLiveRef.current();
        }
      });
  }, [chunkPath, rebuild]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || !hiddenTailRef.current) return;
      hiddenTailRef.current = false;
      tailLiveRef.current();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (deferredTailRef.current !== null) clearTimeout(deferredTailRef.current);
    };
  }, []);

  // A kept tree still needs the ancestors of a newly deep-linked span.
  const supplementary = progressive?.supplementaryFirstEvents;
  useEffect(() => {
    const meta = latestTraceRef.current.progressive;
    const assembler = assemblerRef.current;
    if (!meta?.liveTailEnabled || !assembler || !supplementary?.length) return;
    if (supplementary === mergedSupplementaryRef.current) return;
    mergedSupplementaryRef.current = supplementary;
    assembler.mergeChunk(supplementary.map(toChunkEvent), { source: "deeplink" });
    if (!assembler.changedSinceRender) return;
    rebuild(meta, assembler);
  }, [supplementary, rebuild]);

  // A kept tree merges a revalidated first chunk, e.g. the root's final row after the
  // tail stopped at the view ceiling.
  const firstEvents = progressive?.firstEvents;
  useEffect(() => {
    const meta = latestTraceRef.current.progressive;
    const assembler = assemblerRef.current;
    if (!meta?.liveTailEnabled || !assembler || !firstEvents) return;
    if (firstEvents === mergedFirstEventsRef.current) return;
    mergedFirstEventsRef.current = firstEvents;
    assembler.mergeChunk(firstEvents.map(toChunkEvent), { source: "revalidate" });
    if (!assembler.changedSinceRender) return;
    rebuild(meta, assembler);
  }, [firstEvents, rebuild]);

  // Stable trigger so the route's SSE effect doesn't re-fire on chunkPath changes.
  useEffect(() => {
    tailLiveRef.current = runTail;
  });
  const tailLive = useCallback(() => tailLiveRef.current(), []);

  // Off unless the flag is on and there is a chunk backend to tail.
  const liveTailEnabled = resolveLiveTailEnabled(progressive);

  return { ...(staticState ?? state), tailLive, liveTailEnabled, retryLoad };
}

async function fetchChunk(
  chunkPath: string,
  showDebug: boolean,
  params: {
    cursor?: TraceChunkCursor;
    filter?: "errors";
    limit?: number;
    insertedAtSince?: number;
  },
  timeoutMs?: number
): Promise<WireChunkResponse | null> {
  const url = new URL(chunkPath, window.location.origin);
  if (params.cursor) {
    url.searchParams.set("cursorStartTime", params.cursor.startTime);
    url.searchParams.set("cursorSpanId", params.cursor.spanId);
  }
  if (params.insertedAtSince !== undefined) {
    url.searchParams.set("insertedAtSince", String(params.insertedAtSince));
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
    const response = await fetch(url.toString(), {
      headers: { accept: "application/json" },
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!response.ok) return null;
    return (await response.json()) as WireChunkResponse;
  } catch {
    return null;
  }
}
