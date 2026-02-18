import React, { createContext, useContext, useMemo } from "react";
import type { ChartConfig, ChartState } from "./Chart";
import { useHighlightState, type UseHighlightStateReturn } from "./hooks/useHighlightState";
import {
  useZoomSelection,
  type UseZoomSelectionReturn,
  type ZoomRange,
} from "./hooks/useZoomSelection";

/** Function to format the x-axis label for display */
export type LabelFormatter = (value: string) => string;

export type ChartContextValue = {
  // Core data
  config: ChartConfig;
  data: any[];
  dataKey: string;
  /** Computed series keys (all config keys except dataKey) */
  dataKeys: string[];
  /** Subset of dataKeys actually rendered as SVG elements (defaults to dataKeys) */
  visibleSeries: string[];

  // Display state
  state?: ChartState;

  // Formatters
  /** Function to format the x-axis label (used in legend, tooltips, etc.) */
  labelFormatter?: LabelFormatter;

  // Highlight state
  highlight: UseHighlightStateReturn;

  // Zoom state (only present when zoom is enabled)
  zoom: UseZoomSelectionReturn | null;

  // Zoom callback (only present when zoom is enabled)
  onZoomChange?: (range: ZoomRange) => void;

  // Whether the compound legend is shown (disables tooltip when true)
  showLegend: boolean;
};

const ChartCompoundContext = createContext<ChartContextValue | null>(null);

export function useChartContext(): ChartContextValue {
  const context = useContext(ChartCompoundContext);
  if (!context) {
    throw new Error("useChartContext must be used within a Chart.Root component");
  }
  return context;
}

export type ChartProviderProps = {
  config: ChartConfig;
  data: any[];
  dataKey: string;
  /** Series keys to render (if not provided, derived from config keys) */
  series?: string[];
  /** Subset of series to render as SVG elements on the chart (legend still shows all series) */
  visibleSeries?: string[];
  state?: ChartState;
  /** Function to format the x-axis label (used in legend, tooltips, etc.) */
  labelFormatter?: LabelFormatter;
  /** Enable zoom functionality */
  enableZoom?: boolean;
  /** Callback when zoom range changes */
  onZoomChange?: (range: ZoomRange) => void;
  /** Whether the compound legend is shown (disables tooltip when true) */
  showLegend?: boolean;
  children: React.ReactNode;
};

export function ChartProvider({
  config,
  data,
  dataKey,
  series,
  visibleSeries: visibleSeriesProp,
  state,
  labelFormatter,
  enableZoom = false,
  onZoomChange,
  showLegend = false,
  children,
}: ChartProviderProps) {
  const highlight = useHighlightState();
  const zoomState = useZoomSelection();

  // Compute series keys (use provided series or derive from config)
  const dataKeys = useMemo(
    () => series ?? Object.keys(config).filter((k) => k !== dataKey),
    [series, config, dataKey]
  );

  const visibleSeries = useMemo(
    () => visibleSeriesProp ?? dataKeys,
    [visibleSeriesProp, dataKeys]
  );

  const value = useMemo<ChartContextValue>(
    () => ({
      config,
      data,
      dataKey,
      dataKeys,
      visibleSeries,
      state,
      labelFormatter,
      highlight,
      zoom: enableZoom ? zoomState : null,
      onZoomChange: enableZoom ? onZoomChange : undefined,
      showLegend,
    }),
    [config, data, dataKey, dataKeys, visibleSeries, state, labelFormatter, highlight, zoomState, enableZoom, onZoomChange, showLegend]
  );

  return <ChartCompoundContext.Provider value={value}>{children}</ChartCompoundContext.Provider>;
}
