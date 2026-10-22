import { useEffect, useRef, useState } from "react";

type ThrottleState = {
  lastBumpAt: number;
  trailing: ReturnType<typeof setTimeout> | null;
  hiddenChange: boolean;
};

const isHidden = () => document.visibilityState === "hidden";

function requestBump(state: ThrottleState, intervalMs: number, bump: () => void) {
  if (isHidden()) {
    state.hiddenChange = true;
    return;
  }
  const wait = state.lastBumpAt + intervalMs - Date.now();
  if (wait <= 0) {
    state.lastBumpAt = Date.now();
    bump();
    return;
  }
  if (state.trailing !== null) return;
  state.trailing = setTimeout(() => {
    state.trailing = null;
    requestBump(state, intervalMs, bump);
  }, wait);
}

/**
 * Returns a key that bumps when `signal` changes, at most once per `intervalMs` with one
 * trailing bump. Changes while the tab is hidden bump once when it's visible again.
 */
export function useThrottledRefresh(
  signal: unknown,
  { enabled, intervalMs }: { enabled: boolean; intervalMs: number }
): number {
  const [refreshKey, setRefreshKey] = useState(0);
  const stateRef = useRef<ThrottleState>({ lastBumpAt: 0, trailing: null, hiddenChange: false });
  const prevSignalRef = useRef(signal);

  useEffect(() => {
    const changed = prevSignalRef.current !== signal;
    prevSignalRef.current = signal;
    if (!enabled || !changed) return;
    requestBump(stateRef.current, intervalMs, () => setRefreshKey((key) => key + 1));
  }, [signal, enabled, intervalMs]);

  useEffect(() => {
    if (!enabled) return;
    const state = stateRef.current;
    const onVisibilityChange = () => {
      if (isHidden() || !state.hiddenChange) return;
      state.hiddenChange = false;
      requestBump(state, intervalMs, () => setRefreshKey((key) => key + 1));
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (state.trailing !== null) clearTimeout(state.trailing);
      state.trailing = null;
      state.hiddenChange = false;
    };
  }, [enabled, intervalMs]);

  return refreshKey;
}
