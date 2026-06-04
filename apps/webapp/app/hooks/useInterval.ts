import { useEffect, useRef } from "react";

type UseIntervalOptions = {
  /** If passed, will refresh every interval MS */
  interval?: number;
  onLoad?: boolean;
  onFocus?: boolean;
  disabled?: boolean;
  /** Skip interval ticks while the document tab is hidden */
  pauseWhenHidden?: boolean;
  callback: () => void;
};

export function useInterval({
  interval,
  onLoad = true,
  onFocus = true,
  disabled = false,
  pauseWhenHidden = false,
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
      if (pauseWhenHidden && document.visibilityState !== "visible") {
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
