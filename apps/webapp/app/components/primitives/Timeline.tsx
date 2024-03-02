import { ReactNode } from "react";

// const TimelineContext = createContext<>();

/* <Timeline.Root startMs={} durationMs={} scale={}>
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
        <Timeline.Row className="">
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
