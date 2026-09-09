import { useRevalidator } from "@remix-run/react";
import { useInterval } from "./useInterval";

type UseAutoRevalidateOptions = {
  interval?: number; // in milliseconds
  onFocus?: boolean;
  disabled?: boolean;
};

/**
 * Re-runs the current route's loaders on a timer.
 *
 * Ticks are skipped while the tab is hidden. A backgrounded tab has no one watching it,
 * and at the default interval it would otherwise spend a working day accumulating
 * thousands of chances to catch a dropped connection — each one fatal to the page.
 * Returning to the tab fires the focus handler, so the data is still fresh on arrival.
 */
export function useAutoRevalidate(options: UseAutoRevalidateOptions = {}) {
  const { interval = 5000, onFocus = true, disabled = false } = options;
  const revalidator = useRevalidator();

  useInterval({
    interval,
    onFocus,
    disabled,
    onLoad: false,
    callback: () => {
      if (revalidator.state === "loading") {
        return;
      }
      revalidator.revalidate();
    },
  });

  return revalidator;
}
