import type { ShouldRevalidateFunction } from "@remix-run/react";

/** Selects the span in the inspector, which loads from its own route. */
const SPAN_SEARCH_PARAM = "span";

function withoutSpanParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(SPAN_SEARCH_PARAM);
  params.sort();
  return params.toString();
}

/**
 * Skip the run loader when only the selected span changes.
 * Explicit revalidate() (unchanged URL) and every other param change still revalidate.
 */
export const shouldRevalidateRunPage: ShouldRevalidateFunction = ({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}) => {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname) {
    return defaultShouldRevalidate;
  }

  if (currentUrl.search === nextUrl.search) {
    return defaultShouldRevalidate;
  }

  if (withoutSpanParam(currentUrl.search) === withoutSpanParam(nextUrl.search)) {
    return false;
  }

  return defaultShouldRevalidate;
};
