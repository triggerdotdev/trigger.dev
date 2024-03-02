import { ReactNode, createContext, useContext } from "react";

type TimelineContextState = {
  startMs: number;
  durationMs: number;
};
const TimelineContext = createContext<TimelineContextState>({} as TimelineContextState);

function useTimeline() {
  return useContext(TimelineContext);
}

type RootProps = {
  /** If the timeline doesn't start at zero. Doesn't impact layout but gives you the times back */
  startMs?: number;
  durationMs: number;
  /** A number between 0 and 1, determines the width between min and max */
  scale: number;
  minWidth: number;
  maxWidth: number;
  children?: ReactNode;
  className?: string;
};

export function Root({
  startMs = 0,
  durationMs,
  scale,
  minWidth,
  maxWidth,
  children,
  className,
}: RootProps) {
  const pixelWidth = calculatePixelWidth(minWidth, maxWidth, scale);
  return (
    <TimelineContext.Provider value={{ startMs, durationMs }}>
      <div
        className={className}
        style={{
          position: "relative",
          width: `${pixelWidth}px`,
        }}
      >
        {children}
      </div>
    </TimelineContext.Provider>
  );
}

type PointProps = {
  ms: number;
  className?: string;
  children?: (ms: number) => ReactNode;
};

export function Point({ ms, className, children }: PointProps) {
  const { startMs, durationMs } = useTimeline();
  const position = inverseLerp(startMs, startMs + durationMs, ms);
  return (
    <div
      className={className}
      style={{
        position: "absolute",
        left: `${position * 100}%`,
      }}
    >
      {children && children(ms)}
    </div>
  );
}

export function Span({
  startMs,
  durationMs,
  className,
  children,
}: {
  startMs: number;
  durationMs: number;
  className?: string;
  children?: ReactNode;
}) {
  const { startMs: rootStartMs, durationMs: rootDurationMs } = useTimeline();
  const position = inverseLerp(rootStartMs, rootStartMs + rootDurationMs, startMs);
  const width =
    inverseLerp(rootStartMs, rootStartMs + rootDurationMs, startMs + durationMs) - position;
  return (
    <div
      className={className}
      style={{
        position: "absolute",
        left: `${position * 100}%`,
        width: `${width * 100}%`,
      }}
    >
      {children}
    </div>
  );
}

export function EquallyDistribute({
  count,
  children,
}: {
  count: number;
  children: (ms: number, index: number) => ReactNode;
}) {
  const { startMs, durationMs } = useTimeline();

  return (
    <>
      {Array.from({ length: count }).map((_, index) => {
        const ms = startMs + (durationMs / (count - 1)) * index;
        return children(ms, index);
      })}
    </>
  );
}

export function Row({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <div className={className} style={{ position: "relative" }}>
      {children}
    </div>
  );
}

function calculatePixelWidth(minWidth: number, maxWidth: number, scale: number) {
  return lerp(minWidth, maxWidth, scale);
}

function getSpanDurationMs(spanStartMs: number, totalDurationMs: number, spanDurationMs?: number) {
  if (spanDurationMs !== undefined) {
    return spanDurationMs;
  }
  return totalDurationMs - spanStartMs;
}

/** Linearly interpolates between the min/max values, using t.
 * It can't go outside the range   */
function lerp(min: number, max: number, t: number) {
  return min + (max - min) * clamp(t, 0, 1);
}

/** Inverse lerp */
function inverseLerp(min: number, max: number, value: number) {
  return (value - min) / (max - min);
}

/** Clamps a value between a min and max */
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
