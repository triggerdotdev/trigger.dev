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

/* 
<Timeline.Root startMs={} durationMs={} scale={} minWidth={} maxWidth={}>
    <Timeline.Row className="h-9">
      //duration labels
      <Timeline.EqualDistribution count={5}>
        {({ index, timeMs }) => (
          <div>{timeMs}</div>  
        )}
      </Timeline.EqualDistribution>
    </Timeline.Row>
    <Timeline.Row className="">
      //tick marks, or labels
      <Timeline.EqualDistribution count={5}>
        {({ index, timeMs }) => (
          <div>Tick mark</div>  
        )}
      </Timeline.EqualDistribution>
      {{items.map(item => (
        <Timeline.Row className="h-9">
          <TimelineSpan startMs={} durationMs={}><div /></TimelineSpan>
          <TimelinePoint ms={}><div /></TimelinePoint>
        </Timeline.Row>
      )}}
    </Timeline.Row>
    //used for the hover effect
    <Timeline.Cursor>{({ ms }) => ()</Timeline.Cursor>
  </Timeline.Root>
*/

type TimelineProps = {
  totalDurationMs: number;
  /** A number between 0 and 1 */
  scale: number;
  minWidth?: number;
  maxWidth?: number;
  className?: string;
  /** Tick marks */
  tickCount?: number;
  renderTick?: (options: { index: number; durationMs: number }) => ReactNode;
  /** Spans */
  spanStartMs?: number;
  spanDurationMs?: number;
  renderSpan?: () => ReactNode;
};

export function Timeline({
  totalDurationMs,
  tickCount = 5,
  scale = 0.5,
  minWidth = 300,
  maxWidth = 2000,
  className,
  renderTick,
  spanStartMs = 0,
  spanDurationMs,
  renderSpan,
}: TimelineProps) {
  const pixelWidth = calculatePixelWidth(minWidth, maxWidth, scale);
  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: `${pixelWidth}px`,
      }}
    >
      {renderTick !== undefined &&
        Array.from({ length: tickCount }).map((_, index) => {
          const position = (100 / (tickCount - 1)) * index;
          const durationMs = (totalDurationMs / tickCount) * index;
          return (
            <div key={index} className="absolute h-full" style={{ top: 0, left: `${position}%` }}>
              {renderTick({
                index,
                durationMs,
              })}
            </div>
          );
        })}
      {renderSpan !== undefined && (
        <div
          className="absolute h-full"
          style={{
            top: 0,
            left: `${inverseLerp(0, totalDurationMs, spanStartMs) * 100}%`,
            width: `${
              inverseLerp(
                0,
                totalDurationMs,
                getSpanDurationMs(spanStartMs, totalDurationMs, spanDurationMs)
              ) * 100
            }%`,
          }}
        >
          {renderSpan()}
        </div>
      )}
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
