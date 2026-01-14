import { useCallback, useState } from "react";

export type HighlightState = {
  /** The currently highlighted series key (e.g., "completed", "failed") */
  activeBarKey: string | null;
  /** The index of the specific data point being hovered (null when hovering legend) */
  activeDataPointIndex: number | null;
  /** The payload data from the hovered element */
  activePayload: any[] | null;
  /** Whether the tooltip is currently active */
  tooltipActive: boolean;
};

export type HighlightActions = {
  /** Set the hovered bar (specific data point) */
  setHoveredBar: (key: string, index: number, payload?: any[]) => void;
  /** Set the hovered legend item (highlights all bars of that type) */
  setHoveredLegendItem: (key: string) => void;
  /** Set the active payload (for tooltip data) */
  setActivePayload: (payload: any[] | null) => void;
  /** Set tooltip active state */
  setTooltipActive: (active: boolean) => void;
  /** Reset all highlight state */
  reset: () => void;
};

export type UseHighlightStateReturn = HighlightState & HighlightActions;

const initialState: HighlightState = {
  activeBarKey: null,
  activeDataPointIndex: null,
  activePayload: null,
  tooltipActive: false,
};

/**
 * Hook to manage highlight state for chart elements.
 * Handles both bar hover (specific data point) and legend hover (all bars of a type).
 */
export function useHighlightState(): UseHighlightStateReturn {
  const [state, setState] = useState<HighlightState>(initialState);

  const setHoveredBar = useCallback((key: string, index: number, payload?: any[]) => {
    setState({
      activeBarKey: key,
      activeDataPointIndex: index,
      activePayload: payload ?? null,
      tooltipActive: true,
    });
  }, []);

  const setHoveredLegendItem = useCallback((key: string) => {
    setState((prev) => ({
      ...prev,
      activeBarKey: key,
      activeDataPointIndex: null, // null indicates legend hover (all bars of this type)
    }));
  }, []);

  const setActivePayload = useCallback((payload: any[] | null) => {
    setState((prev) => ({
      ...prev,
      activePayload: payload,
    }));
  }, []);

  const setTooltipActive = useCallback((active: boolean) => {
    setState((prev) => ({
      ...prev,
      tooltipActive: active,
    }));
  }, []);

  const reset = useCallback(() => {
    setState(initialState);
  }, []);

  return {
    ...state,
    setHoveredBar,
    setHoveredLegendItem,
    setActivePayload,
    setTooltipActive,
    reset,
  };
}

/**
 * Calculate the opacity for a bar based on highlight state.
 * @param key - The series key of this bar
 * @param dataIndex - The data point index of this bar
 * @param highlight - The current highlight state
 * @param dimmedOpacity - The opacity to use for dimmed bars (default 0.2)
 */
export function getBarOpacity(
  key: string,
  dataIndex: number,
  highlight: HighlightState,
  dimmedOpacity = 0.2
): number {
  const { activeBarKey, activeDataPointIndex } = highlight;

  // No highlight active - full opacity
  if (activeBarKey === null) {
    return 1;
  }

  // Hovering a specific bar (from chart)
  if (activeDataPointIndex !== null) {
    return key === activeBarKey && dataIndex === activeDataPointIndex ? 1 : dimmedOpacity;
  }

  // Hovering a legend item (all bars of this type)
  return key === activeBarKey ? 1 : dimmedOpacity;
}
