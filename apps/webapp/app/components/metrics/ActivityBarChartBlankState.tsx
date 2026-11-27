// No recharts in here: pages show this while the chart code and its data load.

// Fixed px dims skip ResponsiveContainer's ResizeObserver — otherwise every panel resize
// re-renders all the charts in a list at once.
export const ACTIVITY_CHART_WIDTH = 112;
export const ACTIVITY_CHART_HEIGHT = 24;
export const ACTIVITY_CHART_PEAK_CLASS =
  "-mt-1 inline-block min-w-7 text-xxs tabular-nums text-text-dimmed";

// SVG line matches recharts' y=0 ReferenceLine anti-aliasing; a CSS border looks too crisp.
export function ActivityBarChartBlankState({ width = ACTIVITY_CHART_WIDTH }: { width?: number }) {
  return (
    <div className="flex items-start gap-1.5">
      <svg width={width} height={ACTIVITY_CHART_HEIGHT} className="rounded-sm">
        <line
          x1={0}
          y1={ACTIVITY_CHART_HEIGHT}
          x2={width}
          y2={ACTIVITY_CHART_HEIGHT}
          stroke="var(--color-border-bright)"
          strokeWidth={1}
        />
      </svg>
      <span className={ACTIVITY_CHART_PEAK_CLASS}>0</span>
    </div>
  );
}
