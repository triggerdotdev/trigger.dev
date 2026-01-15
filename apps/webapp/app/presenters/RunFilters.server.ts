import { type TaskRunStatus } from "@trigger.dev/database";
import {
  getRunFiltersFromSearchParams,
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
    machines,
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
    machines,
  };
}
