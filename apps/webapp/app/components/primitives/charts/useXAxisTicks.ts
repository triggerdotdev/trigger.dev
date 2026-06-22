import { useMemo } from "react";

// Mirrors useYAxisWidth: at 11px tabular-nums, 1 char ≈ 6.5px. Labels use
// tabular-nums so character count is a faithful width proxy.
const PX_PER_CH = 6.5;
// Minimum horizontal breathing room between two adjacent labels.
const LABEL_GAP_PX = 16;
// Floor so very short labels still get some space.
const MIN_LABEL_PX = 24;

/**
 * Pick `count` indices evenly spaced across [0, n), always including the first
 * and last. "Evenly spaced" here means even *screen* spacing on a band axis
 * (each bucket occupies an equal slice of the plot width).
 */
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
  // Rounding can drop the final index — guarantee the last is present.
  if (!seen.has(n - 1)) out.push(n - 1);
  return out;
}

/**
 * Pick `maxLabels` values evenly spaced across `values`, always including the
 * first and last.
 */
export function selectEvenlySpacedTicks<T>(values: T[], maxLabels: number): T[] {
  return selectEvenlySpacedIndices(values.length, maxLabels).map((i) => values[i]);
}

/**
 * How many labels of `maxLabelChars` width fit in `width` pixels.
 */
export function estimateMaxLabels(width: number, maxLabelChars: number): number {
  if (!width || width <= 0) return 0;
  const labelPx = Math.max(MIN_LABEL_PX, maxLabelChars * PX_PER_CH) + LABEL_GAP_PX;
  return Math.max(1, Math.floor(width / labelPx));
}

/**
 * Compute the explicit x-axis tick values to render labels at, so they:
 *  - are evenly spaced across the plot (no crowding, even when the first/last
 *    bucket is a partial period),
 *  - never overlap (count is bounded by how many fit in `plotWidth`),
 *  - never repeat the same text (count is also bounded by the number of
 *    distinct labels),
 *  - stay horizontal and include the first + last bucket.
 *
 * `plotWidth` is the width of the plotting area (full width minus the y-axis and
 * horizontal margins), so the "how many fit" estimate matches the area labels
 * are actually drawn in. Returns `undefined` until a width is known (first paint).
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

    // How many labels fit, capped at the number of distinct labels — there's no
    // point reserving slots for more labels than there are unique values. The
    // distinct cap is what keeps spacing even: we lay out N evenly-spaced labels
    // rather than one-per-period (which crowds when the first period is partial).
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
