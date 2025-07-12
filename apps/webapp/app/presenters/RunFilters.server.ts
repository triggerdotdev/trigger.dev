import {
  getRunFiltersFromSearchParams,
  TaskRunListSearchFilters,
} from "~/components/runs/v3/RunFilters";
import { getRootOnlyFilterPreference } from "~/services/preferences/uiPreferences.server";

export async function getRunFiltersFromRequest(request: Request) {
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
  } = TaskRunListSearchFilters.parse(s);

  return {
    tasks,
    versions,
    statuses,
    tags,
    period,
    bulkId,
    from,
    to,
    batchId,
    runIds: runId ? [runId] : undefined,
    scheduleId,
    rootOnly: rootOnlyValue,
    direction: direction,
    cursor: cursor,
  };
}
