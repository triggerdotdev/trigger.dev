import type { ShouldRevalidateFunction } from "@remix-run/react";

export const TIMEZONE_ACTION_PATH = "/resources/timezone";

/**
 * For routes whose loader reads a one-time flashed error from the session. A fetcher submission
 * re-runs every loader on the page, and the second run finds the flash already consumed, so the
 * error renders and then disappears. The timezone setter submits on a browser's first visit,
 * which is exactly when a magic link opened in a new browser lands on these pages.
 */
export const keepFlashedErrorOnTimezoneSave: ShouldRevalidateFunction = ({
  formAction,
  defaultShouldRevalidate,
}) => (formAction === TIMEZONE_ACTION_PATH ? false : defaultShouldRevalidate);
