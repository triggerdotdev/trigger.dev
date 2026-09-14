export type ChartCardLegendEntry = { key?: string; color: string; label: string };

/**
 * Inline swatch legend for a chart card title (swatch + label per series), matching the list-page
 * charts — instead of the Chart.Root legend with per-series totals.
 */
export function ChartCardLegend({ entries }: { entries: ChartCardLegendEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {entries.map((entry) => (
        <span
          key={entry.key ?? entry.label}
          className="flex items-center gap-1 text-xs font-normal text-text-dimmed"
        >
          <span className="size-2.5 rounded-[2px]" style={{ backgroundColor: entry.color }} />
          {entry.label}
        </span>
      ))}
    </span>
  );
}
