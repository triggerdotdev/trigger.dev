import { useEffect, useRef } from "react";

/**
 * Whether a tick should fire, given the caller's `pauseWhenHidden` and the tab's current
 * visibility. Owns the default so there is one place it can be read or changed, and so a
 * test can pin it: defaulting this to false is what let a backgrounded tab poll itself
 * into a connection error.
 */
export function shouldRunIntervalTick(
  pauseWhenHidden: boolean | undefined,
  visibilityState: DocumentVisibilityState
): boolean {
  const paused = pauseWhenHidden ?? true;
  return !paused || visibilityState === "visible";
}

type UseIntervalOptions = {
  /** If passed, will refresh every interval MS */
  interval?: number;
  onLoad?: boolean;
  onFocus?: boolean;
  disabled?: boolean;
  /**
   * Skip interval ticks while the tab is hidden. Defaults to true, because a poller
   * nobody is looking at just accumulates chances to fail, and the focus handler below
   * already refreshes on return. Pass false only for work that genuinely cannot wait for
   * the tab to come back, and say why at the call site.
   */
  pauseWhenHidden?: boolean;
  callback: () => void;
};

export function useInterval({
  interval,
  onLoad = true,
  onFocus = true,
  disabled = false,
  pauseWhenHidden,
  callback,
}: UseIntervalOptions) {
  // Always keep the latest callback in a ref so the effects below
  // never close over a stale version.
  const latestCallback = useRef(callback);
  useEffect(() => {
    latestCallback.current = callback;
  }, [callback]);

  // On interval
  useEffect(() => {
    if (!interval || interval <= 0 || disabled) return;

    const intervalId = setInterval(() => {
      if (!shouldRunIntervalTick(pauseWhenHidden, document.visibilityState)) {
        return;
      }
      latestCallback.current();
    }, interval);

    return () => clearInterval(intervalId);
  }, [interval, disabled, pauseWhenHidden]);

  // On focus
  useEffect(() => {
    if (!onFocus || disabled) return;

    const handleFocus = () => {
      if (document.visibilityState === "visible") {
        latestCallback.current();
      }
    };

    // Revalidate when the page becomes visible
    document.addEventListener("visibilitychange", handleFocus);
    // Revalidate when the window gains focus
    window.addEventListener("focus", handleFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleFocus);
      window.removeEventListener("focus", handleFocus);
    };
  }, [onFocus, disabled]);

  // On load
  useEffect(() => {
    if (disabled || !onLoad) return;
    latestCallback.current();
  }, [disabled, onLoad]);
}
