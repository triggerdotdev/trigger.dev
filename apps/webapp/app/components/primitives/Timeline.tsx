type TimelineProps = {
  totalDurationMs: number;
  tickCount: number;
  /** A number between 0 and 1 */
  scale: number;
  minWidth?: number;
  maxWidth?: number;
  className?: string;
};

export function Timeline({
  totalDurationMs,
  tickCount,
  scale = 0.5,
  minWidth = 300,
  maxWidth = 2000,
  className,
}: TimelineProps) {
  const pixelWidth = calculatePixelWidth(minWidth, maxWidth, scale);
  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: `${pixelWidth}px`,
      }}
    ></div>
  );
}

function calculatePixelWidth(minWidth: number, maxWidth: number, scale: number) {
  return lerp(minWidth, maxWidth, scale);
}

/** Linearly interpolates between the min/max values, using t.
 * It can't go outside the range   */
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * clamp(t, 0, 1);
}

/** Clamps a value between a min and max */
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
