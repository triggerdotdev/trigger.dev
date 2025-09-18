import { useRevalidator } from "@remix-run/react";
import { useEffect } from "react";

type UseAutoRevalidateOptions = {
  interval?: number; // in milliseconds
  onFocus?: boolean;
};

export function useAutoRevalidate(options: UseAutoRevalidateOptions = {}) {
  const { interval = 5000, onFocus = true } = options;
  const revalidator = useRevalidator();

  useEffect(() => {
    if (!interval || interval <= 0) return;

    const intervalId = setInterval(() => {
      if (revalidator.state === "loading") {
        return;
      }
      revalidator.revalidate();
    }, interval);

    return () => clearInterval(intervalId);
  }, [interval]);

  useEffect(() => {
    if (!onFocus) return;

    const handleFocus = () => {
      if (document.visibilityState === "visible" && revalidator.state !== "loading") {
        revalidator.revalidate();
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
  }, [onFocus]);

  return revalidator;
}
