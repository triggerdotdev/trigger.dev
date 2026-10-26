import { millisecondsToNanoseconds, nanosecondsToMilliseconds } from "@trigger.dev/core/v3";
import { createContext, useContext, useEffect, useState } from "react";
import * as Timeline from "~/components/primitives/Timeline";

/** The time scale a span timeline row is drawn on. */
export type TraceTimelineScale = {
  /** Queue-adjusted run duration (ns). Bars are clamped to it. */
  durationNs: number;
  /** Queued time (ns) taken off every offset, or undefined while queue time is shown. */
  queuedDurationNs: number | undefined;
};

const TraceTimelineScaleContext = createContext<TraceTimelineScale | undefined>(undefined);

export function useTraceTimelineScale(): TraceTimelineScale {
  const scale = useContext(TraceTimelineScaleContext);
  if (!scale) {
    throw new Error("useTraceTimelineScale must be used inside a TraceTimelineScaleProvider");
  }
  return scale;
}

/** Sets the scale for the rows inside it. The surrounding Timeline.Root sets the time range. */
export function TraceTimelineScaleProvider({
  scale,
  children,
}: {
  scale: TraceTimelineScale;
  children: React.ReactNode;
}) {
  return (
    <TraceTimelineScaleContext.Provider value={scale}>
      {children}
    </TraceTimelineScaleContext.Provider>
  );
}

// A queued run has no duration yet; a zero range would put every bar at NaN.
const MIN_ROW_DURATION_NS = 1_000_000;

/** Gives the rows inside it their own scale and time range, e.g. one run among several. */
export function TraceTimelineRowScale({
  scale,
  children,
}: {
  scale: TraceTimelineScale;
  children: React.ReactNode;
}) {
  return (
    <TraceTimelineScaleProvider scale={scale}>
      <Timeline.Scale
        durationMs={timelineDurationMs(Math.max(scale.durationNs, MIN_ROW_DURATION_NS))}
      >
        {children}
      </Timeline.Scale>
    </TraceTimelineScaleProvider>
  );
}

/** The visible range: the duration plus 5% headroom. */
export function timelineDurationMs(durationNs: number) {
  return nanosecondsToMilliseconds(durationNs * 1.05);
}

export function queueAdjustedNs(timeNs: number, queuedDurationNs: number | undefined) {
  if (queuedDurationNs) {
    return timeNs - queuedDurationNs;
  }

  return timeNs;
}

/** Queue-adjusted duration (ns) that keeps counting up while the root span is executing. */
export function useLiveDuration({
  totalDuration,
  rootSpanStatus,
  rootStartedAt,
  queuedDuration,
}: {
  totalDuration: number;
  rootSpanStatus: "executing" | "completed" | "failed";
  rootStartedAt: Date | undefined;
  queuedDuration: number | undefined;
}) {
  const [duration, setDuration] = useState(queueAdjustedNs(totalDuration, queuedDuration));
  // Callers often pass a new Date each render; key on the time so the interval isn't reset.
  const rootStartedAtMs = rootStartedAt?.getTime();
  useEffect(() => {
    if (rootSpanStatus !== "executing" || rootStartedAtMs === undefined) {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setDuration(queueAdjustedNs(totalDuration, queuedDuration));
      return;
    }

    const interval = setInterval(() => {
      setDuration(
        queueAdjustedNs(millisecondsToNanoseconds(Date.now() - rootStartedAtMs), queuedDuration)
      );
    }, 500);

    return () => clearInterval(interval);
  }, [totalDuration, rootSpanStatus, queuedDuration, rootStartedAtMs]);

  return duration;
}
