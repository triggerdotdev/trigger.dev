import { useEffect, useState } from "react";

// setTimeout fires at once past this (~24 days).
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Whether `iso` is in the past; flips when it passes. Starts from the server's `serverNow`. */
export function useIsPast(iso: string | undefined, serverNow: number): boolean {
  const at = iso ? Date.parse(iso) : undefined;
  const [now, setNow] = useState(serverNow);
  // Re-arms while `now` is short of `at`: timers run on a different clock from Date.now() and can
  // fire a little early.
  useEffect(() => {
    if (at === undefined || at <= now) return;
    const remaining = at - Date.now();
    if (remaining > MAX_TIMEOUT_MS) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(remaining, 0));
    return () => clearTimeout(timer);
  }, [at, now]);
  return at !== undefined && at <= now;
}
