// The charts shared by the figures: static SVG laid out the way the webapp's recharts setup draws
// them (primitives/charts: ChartLine, ChartBar, ChartLegendCompound).

/** formatNumberCompact: 1050 → "1.1K". */
export function compact(v: number) {
  return v >= 1000 ? `${Math.round(v / 100) / 10}K` : `${v}`;
}

/** useYAxisWidth: the axis is sized from the largest value's label. */
function yAxisWidth(label: string) {
  return Math.max(32, Math.ceil((label.length + 1) * 6.5) + 16);
}

export type Series = { key: string; label: string; color: string; values: number[] };

const tickText = {
  fontSize: 11,
  fill: "var(--color-text-dimmed)",
  style: { fontVariantNumeric: "tabular-nums" },
} as const;

/**
 * A chart as recharts lays it out: margins 5/20/5/5, y ticks 14px left of the plot, horizontal grid
 * lines, x labels angled -45° (65px axis) with a 3px tick mark as the query widget's date axis does,
 * or level under the plot (30px axis) as a plain Chart.Bar does.
 * Lines are 1px with 1.5px dots on a time axis; bars are stacked in bands with a 1px gap each side.
 */
export function Chart({
  kind,
  width,
  height,
  yTicks,
  yFormat = compact,
  maxLabel,
  xLabels,
  series,
  angled = true,
}: {
  kind: "line" | "bar";
  width: number;
  height: number;
  /** Tick values; the last one is the top of the domain. */
  yTicks: number[];
  yFormat?: (v: number) => string;
  /** The largest value's label, which sets the y-axis width. */
  maxLabel: string;
  /** One label per point; "" for no tick. */
  xLabels: string[];
  series: Series[];
  angled?: boolean;
}) {
  const left = 5 + yAxisWidth(maxLabel);
  const right = width - 20;
  const top = 5;
  const bottom = height - 5 - (angled ? 65 : 30);
  const n = xLabels.length;
  const band = (right - left) / n;
  const x = (i: number) =>
    kind === "line" ? left + (i * (right - left)) / (n - 1) : left + band * (i + 0.5);
  const max = yTicks[yTicks.length - 1];
  const y = (v: number) => bottom - (v / max) * (bottom - top);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block">
      {yTicks.map((t) => (
        <line
          key={t}
          x1={left}
          x2={right}
          y1={y(t)}
          y2={y(t)}
          stroke="var(--color-grid-bright)"
          strokeDasharray={kind === "line" ? "3 3" : undefined}
        />
      ))}
      {yTicks.map((t) => (
        <text key={t} x={left - 14} y={y(t)} dy="0.355em" textAnchor="end" {...tickText}>
          {yFormat(t)}
        </text>
      ))}
      {xLabels.map((label, i) => {
        if (!label) return null;
        const ax = x(i);
        // A plain axis puts the label 16px under the plot (tickMargin 10 + tick size 6).
        if (!angled)
          return (
            <text key={i} x={ax} y={bottom + 16} dy="0.71em" textAnchor="middle" {...tickText}>
              {label}
            </text>
          );
        const ay = bottom + 4;
        return (
          <g key={i}>
            <line x1={ax} x2={ax} y1={ay} y2={ay - 3} stroke="var(--color-text-dimmed)" />
            <text
              x={ax}
              y={ay}
              dy={10}
              textAnchor="end"
              transform={`rotate(-45, ${ax}, ${ay + 10})`}
              {...tickText}
            >
              {label}
            </text>
          </g>
        );
      })}
      {kind === "line"
        ? series.map((s) => (
            <g key={s.key}>
              <path
                d={s.values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("")}
                stroke={s.color}
                strokeWidth={1}
                fill="none"
              />
              {s.values.map((v, i) => (
                <circle key={i} cx={x(i)} cy={y(v)} r={1.5} fill={s.color} />
              ))}
            </g>
          ))
        : xLabels.map((_, i) => {
            let base = 0;
            return (
              <g key={i}>
                {series.map((s) => {
                  const v = s.values[i];
                  const y0 = y(base);
                  base += v;
                  // shortcut: square corners; the webapp rounds the outer bars of a stack by 2px.
                  return (
                    <rect
                      key={s.key}
                      x={x(i) - band / 2 + 1}
                      width={band - 2}
                      y={y(base)}
                      height={y0 - y(base)}
                      fill={s.color}
                    />
                  );
                })}
              </g>
            );
          })}
    </svg>
  );
}

/** ChartLegendCompound: the aggregate row, a divider, one row per series and "N more…". */
export function Legend({
  label,
  total,
  items,
  more,
}: {
  label: string;
  total: string;
  items: { label: string; color: string; value: string }[];
  more?: number;
}) {
  return (
    <div className="flex flex-col px-2 pb-2 pt-4 text-sm">
      <div className="flex w-full shrink-0 items-center justify-between gap-2 rounded px-2 py-1 text-text-dimmed">
        <span className="font-medium">{label}</span>
        <span className="shrink-0 font-medium tabular-nums">{total}</span>
      </div>
      <div className="mx-2 my-1 shrink-0 border-t border-grid-dimmed" />
      <div className="flex flex-col">
        {items.map((item) => (
          <div
            key={item.label}
            className="relative flex w-full items-center justify-between gap-2 rounded px-2 py-1"
          >
            <div className="relative flex w-full items-center justify-between gap-3 overflow-hidden">
              <div className="flex min-w-0 items-center gap-1.5">
                <div
                  className="w-1 shrink-0 self-stretch rounded-[2px]"
                  style={{ backgroundColor: item.color }}
                />
                <span className="truncate text-text-dimmed">{item.label}</span>
              </div>
              <span className="shrink-0 self-start tabular-nums text-text-dimmed">
                {item.value}
              </span>
            </div>
          </div>
        ))}
        {more ? (
          <div className="relative flex w-full items-center justify-between gap-2 rounded px-2 py-1">
            <div className="relative flex w-full items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                <div className="w-1 shrink-0 self-stretch rounded-[2px] border border-border-bright" />
                <span className="text-text-dimmed tabular-nums">{more} more…</span>
              </div>
              <span className="self-start text-text-link">View all</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The legend's height: pt-4 and pb-2, the 28px total row, the 9px divider and 28px per row. */
export const legendHeight = (rows: number) => 16 + 28 + 9 + 28 * rows + 8;
