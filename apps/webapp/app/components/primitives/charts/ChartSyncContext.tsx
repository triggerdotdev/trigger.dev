import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

/**
 * Cross-chart sync for a group of charts sharing an x-axis domain. Wrap them in one
 * <ChartSyncProvider>; both behaviours mirror across every chart: a hover indicator
 * (vertical line at the hovered x), and drag-to-zoom (a selection rectangle that
 * commits the range via `onZoom`, e.g. to set the Time/Date filter).
 *
 * Chart.Bar reads this via useChartSync, a no-op when no provider is present.
 * Drag-to-zoom is active only when `onZoom` is provided.
 */

type ChartSyncXValue = number | string | null;

/** Committed zoom range (epoch ms). */
export type ChartZoomRange = { start: number; end: number };

/** In-progress drag selection (raw x values; not yet ordered). */
type ZoomSelection = { start: number | string; current: number | string };

type ChartSyncContextValue = {
  /** The x-axis value currently hovered in any chart in the group. */
  activeX: ChartSyncXValue;
  setActiveX: (x: ChartSyncXValue) => void;

  /** Whether drag-to-zoom is active (an onZoom handler was provided). */
  zoomEnabled: boolean;
  /** Current drag selection, mirrored across charts; null when not dragging. */
  zoomSelection: ZoomSelection | null;
  startZoom: (x: number | string) => void;
  updateZoom: (x: number | string) => void;
  /** Finish the drag and commit the range (adds `bucketWidthMs` so the last bucket is included). */
  endZoom: (bucketWidthMs?: number) => void;
  cancelZoom: () => void;
};

const ChartSyncContext = createContext<ChartSyncContextValue | null>(null);

/**
 * Turn a raw drag selection into an ordered, inclusive range. Returns null for
 * a non-drag (start === current) or non-numeric selection.
 */
export function computeZoomRange(
  start: number | string,
  current: number | string,
  bucketWidthMs = 0
): ChartZoomRange | null {
  const a = Number(start);
  const b = Number(current);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  const width = Number.isFinite(bucketWidthMs) ? bucketWidthMs : 0;
  return { start: Math.min(a, b), end: Math.max(a, b) + width };
}

export function ChartSyncProvider({
  children,
  onZoom,
}: {
  children: React.ReactNode;
  /** Called with the selected range when a drag-to-zoom completes. */
  onZoom?: (range: ChartZoomRange) => void;
}) {
  const [activeX, setActiveXState] = useState<ChartSyncXValue>(null);
  const [zoomSelection, setZoomSelection] = useState<ZoomSelection | null>(null);
  // Track selection synchronously so endZoom (fired on mouseup) reads the latest.
  const selectionRef = useRef<ZoomSelection | null>(null);

  const setActiveX = useCallback((x: ChartSyncXValue) => setActiveXState(x), []);

  const startZoom = useCallback((x: number | string) => {
    const next = { start: x, current: x };
    selectionRef.current = next;
    setZoomSelection(next);
  }, []);

  const updateZoom = useCallback((x: number | string) => {
    const prev = selectionRef.current;
    if (!prev) return;
    const next = { start: prev.start, current: x };
    selectionRef.current = next;
    setZoomSelection(next);
  }, []);

  const cancelZoom = useCallback(() => {
    selectionRef.current = null;
    setZoomSelection(null);
  }, []);

  const endZoom = useCallback(
    (bucketWidthMs = 0) => {
      const sel = selectionRef.current;
      selectionRef.current = null;
      setZoomSelection(null);
      if (!sel) return;
      const range = computeZoomRange(sel.start, sel.current, bucketWidthMs);
      if (range) onZoom?.(range);
    },
    [onZoom]
  );

  const value = useMemo<ChartSyncContextValue>(
    () => ({
      activeX,
      setActiveX,
      zoomEnabled: onZoom != null,
      zoomSelection,
      startZoom,
      updateZoom,
      endZoom,
      cancelZoom,
    }),
    [activeX, setActiveX, onZoom, zoomSelection, startZoom, updateZoom, endZoom, cancelZoom]
  );

  return <ChartSyncContext.Provider value={value}>{children}</ChartSyncContext.Provider>;
}

/** Returns the sync context, or null when not inside a ChartSyncProvider. */
export function useChartSync(): ChartSyncContextValue | null {
  return useContext(ChartSyncContext);
}
