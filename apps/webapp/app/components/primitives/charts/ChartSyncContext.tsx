import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * Cross-chart hover synchronization.
 *
 * Wrap a group of charts that share an x-axis domain in a single
 * <ChartSyncProvider>. When the user hovers one chart, every chart in the
 * group renders a vertical indicator line at the same x value, so the same
 * point in time is highlighted across all of them.
 *
 * Chart.Bar reads this context automatically (via useChartSync) — it is a
 * no-op when no provider is present, so other pages are unaffected.
 *
 * Modeled on DateRangeContext (the existing cross-chart sync mechanism).
 */

type ChartSyncXValue = number | string | null;

type ChartSyncContextValue = {
  /** The x-axis value currently hovered in any chart in the group. */
  activeX: ChartSyncXValue;
  setActiveX: (x: ChartSyncXValue) => void;
};

const ChartSyncContext = createContext<ChartSyncContextValue | null>(null);

export function ChartSyncProvider({ children }: { children: React.ReactNode }) {
  const [activeX, setActiveXState] = useState<ChartSyncXValue>(null);
  const setActiveX = useCallback((x: ChartSyncXValue) => setActiveXState(x), []);
  const value = useMemo(() => ({ activeX, setActiveX }), [activeX, setActiveX]);

  return <ChartSyncContext.Provider value={value}>{children}</ChartSyncContext.Provider>;
}

/** Returns the sync context, or null when not inside a ChartSyncProvider. */
export function useChartSync(): ChartSyncContextValue | null {
  return useContext(ChartSyncContext);
}
