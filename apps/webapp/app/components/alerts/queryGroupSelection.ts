import type { MetricSeriesPoint } from "./alertSeriesTypes";

export const MAX_VISIBLE_GROUPS = 8;

// Groups that crossed the threshold have the best values toward it, so they sort first.
export function defaultGroupSelection({
  groups,
  seriesMap,
  operator,
  range,
  max = MAX_VISIBLE_GROUPS,
}: {
  groups: string[];
  seriesMap: Map<string, MetricSeriesPoint[]>;
  operator?: ">" | "<";
  range?: { since: number; until: number };
  max?: number;
}): string[] {
  const below = operator === "<";
  const scored = groups.map((group, index) => {
    let best: number | null = null;
    for (const p of seriesMap.get(group) ?? []) {
      if (p.value === null) continue;
      if (range && (p.bucket < range.since || p.bucket > range.until)) continue;
      if (best === null || (below ? p.value < best : p.value > best)) best = p.value;
    }
    return { group, index, best };
  });
  const toward = (best: number | null) => (best === null ? -Infinity : below ? -best : best);
  return scored
    .sort((a, b) => toward(b.best) - toward(a.best) || a.index - b.index)
    .slice(0, max)
    .map((s) => s.group);
}
