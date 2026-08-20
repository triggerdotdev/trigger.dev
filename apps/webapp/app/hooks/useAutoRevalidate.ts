import { useRevalidator } from "@remix-run/react";
import { useEffect, useRef } from "react";

type UseAutoRevalidateOptions = {
  interval?: number; // in milliseconds
  onFocus?: boolean;
  disabled?: boolean;
};

export function useAutoRevalidate(options: UseAutoRevalidateOptions = {}) {
  const { interval = 5000, onFocus = true, disabled = false } = options;
  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  useEffect(() => {
    if (!interval || interval <= 0 || disabled) return;

    const intervalId = setInterval(() => {
      if (revalidatorRef.current.state === "loading") {
        return;
      }
      revalidatorRef.current.revalidate();
    }, interval);

    return () => clearInterval(intervalId);
  }, [interval, disabled]);

  useEffect(() => {
    if (!onFocus || disabled) return;

    const handleFocus = () => {
      if (document.visibilityState === "visible" && revalidatorRef.current.state !== "loading") {
        revalidatorRef.current.revalidate();
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

  return revalidator;
}
