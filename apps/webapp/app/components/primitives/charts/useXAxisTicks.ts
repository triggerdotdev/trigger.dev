import { useMemo } from "react";

// At 11px tabular-nums, 1 char ≈ 6.5px, so character count is a width proxy (see useYAxisWidth).
const PX_PER_CH = 6.5;
// Minimum gap between adjacent labels.
const LABEL_GAP_PX = 16;
// Floor so very short labels still get some space.
const MIN_LABEL_PX = 24;

/** Pick `count` indices evenly spaced across [0, n), always including the first and last. */
export function selectEvenlySpacedIndices(n: number, count: number): number[] {
  if (n <= 0) return [];
  if (count <= 1) return [0];
  if (count >= n) return Array.from({ length: n }, (_, i) => i);
  if (count === 2) return [0, n - 1];

  const step = (n - 1) / (count - 1);
  const out: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const idx = Math.round(i * step);
    if (!seen.has(idx)) {
      seen.add(idx);
      out.push(idx);
    }
  }
  // Rounding can drop the final index; force it in.
  if (!seen.has(n - 1)) out.push(n - 1);
  return out;
}

/** Pick `maxLabels` values evenly spaced across `values`, always including the first and last. */
export function selectEvenlySpacedTicks<T>(values: T[], maxLabels: number): T[] {
  return selectEvenlySpacedIndices(values.length, maxLabels).map((i) => values[i]);
}

/** How many labels of `maxLabelChars` width fit in `width` pixels. */
export function estimateMaxLabels(width: number, maxLabelChars: number): number {
  if (!width || width <= 0) return 0;
  const labelPx = Math.max(MIN_LABEL_PX, maxLabelChars * PX_PER_CH) + LABEL_GAP_PX;
  return Math.max(1, Math.floor(width / labelPx));
}

/**
 * Explicit x-axis tick values: evenly spaced across the plot, including first +
 * last, bounded by how many fit in `plotWidth` and by the count of distinct
 * labels (so nothing overlaps or repeats). `plotWidth` excludes the y-axis and
 * margins. Returns `undefined` until a width is known (first paint).
 */
export function useXAxisTicks(
  data: Array<Record<string, any>>,
  dataKey: string,
  plotWidth: number | undefined,
  tickFormatter?: (value: any, index: number) => string
): any[] | undefined {
  return useMemo(() => {
    if (!data?.length || !plotWidth || plotWidth <= 0) return undefined;

    const n = data.length;
    const fmt = tickFormatter ?? ((v: any) => String(v));
    const labels = data.map((d, i) => fmt(d[dataKey], i) ?? "");

    let maxChars = 0;
    for (const label of labels) {
      if (label.length > maxChars) maxChars = label.length;
    }

    // Cap at distinct labels: laying out N evenly-spaced labels (vs one-per-period)
    // keeps spacing even when the first/last period is partial.
    const fit = estimateMaxLabels(plotWidth, maxChars);
    const distinct = new Set(labels).size;
    const target = Math.min(fit, distinct, n);

    // Evenly spaced on screen, then drop any that repeat the previous label.
    const ticks: any[] = [];
    let lastLabel: string | null = null;
    for (const idx of selectEvenlySpacedIndices(n, target)) {
      if (labels[idx] === lastLabel) continue;
      lastLabel = labels[idx];
      ticks.push(data[idx][dataKey]);
    }
    return ticks;
  }, [data, dataKey, plotWidth, tickFormatter]);
}
