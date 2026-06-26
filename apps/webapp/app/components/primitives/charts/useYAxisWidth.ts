import { useMemo } from "react";

// 1ch at 11px tabular-nums system-ui ≈ 6.5px. Recharts' YAxis.width prop is a
// raw number (pixels), so we can't use the CSS `ch` unit directly — but tabular-nums
// guarantees uniform char width, which makes `chars * pxPerCh` a faithful proxy.
const PX_PER_CH = 6.5;
const PADDING_PX = 16;
const MIN_WIDTH = 32;
const MAX_WIDTH = 120;

export function useYAxisWidth(
  data: Array<Record<string, any>> | undefined,
  visibleSeries: string[],
  tickFormatter?: (value: any, index: number) => string
): number {
  return useMemo(() => {
    if (!data?.length || !visibleSeries.length) return MIN_WIDTH;

    let max = 0;
    for (const point of data) {
      for (const key of visibleSeries) {
        const v = Number(point[key]);
        if (Number.isFinite(v) && v > max) max = v;
      }
    }

    const fmt =
      tickFormatter ?? ((v: any) => (typeof v === "number" ? v.toLocaleString() : String(v)));
    const label = fmt(max, 0);
    // Add one char of slack because recharts "nices" the domain up beyond data max.
    const charCount = label.length + 1;
    const width = Math.ceil(charCount * PX_PER_CH) + PADDING_PX;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
  }, [data, visibleSeries, tickFormatter]);
}
