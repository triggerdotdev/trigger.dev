import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { filterTitle, type IgnoredRunFilter, parseRunFiltersFromSearchParams } from "./RunFilters";

export function useIgnoredRunFilters(): IgnoredRunFilter[] {
  const location = useOptimisticLocation();
  return parseRunFiltersFromSearchParams(new URLSearchParams(location.search)).ignored;
}

export function ignoredRunFilterMessage({ key, value, reason }: IgnoredRunFilter) {
  return `${filterTitle(key)} "${value}" ${reason}`;
}
