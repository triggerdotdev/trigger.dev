import { ReferenceLine } from "recharts";

export type VerticalMarker = {
  x: number;
  label: string;
  color: string;
  anchor: "start" | "middle" | "end";
};

const RAISE_TICK_MIN_GAP = 0.2;

export function dropTicksNearRaise(
  ticks: number[],
  raise: number,
  gap = RAISE_TICK_MIN_GAP
): number[] {
  const range = Math.max(...ticks) - Math.min(...ticks);
  return ticks.filter((t) => t === raise || Math.abs(t - raise) >= range * gap);
}

export function compactRaiseTicks(
  buckets: number[],
  dayTicks: number[] | undefined,
  marker: Pick<VerticalMarker, "x">
): number[] {
  if (buckets.length === 0) return dayTicks ?? [];
  const first = buckets[0]!;
  const last = buckets[buckets.length - 1]!;
  const far = marker.x - first > (last - first) / 2 ? first : last;
  return [...new Set([far, marker.x])].sort((a, b) => a - b);
}

export function raisedAwareTick(marker: VerticalMarker, format: (value: number) => string) {
  return function RaisedAwareTick({
    x,
    y,
    payload,
  }: {
    x: number;
    y: number;
    payload: { value: number };
  }) {
    const raised = payload.value === marker.x;
    return (
      <text
        x={x}
        y={y}
        dy="0.71em"
        textAnchor={raised ? marker.anchor : "middle"}
        fontSize={11}
        style={{
          fontVariantNumeric: "tabular-nums",
          fill: raised ? marker.color : "var(--color-text-dimmed)",
        }}
      >
        {raised ? marker.label : format(payload.value)}
      </text>
    );
  };
}

export function verticalMarkerLine(marker: VerticalMarker) {
  return (
    <ReferenceLine
      key={`marker-${marker.x}`}
      x={marker.x}
      stroke={marker.color}
      strokeDasharray="4 4"
      strokeWidth={1}
      ifOverflow="extendDomain"
    />
  );
}
