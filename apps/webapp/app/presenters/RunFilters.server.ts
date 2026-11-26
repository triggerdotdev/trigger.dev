import { type TaskRunStatus } from "@trigger.dev/database";
import {
  getRunFiltersFromSearchParams,
  type IgnoredRunFilter,
  parseRunFiltersFromSearchParams,
  TaskRunListSearchFilters,
} from "~/components/runs/v3/RunFilters";
import { getRootOnlyFilterPreference } from "~/services/preferences/uiPreferences.server";
import { type ParsedRunFilters } from "~/services/runsRepository/runsRepository.server";

type FiltersFromRequest = ParsedRunFilters & Required<Pick<ParsedRunFilters, "rootOnly">>;

export async function getRunFiltersFromRequest(request: Request): Promise<FiltersFromRequest> {
  const url = new URL(request.url);
  let rootOnlyValue = false;
  if (url.searchParams.has("rootOnly")) {
    rootOnlyValue = url.searchParams.get("rootOnly") === "true";
  } else {
    rootOnlyValue = await getRootOnlyFilterPreference(request);
  }

  const s = getRunFiltersFromSearchParams(url.searchParams);

  const {
    tasks,
    versions,
    statuses,
    tags,
    period,
    bulkId,
    from,
    to,
    cursor,
    direction,
    runId,
    batchId,
    scheduleId,
    queues,
    regions,
    machines,
    errorId,
    sources,
  } = TaskRunListSearchFilters.parse(s);

  return {
    tasks,
    versions,
    statuses: statuses as TaskRunStatus[] | undefined,
    tags,
    period,
    bulkId,
    from,
    to,
    batchId,
    runId,
    scheduleId,
    rootOnly: rootOnlyValue,
    direction: direction,
    cursor: cursor,
    queues,
    regions,
    machines,
    errorId,
    sources,
    // The runs repository filters on `taskKinds`. Set here so everything built from the request
    // (the list, a bulk action's count and the bulk action itself) applies the source filter.
    taskKinds: sources,
  };
}

/**
 * The list filters for counting runs created after `since` (the runs list's "new runs" badge):
 * every filter on the request, with the period starting after `since`.
 */
export function newRunsFilters(
  filters: ParsedRunFilters,
  since: number
): Omit<ParsedRunFilters, "cursor" | "direction" | "sources"> {
  const { cursor: _cursor, direction: _direction, sources: _sources, ...rest } = filters;
  return { ...rest, from: Math.max(filters.from ?? 0, since + 1) };
}

/** URL filters on the request that couldn't be read and were left out of `getRunFiltersFromRequest`. */
export function getIgnoredRunFiltersFromRequest(request: Request): IgnoredRunFilter[] {
  return parseRunFiltersFromSearchParams(new URL(request.url).searchParams).ignored;
}
