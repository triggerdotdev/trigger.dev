import { useEffect } from "react";

type UseIntervalOptions = {
  interval?: number; // in milliseconds
  onFocus?: boolean;
  disabled?: boolean;
  callback: () => void;
};

export function useInterval({
  interval = 60_000,
  onFocus = true,
  disabled = false,
  callback,
}: UseIntervalOptions) {
  useEffect(() => {
    if (!interval || interval <= 0 || disabled) return;

    const intervalId = setInterval(() => {
      callback();
    }, interval);

    return () => clearInterval(intervalId);
  }, [interval, disabled]);

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
}
