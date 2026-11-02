import type { ShouldRevalidateFunction } from "@remix-run/react";
import {
  SESSION_RUN_PARAM,
  SESSION_SPAN_PARAM,
  SESSION_SPAN_TAB_PARAM,
} from "~/components/sessions/v1/trace/sessionTraceSelection";

/** Params the page reads on the client only: the selection, the panel tabs and the left view. */
const CLIENT_ONLY_PARAMS = [
  SESSION_RUN_PARAM,
  SESSION_SPAN_PARAM,
  SESSION_SPAN_TAB_PARAM,
  "tab",
  "view",
];

function withoutClientOnlyParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const name of CLIENT_ONLY_PARAMS) params.delete(name);
  params.sort();
  return params.toString();
}

/**
 * Skip the session loader when only client-side params change.
 * Explicit revalidate() (unchanged URL) and every other param change still revalidate.
 */
export const shouldRevalidateSessionPage: ShouldRevalidateFunction = ({
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

  if (withoutClientOnlyParams(currentUrl.search) === withoutClientOnlyParams(nextUrl.search)) {
    return false;
  }

  return defaultShouldRevalidate;
};
