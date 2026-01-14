import { useCallback, useState } from "react";

export type ZoomRange = {
  start: string;
  end: string;
};

export type ZoomSelectionState = {
  /** Starting point of drag selection (x-axis value) */
  refAreaLeft: string | null;
  /** Ending point of drag selection (x-axis value) */
  refAreaRight: string | null;
  /** Whether user is currently dragging to select */
  isSelecting: boolean;
  /** Whether the current selection is too small to be valid */
  invalidSelection: boolean;
  /** X-axis value for the inspection line (click to inspect) */
  inspectionLine: string | null;
};

export type ZoomSelectionActions = {
  /** Start a new selection at the given x-axis value */
  startSelection: (label: string) => void;
  /** Update the selection as the user drags */
  updateSelection: (label: string, data: any[], dataKey: string, minDataPoints?: number) => void;
  /** Finish the selection and return the range if valid */
  finishSelection: (data: any[], dataKey: string, minDataPoints?: number) => ZoomRange | null;
  /** Cancel the current selection */
  cancelSelection: () => void;
  /** Toggle the inspection line at the given x-axis value */
  toggleInspectionLine: (label: string) => void;
  /** Clear the inspection line */
  clearInspectionLine: () => void;
  /** Reset all zoom state */
  reset: () => void;
};

export type UseZoomSelectionReturn = ZoomSelectionState & ZoomSelectionActions;

const initialState: ZoomSelectionState = {
  refAreaLeft: null,
  refAreaRight: null,
  isSelecting: false,
  invalidSelection: false,
  inspectionLine: null,
};

/**
 * Hook to manage zoom selection state for charts.
 * Handles drag-to-zoom and click-to-inspect functionality.
 */
export function useZoomSelection(): UseZoomSelectionReturn {
  const [state, setState] = useState<ZoomSelectionState>(initialState);

  const startSelection = useCallback((label: string) => {
    setState((prev) => ({
      ...prev,
      refAreaLeft: label,
      refAreaRight: null,
      isSelecting: true,
      invalidSelection: false,
    }));
  }, []);

  const updateSelection = useCallback(
    (label: string, data: any[], dataKey: string, minDataPoints = 3) => {
      setState((prev) => {
        if (!prev.isSelecting || !prev.refAreaLeft) {
          return prev;
        }

        // Check if selection is valid (has enough data points)
        const allLabels = data.map((item) => item[dataKey] as string).filter(Boolean);
        const leftIndex = allLabels.indexOf(prev.refAreaLeft);
        const rightIndex = allLabels.indexOf(label);

        let invalidSelection = false;
        if (leftIndex !== -1 && rightIndex !== -1) {
          const [start, end] = [leftIndex, rightIndex].sort((a, b) => a - b);
          invalidSelection = end - start < minDataPoints - 1;
        } else {
          invalidSelection = true;
        }

        return {
          ...prev,
          refAreaRight: label,
          invalidSelection,
        };
      });
    },
    []
  );

  const finishSelection = useCallback(
    (data: any[], dataKey: string, minDataPoints = 3): ZoomRange | null => {
      let result: ZoomRange | null = null;

      setState((prev) => {
        if (!prev.refAreaLeft || !prev.refAreaRight) {
          return { ...initialState, inspectionLine: prev.inspectionLine };
        }

        const allLabels = data.map((item) => item[dataKey] as string).filter(Boolean);
        const leftIndex = allLabels.indexOf(prev.refAreaLeft);
        const rightIndex = allLabels.indexOf(prev.refAreaRight);

        if (leftIndex !== -1 && rightIndex !== -1) {
          const [startIdx, endIdx] = [leftIndex, rightIndex].sort((a, b) => a - b);

          // Only create a valid range if we have enough data points
          if (endIdx - startIdx >= minDataPoints - 1) {
            result = {
              start: allLabels[startIdx],
              end: allLabels[endIdx],
            };
          }
        }

        return { ...initialState, inspectionLine: prev.inspectionLine };
      });

      return result;
    },
    []
  );

  const cancelSelection = useCallback(() => {
    setState((prev) => ({
      ...initialState,
      inspectionLine: prev.inspectionLine,
    }));
  }, []);

  const toggleInspectionLine = useCallback((label: string) => {
    setState((prev) => ({
      ...prev,
      inspectionLine: prev.inspectionLine === label ? null : label,
    }));
  }, []);

  const clearInspectionLine = useCallback(() => {
    setState((prev) => ({
      ...prev,
      inspectionLine: null,
    }));
  }, []);

  const reset = useCallback(() => {
    setState(initialState);
  }, []);

  return {
    ...state,
    startSelection,
    updateSelection,
    finishSelection,
    cancelSelection,
    toggleInspectionLine,
    clearInspectionLine,
    reset,
  };
}
