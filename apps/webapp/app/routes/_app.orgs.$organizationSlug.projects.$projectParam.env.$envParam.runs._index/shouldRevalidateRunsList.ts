import type { Navigation, ShouldRevalidateFunction } from "@remix-run/react";

/** Search params that only control the bulk-action inspector UI, not list data. */
export const RUNS_BULK_INSPECTOR_UI_SEARCH_PARAMS = ["bulkInspector", "action", "mode"] as const;

/** URL value set on `bulkInspector` when the inspector panel is open (presence flag). */
export const RUNS_BULK_INSPECTOR_OPEN_VALUE = "show";

/** Returns a copy with bulk-inspector UI params removed. */
export function stripBulkInspectorUiParams(params: URLSearchParams): URLSearchParams {
  const stripped = new URLSearchParams(params);
  for (const key of RUNS_BULK_INSPECTOR_UI_SEARCH_PARAMS) {
    stripped.delete(key);
  }
  return stripped;
}

/** Canonical string for list-data params (UI keys stripped, entries sorted by key). */
export function canonicalRunsListDataSearchParams(params: URLSearchParams): string {
  const stripped = stripBulkInspectorUiParams(params);
  stripped.sort();
  return stripped.toString();
}

export function searchParamsEqualIgnoringBulkInspectorUiState(
  current: URLSearchParams,
  next: URLSearchParams
) {
  return canonicalRunsListDataSearchParams(current) === canonicalRunsListDataSearchParams(next);
}

/** True when navigation should show the runs table loading state (excludes bulk-inspector UI toggles). */
export function isRunsListLoading(navigation: Navigation, currentSearch: string): boolean {
  if (navigation.state === "idle" || !navigation.location) {
    return false;
  }

  const currentParams = new URLSearchParams(currentSearch);
  const nextParams = new URLSearchParams(navigation.location.search);

  if (searchParamsEqualIgnoringBulkInspectorUiState(currentParams, nextParams)) {
    return false;
  }

  return true;
}

/**
 * Skip runs list loader revalidation when only bulk-inspector UI params change.
 * Explicit revalidate() (unchanged URL) and filter/pagination changes still revalidate.
 */
export const shouldRevalidateRunsList: ShouldRevalidateFunction = ({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}) => {
  if (currentUrl.pathname !== nextUrl.pathname) {
    return defaultShouldRevalidate;
  }

  const currentParams = new URLSearchParams(currentUrl.search);
  const nextParams = new URLSearchParams(nextUrl.search);

  if (currentParams.toString() === nextParams.toString()) {
    return defaultShouldRevalidate;
  }

  if (searchParamsEqualIgnoringBulkInspectorUiState(currentParams, nextParams)) {
    return false;
  }

  return defaultShouldRevalidate;
};
