import { useEffect } from "react";

type UseIntervalOptions = {
  interval?: number; // in milliseconds
  onLoad?: boolean;
  onFocus?: boolean;
  disabled?: boolean;
  callback: () => void;
};

export function useInterval({
  interval = 60_000,
  onLoad = true,
  onFocus = true,
  disabled = false,
  callback,
}: UseIntervalOptions) {
  // On interval
  useEffect(() => {
    if (!interval || interval <= 0 || disabled) return;

    const intervalId = setInterval(() => {
      callback();
    }, interval);

    return () => clearInterval(intervalId);
  }, [interval, disabled]);

  // On focus
  useEffect(() => {
    if (!onFocus || disabled) return;

    const handleFocus = () => {
      if (document.visibilityState === "visible") {
        callback();
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
    if (disabled) return;
    callback();
  }, []);
}
