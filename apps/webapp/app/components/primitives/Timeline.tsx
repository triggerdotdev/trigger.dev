import { ReactNode, createContext, useContext } from "react";

type TimelineContextState = {
  startMs: number;
  durationMs: number;
};
const TimelineContext = createContext<TimelineContextState>({} as TimelineContextState);

function useTimeline() {
  return useContext(TimelineContext);
}

export type RootProps = {
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

export type PointProps = {
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

export type SpanProps = {
  startMs: number;
  durationMs: number;
  className?: string;
  children?: ReactNode;
};

export function Span({ startMs, durationMs, className, children }: SpanProps) {
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

export type EquallyDistributeProps = {
  count: number;
  children: (ms: number, index: number) => ReactNode;
};

export function EquallyDistribute({ count, children }: EquallyDistributeProps) {
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

export type RowProps = { className?: string; children?: ReactNode };

export function Row({ className, children }: RowProps) {
  return (
    <div className={className} style={{ position: "relative" }}>
      {children}
    </div>
  );
}

function calculatePixelWidth(minWidth: number, maxWidth: number, scale: number) {
  return lerp(minWidth, maxWidth, scale);
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
