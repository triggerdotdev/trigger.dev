import { useCallback, useRef, useState } from "react";

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
  // Ref to track current state synchronously (needed for finishSelection)
  const stateRef = useRef<ZoomSelectionState>(state);

  // Keep ref in sync with state
  stateRef.current = state;

  const startSelection = useCallback((label: string) => {
    const next = {
      ...stateRef.current,
      refAreaLeft: label,
      refAreaRight: null,
      isSelecting: true,
      invalidSelection: false,
    };
    // Update ref synchronously first
    stateRef.current = next;
    setState(next);
  }, []);

  const updateSelection = useCallback(
    (label: string, data: any[], dataKey: string, minDataPoints = 3) => {
      const prev = stateRef.current;
      if (!prev.isSelecting || !prev.refAreaLeft) {
        return;
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

      const next = {
        ...prev,
        refAreaRight: label,
        invalidSelection,
      };
      // Update ref synchronously first
      stateRef.current = next;
      setState(next);
    },
    []
  );

  const finishSelection = useCallback(
    (data: any[], dataKey: string, minDataPoints = 3): ZoomRange | null => {
      // Get current state synchronously to calculate result
      const currentState = stateRef.current;

      if (!currentState.refAreaLeft || !currentState.refAreaRight) {
        const next = { ...initialState, inspectionLine: currentState.inspectionLine };
        stateRef.current = next;
        setState(next);
        return null;
      }

      const allLabels = data.map((item) => item[dataKey] as string).filter(Boolean);
      const leftIndex = allLabels.indexOf(currentState.refAreaLeft);
      const rightIndex = allLabels.indexOf(currentState.refAreaRight);

      let result: ZoomRange | null = null;

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

      // Reset the state (preserve inspection line)
      const next = { ...initialState, inspectionLine: currentState.inspectionLine };
      stateRef.current = next;
      setState(next);

      return result;
    },
    []
  );

  const cancelSelection = useCallback(() => {
    const next = {
      ...initialState,
      inspectionLine: stateRef.current.inspectionLine,
    };
    stateRef.current = next;
    setState(next);
  }, []);

  const toggleInspectionLine = useCallback((label: string) => {
    const prev = stateRef.current;
    const next = {
      ...prev,
      inspectionLine: prev.inspectionLine === label ? null : label,
    };
    stateRef.current = next;
    setState(next);
  }, []);

  const clearInspectionLine = useCallback(() => {
    const next = {
      ...stateRef.current,
      inspectionLine: null,
    };
    stateRef.current = next;
    setState(next);
  }, []);

  const reset = useCallback(() => {
    stateRef.current = initialState;
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
